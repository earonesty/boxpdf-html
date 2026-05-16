import { generate, parse as parseCss, walk } from "css-tree";
import { parseColor } from "./color.js";
import { parseLength, parseLineHeight, parsePercentage } from "./units.js";
import type { CssRule, CssStyle, Display, HtmlElementNode } from "./types.js";
import type { EdgesInput } from "boxpdf";

type CssNode = { type: string; [key: string]: unknown };

export function parseStylesheets(stylesheets: string[]): CssRule[] {
  let order = 0;
  const rules: CssRule[] = [];
  for (const css of stylesheets) {
    const ast = parseCss(css, { parseValue: false, parseCustomProperty: false }) as CssNode;
    walk(ast, (node: CssNode) => {
      if (node.type !== "Rule") return;
      const prelude = node.prelude as CssNode | undefined;
      const block = node.block as CssNode | undefined;
      if (!prelude || !block) return;
      const declarations = declarationsFromBlock(block, 16);
      for (const selector of selectorList(prelude)) {
        rules.push({
          selector,
          declarations,
          specificity: specificity(selector),
          order: order++
        });
      }
    });
  }
  return rules;
}

export function parseStyleAttribute(value: string | undefined, fontSize: number): Partial<CssStyle> {
  if (!value) return {};
  const declarations: Partial<CssStyle> = {};
  for (const chunk of value.split(";")) {
    const colon = chunk.indexOf(":");
    if (colon === -1) continue;
    applyDeclaration(declarations, chunk.slice(0, colon).trim(), chunk.slice(colon + 1).trim(), fontSize);
  }
  return declarations;
}

export function ruleDeclarationsFor(node: HtmlElementNode, rules: CssRule[]): Partial<CssStyle> {
  const out: Partial<CssStyle> = {};
  for (const rule of rules.filter((r) => matchesSelector(node, r.selector)).sort(compareRule)) {
    Object.assign(out, rule.declarations);
  }
  return out;
}

function declarationsFromBlock(block: CssNode, fontSize: number): Partial<CssStyle> {
  const out: Partial<CssStyle> = {};
  const children = block.children as { forEach: (fn: (node: CssNode) => void) => void } | undefined;
  children?.forEach((node) => {
    if (node.type !== "Declaration") return;
    applyDeclaration(out, String(node.property), generate(node.value), fontSize);
  });
  return out;
}

function applyDeclaration(out: Partial<CssStyle>, property: string, rawValue: string, fontSize: number): void {
  const value = rawValue.trim().toLowerCase();
  switch (property.trim().toLowerCase()) {
    case "display":
      if (["block", "inline", "inline-block", "flex", "none"].includes(value)) out.display = value as Display;
      break;
    case "flex-direction":
      if (value === "row" || value === "column") out.flexDirection = value;
      break;
    case "align-items":
      if (value === "flex-start") out.alignItems = "start";
      else if (value === "flex-end") out.alignItems = "end";
      else if (["start", "center", "end", "stretch", "baseline"].includes(value)) {
        out.alignItems = value as CssStyle["alignItems"];
      }
      break;
    case "justify-content":
      if (value === "flex-start") out.justifyContent = "start";
      else if (value === "flex-end") out.justifyContent = "end";
      else if (value === "space-between") out.justifyContent = "between";
      else if (value === "space-around") out.justifyContent = "around";
      else if (value === "space-evenly") out.justifyContent = "evenly";
      else if (["start", "center", "end"].includes(value)) out.justifyContent = value as CssStyle["justifyContent"];
      break;
    case "color":
      out.color = parseColor(value);
      break;
    case "background":
    case "background-color":
      out.background = parseColor(value);
      break;
    case "font-size":
      out.fontSize = parseLength(value, fontSize) ?? out.fontSize;
      break;
    case "font-family":
      out.fontFamily = parseFontFamily(rawValue);
      break;
    case "font-weight":
      out.fontWeight = parseFontWeight(value);
      break;
    case "font-style":
      out.fontStyle = value === "italic" ? "italic" : "normal";
      break;
    case "line-height":
      if (/^[0-9.]+$/.test(value)) out.lineHeightScale = Number(value);
      else out.lineHeight = parseLineHeight(value, fontSize);
      break;
    case "text-align":
      if (value === "left" || value === "center" || value === "right") out.textAlign = value;
      break;
    case "text-decoration":
    case "text-decoration-line":
      out.textDecorationLine = parseTextDecoration(value);
      break;
    case "vertical-align":
      if (value === "middle" || value === "baseline") out.verticalAlign = value;
      break;
    case "list-style":
    case "list-style-type":
      if (value.includes("none")) out.listStyleType = "none";
      else if (value.includes("decimal")) out.listStyleType = "decimal";
      else if (value.includes("disc")) out.listStyleType = "disc";
      break;
    case "width":
      out.widthPercent = parsePercentage(value);
      out.width = out.widthPercent === undefined ? parseLength(value, fontSize) : undefined;
      break;
    case "height":
      out.height = parseLength(value, fontSize);
      break;
    case "margin":
      out.margin = parseEdges(value, fontSize);
      break;
    case "margin-top":
    case "margin-right":
    case "margin-bottom":
    case "margin-left":
      out.margin = setEdge(out.margin, property.slice("margin-".length), parseLength(value, fontSize));
      break;
    case "padding":
      out.padding = parseEdges(value, fontSize);
      break;
    case "padding-top":
    case "padding-right":
    case "padding-bottom":
    case "padding-left":
      out.padding = setEdge(out.padding, property.slice("padding-".length), parseLength(value, fontSize));
      break;
    case "gap":
      out.gap = parseLength(value, fontSize);
      break;
    case "border":
      parseBorder(out, value, fontSize);
      break;
    case "border-width":
      out.borderWidth = parseLength(value, fontSize);
      break;
    case "border-color":
      out.borderColor = parseColor(value);
      break;
    case "border-radius":
      out.borderRadius = parseLength(value.split(/\s+/)[0], fontSize);
      break;
    case "border-collapse":
      if (value === "collapse" || value === "separate") out.borderCollapse = value;
      break;
  }
}

