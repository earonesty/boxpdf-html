import { once } from "node:events";
import { finished } from "node:stream/promises";
import { SAXParser, type EndTag, type StartTag, type Text } from "parse5-sax-parser";
import type { HtmlElementNode, HtmlNode, HtmlTextNode } from "../types.js";

const TRANSPARENT_DOCUMENT_TAGS = new Set(["html", "head", "body"]);
const OMITTED_TAGS = new Set(["style", "script", "noscript", "template", "title"]);
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr"
]);

interface Frame {
  tag: string;
  node?: HtmlElementNode;
  children: HtmlNode[];
  omitted: boolean;
  transparent: boolean;
  fragmentable: boolean;
  continuationId?: string;
  emittedFragments: number;
  bufferedNodes: number;
  trailingTextBytes: number;
}

export interface StreamDomStats {
  emittedRoots: number;
  maxOpenDepth: number;
  maxPendingRoots: number;
  maxBufferedNodes: number;
}

export interface VisitHtmlRootsOptions {
  /** Flush a fragment after this many completed children. Default 64. */
  fragmentChildren?: number;
  /** Select structurally fragmentable vertical containers. */
  canFragment?: (element: HtmlElementNode) => boolean;
  /** Maximum nodes retained across open atomic contexts. Default 100,000. */
  maxBufferedNodes?: number;
  /** Maximum UTF-8 bytes in one uninterrupted text node. Default 8 MiB. */
  maxTextBytes?: number;
}

const DEFAULT_FRAGMENTABLE_TAGS = new Set([
  "address", "article", "aside", "blockquote", "div", "fieldset", "footer",
  "form", "header", "main", "nav", "section", "table", "tbody"
]);
const P_CLOSING_START_TAGS = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol",
  "p", "pre", "search", "section", "table", "ul"
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Incrementally parse HTML and release completed root flow nodes. The visitor
 * is awaited between source chunks, providing backpressure without retaining
 * the complete document.
 */
export async function visitHtmlRoots(
  input: AsyncIterable<string | Uint8Array>,
  visit: (node: HtmlNode) => void | Promise<void>,
  options: VisitHtmlRootsOptions = {}
): Promise<StreamDomStats> {
  const parser = new SAXParser();
  // SAXParser passes source bytes through its readable side; drain them so
  // parsing remains backpressure-safe for inputs larger than its buffer.
  parser.resume();
  const decoder = new TextDecoder();
  const root: Frame = {
    tag: "#root",
    children: [],
    omitted: false,
    transparent: true,
    fragmentable: false,
    emittedFragments: 0,
    bufferedNodes: 0,
    trailingTextBytes: 0
  };
  const stack: Frame[] = [root];
  const pending: HtmlNode[] = [];
  const stats: StreamDomStats = {
    emittedRoots: 0,
    maxOpenDepth: 0,
    maxPendingRoots: 0,
    maxBufferedNodes: 0
  };
  const fragmentChildren = Math.max(1, options.fragmentChildren ?? 64);
  const maxBufferedNodes = Math.max(1, options.maxBufferedNodes ?? 100_000);
  const maxTextBytes = Math.max(1, options.maxTextBytes ?? 8 * 1024 * 1024);
  const canFragment = (element: HtmlElementNode): boolean =>
    DEFAULT_FRAGMENTABLE_TAGS.has(element.tag) &&
    (options.canFragment ? options.canFragment(element) : true);
  let continuationSequence = 0;

  const createFrame = (tag: string, attrs: Record<string, string> = {}): Frame => {
    const parent = stack[stack.length - 1]!;
    const omitted = parent.omitted || OMITTED_TAGS.has(tag);
    const transparent = TRANSPARENT_DOCUMENT_TAGS.has(tag);
    const frame: Frame = {
      tag,
      children: [],
      omitted,
      transparent,
      fragmentable: false,
      emittedFragments: 0,
      bufferedNodes: 0,
      trailingTextBytes: 0
    };
    if (!omitted && !transparent) {
      frame.node = { kind: "element", tag, attrs, children: [] };
      frame.fragmentable = canFragment(frame.node);
      if (frame.fragmentable) frame.continuationId = `html-${continuationSequence++}`;
    }
    return frame;
  };

  parser.on("startTag", (token: StartTag) => {
    const tag = token.tagName.toLowerCase();
    closeImpliedFrames(tag, stack, pending, fragmentChildren);
    insertTableContainers(tag, stack, createFrame, stats);
    const parent = stack[stack.length - 1]!;
    const frame = createFrame(
      tag,
      Object.fromEntries(token.attrs.map((attr) => [attr.name, attr.value]))
    );
    if (VOID_TAGS.has(tag) || token.selfClosing) {
      closeFrame(frame, parent, pending);
    } else {
      stack.push(frame);
      stats.maxOpenDepth = Math.max(stats.maxOpenDepth, stack.length - 1);
    }
  });

  parser.on("text", (token: Text) => {
    const frame = stack[stack.length - 1]!;
    if (frame.omitted) return;
    frame.trailingTextBytes += new TextEncoder().encode(token.text).byteLength;
    if (frame.trailingTextBytes > maxTextBytes) {
      throw new Error(
        `streaming HTML atomic text exceeded ${maxTextBytes} bytes; ` +
          "increase maxTextBytes or split the text into block elements"
      );
    }
    if (appendText(frame.children, token.text)) frame.bufferedNodes += 1;
  });

  parser.on("endTag", (token: EndTag) => {
    const tag = token.tagName.toLowerCase();
    const index = lastFrameIndex(stack, tag);
    if (index <= 0) return;
    while (stack.length - 1 >= index) {
      const frame = stack.pop()!;
      closeFrame(frame, stack[stack.length - 1]!, pending);
      flushReady(stack, pending, fragmentChildren);
    }
  });

  for await (const chunk of input) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (text && !parser.write(text)) await once(parser, "drain");
    flushReady(stack, pending, fragmentChildren);
    stats.maxPendingRoots = Math.max(stats.maxPendingRoots, pending.length);
    const retained = bufferedNodes(stack);
    stats.maxBufferedNodes = Math.max(stats.maxBufferedNodes, retained);
    if (retained > maxBufferedNodes) {
      throw new Error(
        `streaming HTML atomic layout exceeded ${maxBufferedNodes} buffered nodes; ` +
          "increase maxBufferedNodes or split the atomic layout"
      );
    }
    await drainPending(pending, visit, stats);
  }
  const tail = decoder.decode();
  if (tail) parser.write(tail);
  parser.end();
  await finished(parser);

  while (stack.length > 1) {
    const frame = stack.pop()!;
    closeFrame(frame, stack[stack.length - 1]!, pending);
  }
  pending.push(...root.children);
  root.children = [];
  root.bufferedNodes = 0;
  root.trailingTextBytes = 0;
  stats.maxPendingRoots = Math.max(stats.maxPendingRoots, pending.length);
  await drainPending(pending, visit, stats);
  return stats;
}

