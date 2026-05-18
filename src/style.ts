import type { CssRule, CssStyle, HtmlElementNode, HtmlNode, StyledElement, StyledNode } from "./types.js";
import { parseStyleAttribute, ruleDeclarationsFor, type UnsupportedCssSink } from "./css.js";
import type { EdgesInput } from "boxpdf";

const blockTags = new Set([
  "address", "article", "aside", "blockquote", "body", "div", "dl", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main",
  "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);

export function computeStyles(
  root: HtmlElementNode,
  rules: CssRule[],
  base: CssStyle,
  containingWidth?: number,
  unsupportedCss?: UnsupportedCssSink
): StyledElement {
  return styleElement(root, rules, base, containingWidth, unsupportedCss);
}

function styleNode(
  node: HtmlNode,
  rules: CssRule[],
  inherited: CssStyle,
  containingWidth?: number,
  unsupportedCss?: UnsupportedCssSink,
  parentDisplay?: CssStyle["display"]
): StyledNode | undefined {
  if (node.kind === "text") {
    return { node, style: inherited, text: transformText(normalizeWhitespace(node.value, inherited.whiteSpace), inherited.textTransform) };
  }
  return styleElement(node, rules, inherited, containingWidth, unsupportedCss, parentDisplay);
}

function styleElement(
  node: HtmlElementNode,
  rules: CssRule[],
  inherited: CssStyle,
  containingWidth?: number,
  unsupportedCss?: UnsupportedCssSink,
  parentDisplay?: CssStyle["display"]
): StyledElement {
  const tagDefaults = defaultsForTag(node.tag, inherited);
  const ruleDeclarations = ruleDeclarationsFor(node, rules, tagDefaults.fontSize, tagDefaults.customProperties, unsupportedCss);
  const withRules = mergeStyles(tagDefaults, ruleDeclarations.declarations);
  const inlineDeclarations = parseStyleAttribute(node.attrs.style, withRules.fontSize, withRules.customProperties, unsupportedCss);
  const style = mergeStyles(
    withRules,
    inlineDeclarations.declarations,
    ruleDeclarations.importantDeclarations,
    inlineDeclarations.importantDeclarations
  );
  if (style.widthPercent !== undefined && containingWidth !== undefined) style.width = containingWidth * style.widthPercent;
  if (style.minWidthPercent !== undefined && containingWidth !== undefined) style.minWidth = containingWidth * style.minWidthPercent;
  if (style.maxWidthPercent !== undefined && containingWidth !== undefined) style.maxWidth = containingWidth * style.maxWidthPercent;
  if (style.widthCalc !== undefined && containingWidth !== undefined) style.width = containingWidth * style.widthCalc.percent + style.widthCalc.length;
  if (style.minWidthCalc !== undefined && containingWidth !== undefined) style.minWidth = containingWidth * style.minWidthCalc.percent + style.minWidthCalc.length;
  if (style.maxWidthCalc !== undefined && containingWidth !== undefined) style.maxWidth = containingWidth * style.maxWidthCalc.percent + style.maxWidthCalc.length;
  if (
    (style.display === "block" || style.display === "flex" || style.display === "grid") &&
    parentDisplay !== "flex" &&
    parentDisplay !== "grid" &&
    style.width === undefined &&
    containingWidth !== undefined
  ) {
    style.width = autoContentWidth(style, containingWidth);
  }
  if (node.tag === "img") {
    style.width ??= parseDimensionAttr(node.attrs.width);
    style.height ??= parseDimensionAttr(node.attrs.height);
  }
  if (style.width === undefined && containingWidth !== undefined && (style.minWidth !== undefined || style.maxWidth !== undefined)) {
    style.width = containingWidth;
  }
  if (style.width !== undefined) style.width = clamp(style.width, style.minWidth, style.maxWidth);
  applyAspectRatio(style);
  applyAutoMargins(style, containingWidth);
  if (style.lineHeightScale !== undefined) style.lineHeight = style.fontSize * style.lineHeightScale;
  const inheritedForChildren = inherit(style);
  const childContainingWidth =
    parentDisplay === "flex" && style.width === undefined ? undefined : contentWidthForChildren(style, containingWidth);
  const children = node.children
    .map((child) => styleNode(child, rules, inheritedForChildren, childContainingWidth, unsupportedCss, style.display))
    .filter((child): child is StyledNode => child !== undefined);
  return { node, style, children };
}

export function defaultStyle(fontSize = 12): CssStyle {
  return {
    display: "block",
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "start",
    fontSize,
    fontWeight: "normal",
    fontStyle: "normal",
    textAlign: "left",
    verticalAlign: "baseline",
    boxSizing: "content-box",
    whiteSpace: "normal"
  };
}

function defaultsForTag(tag: string, inherited: CssStyle): CssStyle {
  const style: CssStyle = {
    ...inherited,
    display: blockTags.has(tag) ? "block" : "inline",
    float: undefined,
    order: undefined,
    margin: undefined,
    marginAutoLeft: undefined,
    marginAutoRight: undefined,
    padding: undefined,
    background: undefined,
    backgroundImageUrl: undefined,
    backgroundSize: undefined,
    backgroundRepeat: undefined,
    backgroundPositionX: undefined,
    backgroundPositionY: undefined,
    objectFit: undefined,
    overflow: undefined,
    borderWidth: undefined,
    borderColor: undefined,
    borderSides: undefined,
    borderRadius: undefined,
    boxSizing: "content-box",
    width: undefined,
    widthPercent: undefined,
    widthCalc: undefined,
    minWidth: undefined,
    minWidthPercent: undefined,
    minWidthCalc: undefined,
    maxWidth: undefined,
    maxWidthPercent: undefined,
    maxWidthCalc: undefined,
    height: undefined,
    minHeight: undefined,
    maxHeight: undefined,
    aspectRatio: undefined,
    alignSelf: undefined,
    flexWrap: undefined,
    opacity: undefined,
    letterSpacing: undefined,
    position: undefined,
    top: undefined,
    right: undefined,
    bottom: undefined,
    left: undefined,
    zIndex: undefined,
    columnGap: undefined,
    rowGap: undefined,
    gridTemplateColumns: undefined,
    gridColumnStart: undefined,
    gridColumnEnd: undefined,
    gridColumnSpan: undefined
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
  if (tag === "img") style.display = "inline";
  if (tag === "pre") style.whiteSpace = "pre";
  if (tag === "br") style.display = "inline";
  return style;
}

function inherit(style: CssStyle): CssStyle {
  return {
    ...style,
    display: "inline",
    float: undefined,
    order: undefined,
    margin: undefined,
    marginAutoLeft: undefined,
    marginAutoRight: undefined,
    padding: undefined,
    background: undefined,
    backgroundImageUrl: undefined,
    backgroundSize: undefined,
    backgroundRepeat: undefined,
    backgroundPositionX: undefined,
    backgroundPositionY: undefined,
    objectFit: undefined,
    overflow: undefined,
    borderWidth: undefined,
    borderColor: undefined,
    borderSides: undefined,
    borderRadius: undefined,
    boxSizing: "content-box",
    width: undefined,
    widthPercent: undefined,
    widthCalc: undefined,
    minWidth: undefined,
    minWidthPercent: undefined,
    minWidthCalc: undefined,
    maxWidth: undefined,
    maxWidthPercent: undefined,
    maxWidthCalc: undefined,
    height: undefined,
    minHeight: undefined,
    maxHeight: undefined,
    aspectRatio: undefined,
    alignSelf: undefined,
    flexWrap: undefined,
    opacity: undefined,
    position: undefined,
    top: undefined,
    right: undefined,
    bottom: undefined,
    left: undefined,
    zIndex: undefined,
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "start",
    gap: undefined,
    columnGap: undefined,
    rowGap: undefined,
    gridTemplateColumns: undefined,
    gridColumnStart: undefined,
    gridColumnEnd: undefined,
    gridColumnSpan: undefined
  };
}

function applyAspectRatio(style: CssStyle): void {
  if (style.aspectRatio === undefined || style.aspectRatio <= 0) return;
  if (style.width !== undefined && style.height === undefined) style.height = style.width / style.aspectRatio;
  else if (style.height !== undefined && style.width === undefined) style.width = style.height * style.aspectRatio;
}

function parseDimensionAttr(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized) * 0.75;
  return undefined;
}

function mergeStyles(...styles: Array<Partial<CssStyle>>): CssStyle {
  const out: Partial<CssStyle> = {};
  for (const style of styles) {
    const borderSides = out.borderSides;
    Object.assign(out, style);
    if (style.borderSides) {
      out.borderSides = { ...borderSides, ...style.borderSides };
    }
  }
  return out as CssStyle;
}

function contentWidthForChildren(style: CssStyle, containingWidth: number | undefined): number | undefined {
  if (style.width !== undefined) return contentWidth(style);
  if (containingWidth === undefined) return undefined;
  const padding = edges(style.padding);
  const borders = borderWidths(style);
  return Math.max(0, containingWidth - padding.left - padding.right - borders.left - borders.right);
}

function autoContentWidth(style: CssStyle, containingWidth: number): number {
  if (style.boxSizing === "border-box") return containingWidth;
  const padding = edges(style.padding);
  const borders = borderWidths(style);
  return Math.max(0, containingWidth - padding.left - padding.right - borders.left - borders.right);
}

function applyAutoMargins(style: CssStyle, containingWidth: number | undefined): void {
  if (containingWidth === undefined || style.width === undefined || (!style.marginAutoLeft && !style.marginAutoRight)) return;
  const margin = edges(style.margin);
  const remaining = Math.max(0, containingWidth - outerWidth(style) + margin.left + margin.right);
  if (style.marginAutoLeft && style.marginAutoRight) {
    style.margin = { ...margin, left: remaining / 2, right: remaining / 2 };
  } else if (style.marginAutoLeft) {
    style.margin = { ...margin, left: remaining };
  } else if (style.marginAutoRight) {
    style.margin = { ...margin, right: remaining };
  }
}

function outerWidth(style: CssStyle): number {
  const margin = edges(style.margin);
  const padding = edges(style.padding);
  const borders = borderWidths(style);
  const box = style.boxSizing === "border-box" ? style.width ?? 0 : (style.width ?? 0) + padding.left + padding.right + borders.left + borders.right;
  return box + margin.left + margin.right;
}

function contentWidth(style: CssStyle): number {
  if (style.width === undefined || style.boxSizing !== "border-box") return style.width ?? 0;
  const padding = edges(style.padding);
  const borders = borderWidths(style);
  return Math.max(0, style.width - padding.left - padding.right - borders.left - borders.right);
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  if (min !== undefined) value = Math.max(value, min);
  if (max !== undefined) value = Math.min(value, max);
  return value;
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

function borderWidths(style: CssStyle): { top: number; right: number; bottom: number; left: number } {
  const all = style.borderWidth ?? 0;
  return {
    top: style.borderSides?.top?.width ?? all,
    right: style.borderSides?.right?.width ?? all,
    bottom: style.borderSides?.bottom?.width ?? all,
    left: style.borderSides?.left?.width ?? all
  };
}

function normalizeWhitespace(value: string, whiteSpace: CssStyle["whiteSpace"]): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (whiteSpace === "pre" || whiteSpace === "pre-wrap") return normalized;
  if (whiteSpace === "pre-line") return normalized.replace(/[^\S\n]+/g, " ");
  return normalized.replace(/\s+/g, " ");
}

function transformText(value: string, transform: CssStyle["textTransform"]): string {
  if (transform === "uppercase") return value.toUpperCase();
  if (transform === "lowercase") return value.toLowerCase();
  if (transform === "capitalize") {
    return value.replace(/\p{L}[\p{L}\p{N}'-]*/gu, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
  }
  return value;
}
