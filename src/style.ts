import type { CssRule, CssStyle, HtmlElementNode, HtmlNode, StyledElement, StyledNode } from "./types.js";
import { parseStyleAttribute, ruleDeclarationsFor } from "./css.js";

const blockTags = new Set([
  "address", "article", "aside", "blockquote", "body", "div", "dl", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main",
  "nav", "ol", "p", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);

export function computeStyles(root: HtmlElementNode, rules: CssRule[], base: CssStyle): StyledElement {
  return styleElement(root, rules, base);
}

function styleNode(node: HtmlNode, rules: CssRule[], inherited: CssStyle): StyledNode | undefined {
  if (node.kind === "text") {
    return { node, style: inherited, text: collapseWhitespace(node.value) };
  }
  return styleElement(node, rules, inherited);
}

function styleElement(node: HtmlElementNode, rules: CssRule[], inherited: CssStyle): StyledElement {
  const tagDefaults = defaultsForTag(node.tag, inherited);
  const withRules = { ...tagDefaults, ...ruleDeclarationsFor(node, rules) };
  const style = { ...withRules, ...parseStyleAttribute(node.attrs.style, withRules.fontSize) };
  const inheritedForChildren = inherit(style);
  const children = node.children
    .map((child) => styleNode(child, rules, inheritedForChildren))
    .filter((child): child is StyledNode => child !== undefined);
  return { node, style, children };
}

export function defaultStyle(fontSize = 12): CssStyle {
  return {
    display: "block",
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "start",
    fontSize,
    fontWeight: "normal",
    fontStyle: "normal",
    textAlign: "left",
    verticalAlign: "baseline"
  };
}

function defaultsForTag(tag: string, inherited: CssStyle): CssStyle {
  const style: CssStyle = {
    ...inherited,
    display: blockTags.has(tag) ? "block" : "inline",
    margin: undefined,
    padding: undefined,
    background: undefined,
    borderWidth: undefined,
    borderColor: undefined,
    width: undefined,
    height: undefined
  };
  if (tag === "strong" || tag === "b" || tag === "th") style.fontWeight = "bold";
  if (tag === "em" || tag === "i") style.fontStyle = "italic";
  if (tag === "h1") Object.assign(style, { fontSize: inherited.fontSize * 2, fontWeight: "bold", margin: 12 });
  if (tag === "h2") Object.assign(style, { fontSize: inherited.fontSize * 1.5, fontWeight: "bold", margin: 10 });
  if (tag === "h3") Object.assign(style, { fontSize: inherited.fontSize * 1.25, fontWeight: "bold", margin: 8 });
  if (tag === "p") style.margin = 6;
  if (tag === "br") style.display = "inline";
  return style;
}

function inherit(style: CssStyle): CssStyle {
  return {
    ...style,
    display: "inline",
    margin: undefined,
    padding: undefined,
    background: undefined,
    borderWidth: undefined,
    borderColor: undefined,
    width: undefined,
    height: undefined
  };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}
