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
}

export interface StreamDomStats {
  emittedRoots: number;
  maxOpenDepth: number;
  maxPendingRoots: number;
}

/**
 * Incrementally parse HTML and release completed root flow nodes. The visitor
 * is awaited between source chunks, providing backpressure without retaining
 * the complete document.
 */
export async function visitHtmlRoots(
  input: AsyncIterable<string | Uint8Array>,
  visit: (node: HtmlNode) => void | Promise<void>
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
    transparent: true
  };
  const stack: Frame[] = [root];
  const pending: HtmlNode[] = [];
  const stats: StreamDomStats = { emittedRoots: 0, maxOpenDepth: 0, maxPendingRoots: 0 };

  parser.on("startTag", (token: StartTag) => {
    const tag = token.tagName.toLowerCase();
    const parent = stack[stack.length - 1]!;
    const omitted = parent.omitted || OMITTED_TAGS.has(tag);
    const transparent = TRANSPARENT_DOCUMENT_TAGS.has(tag);
    const frame: Frame = { tag, children: [], omitted, transparent };
    if (!omitted && !transparent) {
      frame.node = {
        kind: "element",
        tag,
        attrs: Object.fromEntries(token.attrs.map((attr) => [attr.name, attr.value])),
        children: []
      };
    }
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
    appendText(frame.children, token.text);
  });

  parser.on("endTag", (token: EndTag) => {
    const tag = token.tagName.toLowerCase();
    const index = lastFrameIndex(stack, tag);
    if (index <= 0) return;
    while (stack.length - 1 >= index) {
      const frame = stack.pop()!;
      closeFrame(frame, stack[stack.length - 1]!, pending);
    }
  });

  for await (const chunk of input) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (text && !parser.write(text)) await once(parser, "drain");
    stats.maxPendingRoots = Math.max(stats.maxPendingRoots, pending.length);
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

function closeFrame(frame: Frame, parent: Frame, pending: HtmlNode[]): void {
  if (frame.omitted) return;
  if (frame.transparent) {
    for (const child of frame.children) appendChild(parent, child, pending);
    return;
  }
  const node = frame.node!;
  node.children = frame.children;
  for (const child of node.children) child.parent = node;
  appendChild(parent, node, pending);
}

function appendChild(parent: Frame, child: HtmlNode, pending: HtmlNode[]): void {
  if (parent.tag === "#root") {
    pending.push(...parent.children);
    parent.children = [];
    pending.push(child);
    return;
  }
  parent.children.push(child);
}

function appendText(children: HtmlNode[], value: string): void {
  if (!value) return;
  const previous = children[children.length - 1];
  if (previous?.kind === "text") {
    previous.value += value;
  } else {
    const text: HtmlTextNode = { kind: "text", value };
    children.push(text);
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
