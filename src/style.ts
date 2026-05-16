import type { CssRule, CssStyle, HtmlElementNode, HtmlNode, StyledElement, StyledNode } from "./types.js";
import { parseStyleAttribute, ruleDeclarationsFor } from "./css.js";
import type { EdgesInput } from "boxpdf";

const blockTags = new Set([
  "address", "article", "aside", "blockquote", "body", "div", "dl", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main",
  "nav", "ol", "p", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);

export function computeStyles(root: HtmlElementNode, rules: CssRule[], base: CssStyle, containingWidth?: number): StyledElement {
  return styleElement(root, rules, base, containingWidth);
}

function styleNode(node: HtmlNode, rules: CssRule[], inherited: CssStyle, containingWidth?: number): StyledNode | undefined {
  if (node.kind === "text") {
    return { node, style: inherited, text: transformText(collapseWhitespace(node.value), inherited.textTransform) };
  }
  return styleElement(node, rules, inherited, containingWidth);
}

function styleElement(node: HtmlElementNode, rules: CssRule[], inherited: CssStyle, containingWidth?: number): StyledElement {
  const tagDefaults = defaultsForTag(node.tag, inherited);
  const withRules = { ...tagDefaults, ...ruleDeclarationsFor(node, rules) };
  const style = { ...withRules, ...parseStyleAttribute(node.attrs.style, withRules.fontSize) };
  if (style.widthPercent !== undefined && containingWidth !== undefined) style.width = containingWidth * style.widthPercent;
  if (style.lineHeightScale !== undefined) style.lineHeight = style.fontSize * style.lineHeightScale;
  const inheritedForChildren = inherit(style);
  const childContainingWidth = contentWidthForChildren(style, containingWidth);
  const children = node.children
    .map((child) => styleNode(child, rules, inheritedForChildren, childContainingWidth))
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
    borderRadius: undefined,
    width: undefined,
    widthPercent: undefined,
    height: undefined
  };
  if (tag === "strong" || tag === "b" || tag === "th") style.fontWeight = "bold";
  if (tag === "em" || tag === "i") style.fontStyle = "italic";
  if (tag === "h1") {
    Object.assign(style, {
      fontSize: inherited.fontSize * 2,
      fontWeight: "bold",
      margin: { top: 0.67 * inherited.fontSize * 2, bottom: 0.67 * inherited.fontSize * 2 }
    });
  }
  if (tag === "h2") {
    Object.assign(style, {
      fontSize: inherited.fontSize * 1.5,
      fontWeight: "bold",
      margin: { top: 0.83 * inherited.fontSize * 1.5, bottom: 0.83 * inherited.fontSize * 1.5 }
    });
  }
  if (tag === "h3") {
    Object.assign(style, {
      fontSize: inherited.fontSize * 1.17,
      fontWeight: "bold",
      margin: { top: inherited.fontSize * 1.17, bottom: inherited.fontSize * 1.17 }
    });
  }
  if (tag === "p") style.margin = { top: inherited.fontSize, bottom: inherited.fontSize };
  if (tag === "ul" || tag === "ol") {
    style.margin = { top: inherited.fontSize, bottom: inherited.fontSize };
    style.padding = { left: inherited.fontSize * 2.5 };
    style.listStyleType = tag === "ol" ? "decimal" : "disc";
  }
  if (tag === "li") style.display = "block";
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
    borderRadius: undefined,
    width: undefined,
    widthPercent: undefined,
    height: undefined
  };
}

function contentWidthForChildren(style: CssStyle, containingWidth: number | undefined): number | undefined {
  if (style.width !== undefined) return style.width;
  if (containingWidth === undefined) return undefined;
  const padding = edges(style.padding);
  const borderWidth = style.borderWidth ?? 0;
  return Math.max(0, containingWidth - padding.left - padding.right - borderWidth * 2);
}

function edges(input: EdgesInput | undefined): { top: number; right: number; bottom: number; left: number } {
  if (input === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof input === "number") return { top: input, right: input, bottom: input, left: input };
  return {
    top: input.top ?? 0,
    right: input.right ?? 0,
    bottom: input.bottom ?? 0,
    left: input.left ?? 0
  };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

function transformText(value: string, transform: CssStyle["textTransform"]): string {
  if (transform === "uppercase") return value.toUpperCase();
  if (transform === "lowercase") return value.toLowerCase();
  if (transform === "capitalize") {
    return value.replace(/\p{L}[\p{L}\p{N}'-]*/gu, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
  }
  return value;
}