function lastFrameIndex(stack: Frame[], tag: string): number {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]!.tag === tag) return index;
  }
  return -1;
}

/**
 * Apply the common optional-end-tag rules that an HTML tree builder performs
 * but the SAX tokenizer intentionally does not.
 */
function closeImpliedFrames(
  startTag: string,
  stack: Frame[],
  pending: HtmlNode[],
  fragmentChildren: number
): void {
  if (P_CLOSING_START_TAGS.has(startTag)) {
    closeNearest(stack, new Set(["p"]), pending, fragmentChildren);
  }
  if (startTag === "li") {
    closeNearest(stack, new Set(["li"]), pending, fragmentChildren, new Set(["ul", "ol", "menu"]));
  } else if (startTag === "dt" || startTag === "dd") {
    closeNearest(stack, new Set(["dt", "dd"]), pending, fragmentChildren, new Set(["dl"]));
  } else if (startTag === "rt" || startTag === "rp") {
    closeNearest(stack, new Set(["rt", "rp"]), pending, fragmentChildren, new Set(["ruby"]));
  } else if (startTag === "option") {
    closeNearest(stack, new Set(["option"]), pending, fragmentChildren, new Set(["select", "datalist"]));
  } else if (startTag === "optgroup") {
    const selectScope = new Set(["select", "datalist"]);
    closeNearest(stack, new Set(["option"]), pending, fragmentChildren, selectScope);
    closeNearest(stack, new Set(["optgroup"]), pending, fragmentChildren, selectScope);
  } else if (startTag === "tr") {
    closeNearest(stack, new Set(["tr"]), pending, fragmentChildren, new Set(["table"]));
  } else if (startTag === "td" || startTag === "th") {
    closeNearest(stack, new Set(["td", "th"]), pending, fragmentChildren, new Set(["table"]));
  } else if (startTag === "thead" || startTag === "tbody" || startTag === "tfoot") {
    closeNearest(
      stack,
      new Set(["thead", "tbody", "tfoot"]),
      pending,
      fragmentChildren,
      new Set(["table"])
    );
  } else if (HEADING_TAGS.has(startTag)) {
    closeNearest(stack, HEADING_TAGS, pending, fragmentChildren);
  }
}