function parseTextDecoration(value: string): CssStyle["textDecorationLine"] | undefined {
  if (value === "none") return "none";
  if (value.includes("underline")) return "underline";
  if (value.includes("line-through")) return "line-through";
  return undefined;
}

function parseFontFamily(value: string): string[] {
  return value
    .split(",")
    .map((family) => family.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function parseFontWeight(value: string): CssStyle["fontWeight"] {
  if (value === "bold" || value === "bolder") return "bold";
  if (value === "normal" || value === "lighter") return "normal";
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return "normal";
}

function parseEdges(value: string, fontSize: number): EdgesInput | undefined {
  const lengths = value
    .split(/\s+/)
    .map((part) => parseLength(part, fontSize));
  if (lengths.some((length) => length === undefined)) return undefined;
  const [top, right = top, bottom = top, left = right] = lengths as number[];
  if (top === right && right === bottom && bottom === left) return top;
  return { top, right, bottom, left };
}

function setEdge(edges: EdgesInput | undefined, side: string, value: number | undefined): EdgesInput | undefined {
  if (value === undefined) return edges;
  const out = typeof edges === "number"
    ? { top: edges, right: edges, bottom: edges, left: edges }
    : { ...edges };
  if (side === "top" || side === "right" || side === "bottom" || side === "left") out[side] = value;
  return out;
}

function parseBorder(out: Partial<CssStyle>, value: string, fontSize: number): void {
  for (const token of value.split(/\s+/)) {
    out.borderWidth ??= parseLength(token, fontSize);
    out.borderColor ??= parseColor(token);
  }
}

function selectorList(prelude: CssNode): string[] {
  return generate(prelude)
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);
}

function matchesSelector(node: HtmlElementNode, selector: string): boolean {
  const parts = selectorParts(selector);
  if (parts.length === 0) return false;
  const last = parts[parts.length - 1]!;
  if (last.combinator === "unsupported" || !matchesCompound(node, last.selector)) return false;

  let cursor: HtmlElementNode | undefined = node.parent;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const part = parts[i]!;
    const combinator = parts[i + 1]!.combinator;
    if (combinator === "unsupported") return false;
    if (combinator === ">") {
      if (!cursor || !matchesCompound(cursor, part.selector)) return false;
      cursor = cursor.parent;
      continue;
    }
    while (cursor && !matchesCompound(cursor, part.selector)) cursor = cursor.parent;
    if (!cursor) return false;
    cursor = cursor.parent;
  }
  return true;
}

function selectorParts(selector: string): Array<{ selector: string; combinator: " " | ">" | "unsupported" }> {
  const tokens = selector.replace(/>/g, " > ").split(/\s+/).filter(Boolean);
  const parts: Array<{ selector: string; combinator: " " | ">" | "unsupported" }> = [];
  let nextCombinator: " " | ">" | "unsupported" = " ";
  for (const token of tokens) {
    if (token === ">") {
      nextCombinator = ">";
      continue;
    }
    if (token === "+" || token === "~") {
      nextCombinator = "unsupported";
      continue;
    }
    parts.push({ selector: token, combinator: nextCombinator });
    nextCombinator = " ";
  }
  return parts;
}

function matchesCompound(node: HtmlElementNode, selector: string): boolean {
  if (selector === "*") return true;
  const id = /#([A-Za-z0-9_-]+)/.exec(selector)?.[1];
  if (id && node.attrs.id !== id) return false;
  const classes = [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  const nodeClasses = new Set((node.attrs.class ?? "").split(/\s+/).filter(Boolean));
  if (classes.some((klass) => !nodeClasses.has(klass))) return false;
  const tag = selector.replace(/[#.][A-Za-z0-9_-]+/g, "").trim();
  return tag.length === 0 || tag.toLowerCase() === node.tag;
}

function specificity(selector: string): number {
  const ids = (selector.match(/#[A-Za-z0-9_-]+/g) ?? []).length;
  const classes = (selector.match(/\.[A-Za-z0-9_-]+/g) ?? []).length;
  const tags = selector.split(/\s+/).filter((part) => /^[A-Za-z]/.test(part)).length;
  return ids * 100 + classes * 10 + tags;
}

function compareRule(a: CssRule, b: CssRule): number {
  return a.specificity - b.specificity || a.order - b.order;
}
