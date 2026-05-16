import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import type { HtmlElementNode, HtmlNode, ParsedHtml } from "./types.js";

type ParseNode = DefaultTreeAdapterMap["node"];
type ParseElement = DefaultTreeAdapterMap["element"];
type ParseText = DefaultTreeAdapterMap["textNode"];

export function parseHtml(html: string): ParsedHtml {
  const fragment = parseFragment(html);
  const root: HtmlElementNode = {
    kind: "element",
    tag: "body",
    attrs: {},
    children: []
  };
  const stylesheets: string[] = [];
  root.children = fragment.childNodes.flatMap((child) => convertNode(child, root, stylesheets));
  return { root, stylesheets };
}

function convertNode(
  node: ParseNode,
  parent: HtmlElementNode,
  stylesheets: string[]
): HtmlNode[] {
  if (isText(node)) {
    return [{ kind: "text", value: node.value, parent }];
  }
  if (!isElement(node)) return [];

  const tag = node.tagName.toLowerCase();
  const attrs = Object.fromEntries(node.attrs.map((attr) => [attr.name, attr.value]));
  const element: HtmlElementNode = { kind: "element", tag, attrs, children: [], parent };
  element.children = node.childNodes.flatMap((child) => convertNode(child, element, stylesheets));

  if (tag === "style") {
    const css = element.children
      .filter((child) => child.kind === "text")
      .map((child) => child.value)
      .join("");
    if (css.trim()) stylesheets.push(css);
    return [];
  }
  if (tag === "script" || tag === "noscript" || tag === "template") return [];
  return [element];
}

function isText(node: ParseNode): node is ParseText {
  return node.nodeName === "#text";
}

function isElement(node: ParseNode): node is ParseElement {
  return "tagName" in node && Array.isArray(node.childNodes);
}