function closeNearest(
  stack: Frame[],
  tags: Set<string>,
  pending: HtmlNode[],
  fragmentChildren: number,
  scopeBoundaries: Set<string> = new Set()
): void {
  let index = -1;
  for (let cursor = stack.length - 1; cursor > 0; cursor -= 1) {
    if (tags.has(stack[cursor]!.tag)) {
      index = cursor;
      break;
    }
    if (scopeBoundaries.has(stack[cursor]!.tag)) break;
  }
  if (index < 1) return;
  while (stack.length - 1 >= index) {
    const frame = stack.pop()!;
    closeFrame(frame, stack[stack.length - 1]!, pending);
    flushReady(stack, pending, fragmentChildren);
  }
}

/** Insert the tbody/tr elements implied by common abbreviated table markup. */
function insertTableContainers(
  startTag: string,
  stack: Frame[],
  createFrame: (tag: string, attrs?: Record<string, string>) => Frame,
  stats: StreamDomStats
): void {
  let parent = stack[stack.length - 1]!;
  if ((startTag === "tr" || startTag === "td" || startTag === "th") && parent.tag === "table") {
    stack.push(createFrame("tbody"));
    stats.maxOpenDepth = Math.max(stats.maxOpenDepth, stack.length - 1);
    parent = stack[stack.length - 1]!;
  }
  if ((startTag === "td" || startTag === "th") && ["thead", "tbody", "tfoot"].includes(parent.tag)) {
    stack.push(createFrame("tr"));
    stats.maxOpenDepth = Math.max(stats.maxOpenDepth, stack.length - 1);
  }
}

function closeFrame(frame: Frame, parent: Frame, pending: HtmlNode[]): void {
  if (frame.omitted) return;
  if (frame.transparent) {
    for (const child of frame.children) appendChild(parent, child, pending);
    return;
  }
  const node = materializeFrame(frame, true);
  for (const child of node.children) child.parent = node;
  appendChild(parent, node, pending);
}

function materializeFrame(
  frame: Frame,
  final: boolean,
  childCount = frame.children.length
): HtmlElementNode {
  const children = frame.children.splice(0, childCount);
  const node: HtmlElementNode = {
    ...frame.node!,
    children
  };
  if (frame.fragmentable && (frame.emittedFragments > 0 || !final)) {
    node.streamContinuation = {
      id: frame.continuationId!,
      final,
      first: frame.emittedFragments === 0
    };
  }
  frame.bufferedNodes -= countNodes(children);
  if (frame.children.length === 0) frame.trailingTextBytes = 0;
  frame.emittedFragments += 1;
  return node;
}

function flushReady(stack: Frame[], pending: HtmlNode[], fragmentChildren: number): void {
  for (let index = stack.length - 1; index > 0; index -= 1) {
    const frame = stack[index]!;
    const hasContinuedChild = frame.children.some(
      (child) => child.kind === "element" && child.streamContinuation
    );
    const limit = frame.tag === "table" && hasContinuedChild ? 1 : fragmentChildren;
    if (!frame.fragmentable || frame.children.length <= limit) continue;
    const fragment = materializeFrame(frame, false, frame.children.length - 1);
    for (const child of fragment.children) child.parent = fragment;
    appendChild(stack[index - 1]!, fragment, pending);
  }
}

function appendChild(parent: Frame, child: HtmlNode, pending: HtmlNode[]): void {
  if (parent.tag === "#root") {
    pending.push(...parent.children);
    parent.children = [];
    parent.bufferedNodes = 0;
    parent.trailingTextBytes = 0;
    pending.push(child);
    return;
  }
  parent.children.push(child);
  parent.bufferedNodes += countNodes([child]);
  parent.trailingTextBytes = 0;
}

function appendText(children: HtmlNode[], value: string): boolean {
  if (!value) return false;
  const previous = children[children.length - 1];
  if (previous?.kind === "text") {
    previous.value += value;
    return false;
  } else {
    const text: HtmlTextNode = { kind: "text", value };
    children.push(text);
    return true;
  }
}

async function drainPending(
  pending: HtmlNode[],
  visit: (node: HtmlNode) => void | Promise<void>,
  stats: StreamDomStats
): Promise<void> {
  while (pending.length > 0) {
    await visit(pending.shift()!);
    stats.emittedRoots += 1;
  }
}

function bufferedNodes(stack: Frame[]): number {
  return stack.reduce((sum, frame) => sum + frame.bufferedNodes, 0);
}

function countNodes(nodes: HtmlNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.kind === "element") count += countNodes(node.children);
  }
  return count;
}
