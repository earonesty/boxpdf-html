import { generate, parse as parseCss, walk } from "css-tree";
import { parseColor } from "./color.js";
import { parseLength, parseLineHeight, parsePercentage } from "./units.js";
import type { CssRule, CssStyle, Display, HtmlElementNode } from "./types.js";
import type { Border, EdgesInput } from "boxpdf";

type CssNode = { type: string; [key: string]: unknown };
export type DeclarationSet = { declarations: Partial<CssStyle>; importantDeclarations: Partial<CssStyle> };

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
          declarations: declarations.declarations,
          importantDeclarations: declarations.importantDeclarations,
          specificity: specificity(selector),
          order: order++
        });
      }
    });
  }
  return rules;
}

export function parseStyleAttribute(value: string | undefined, fontSize: number): DeclarationSet {
  const declarations: DeclarationSet = { declarations: {}, importantDeclarations: {} };
  if (!value) return declarations;
  for (const chunk of value.split(";")) {
    const colon = chunk.indexOf(":");
    if (colon === -1) continue;
    const parsed = stripImportant(chunk.slice(colon + 1).trim());
    applyDeclaration(parsed.important ? declarations.importantDeclarations : declarations.declarations, chunk.slice(0, colon).trim(), parsed.value, fontSize);
  }
  return declarations;
}

export function ruleDeclarationsFor(node: HtmlElementNode, rules: CssRule[]): DeclarationSet {
  const out: DeclarationSet = { declarations: {}, importantDeclarations: {} };
  for (const rule of rules.filter((r) => matchesSelector(node, r.selector)).sort(compareRule)) {
    mergeDeclarations(out.declarations, rule.declarations);
    mergeDeclarations(out.importantDeclarations, rule.importantDeclarations);
  }
  return out;
}

function mergeDeclarations(target: Partial<CssStyle>, source: Partial<CssStyle>): void {
  const borderSides = target.borderSides;
  Object.assign(target, source);
  if (source.borderSides) {
    target.borderSides = { ...borderSides, ...source.borderSides };
  }
}

function declarationsFromBlock(block: CssNode, fontSize: number): DeclarationSet {
  const out: DeclarationSet = { declarations: {}, importantDeclarations: {} };
  const children = block.children as { forEach: (fn: (node: CssNode) => void) => void } | undefined;
  children?.forEach((node) => {
    if (node.type !== "Declaration") return;
    applyDeclaration(node.important ? out.importantDeclarations : out.declarations, String(node.property), generate(node.value), fontSize);
  });
  return out;
}

function stripImportant(value: string): { value: string; important: boolean } {
  if (!/!\s*important\s*$/i.test(value)) return { value, important: false };
  return { value: value.replace(/!\s*important\s*$/i, "").trim(), important: true };
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
    case "white-space":
      if (value === "normal" || value === "nowrap" || value === "pre" || value === "pre-wrap" || value === "pre-line") {
        out.whiteSpace = value;
      }
      break;
    case "text-align":
      if (value === "left" || value === "center" || value === "right") out.textAlign = value;
      break;
    case "text-decoration":
    case "text-decoration-line":
      out.textDecorationLine = parseTextDecoration(value);
      break;
    case "text-transform":
      if (value === "none" || value === "uppercase" || value === "lowercase" || value === "capitalize") {
        out.textTransform = value;
      }
      break;
    case "vertical-align":
      if (value === "middle" || value === "baseline") out.verticalAlign = value;
      break;
    case "box-sizing":
      if (value === "content-box" || value === "border-box") out.boxSizing = value;
      break;
    case "position":
      if (value === "relative" || value === "absolute") out.position = value;
      break;
    case "top":
    case "right":
    case "bottom":
    case "left":
      out[property as "top" | "right" | "bottom" | "left"] = parseLength(value, fontSize);
      break;
    case "z-index": {
      const zIndex = Number.parseInt(value, 10);
      if (Number.isFinite(zIndex)) out.zIndex = zIndex;
      break;
    }
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
    case "min-width":
      out.minWidthPercent = parsePercentage(value);
      out.minWidth = out.minWidthPercent === undefined ? parseLength(value, fontSize) : undefined;
      break;
    case "max-width":
      if (value === "none") {
        out.maxWidth = undefined;
        out.maxWidthPercent = undefined;
      } else {
        out.maxWidthPercent = parsePercentage(value);
        out.maxWidth = out.maxWidthPercent === undefined ? parseLength(value, fontSize) : undefined;
      }
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
    case "border-top":
    case "border-right":
    case "border-bottom":
    case "border-left":
      setBorderSide(out, property.slice("border-".length), parseBorderValue(value, fontSize));
      break;
    case "border-width":
      out.borderWidth = parseLength(value, fontSize);
      break;
    case "border-top-width":
    case "border-right-width":
    case "border-bottom-width":
    case "border-left-width":
      setBorderSide(out, borderSideFromProperty(property, "-width"), { width: parseLength(value, fontSize) });
      break;
    case "border-color":
      out.borderColor = parseColor(value);
      break;
    case "border-top-color":
    case "border-right-color":
    case "border-bottom-color":
    case "border-left-color":
      setBorderSide(out, borderSideFromProperty(property, "-color"), { color: parseColor(value) });
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
  const parsed = parseBorderValue(value, fontSize);
  out.borderWidth ??= parsed.width;
  out.borderColor ??= parsed.color;
}

function parseBorderValue(value: string, fontSize: number): Partial<Border> {
  const out: Partial<Border> = {};
  if (/\bnone\b/.test(value)) out.width = 0;
  for (const token of value.split(/\s+/)) {
    out.width ??= parseLength(token, fontSize);
    out.color ??= parseColor(token);
  }
  return out;
}

function setBorderSide(out: Partial<CssStyle>, side: string, value: Partial<Border>): void {
  if (side !== "top" && side !== "right" && side !== "bottom" && side !== "left") return;
  const current = out.borderSides?.[side];
  const width = value.width ?? current?.width ?? out.borderWidth ?? 0.75;
  const color = value.color ?? current?.color ?? out.borderColor ?? { r: 0, g: 0, b: 0 };
  out.borderSides = { ...out.borderSides, [side]: { width, color } };
}

function borderSideFromProperty(property: string, suffix: string): string {
  return property.slice("border-".length, -suffix.length);
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
  if (!matchesCompound(node, last.selector)) return false;
  last.node = node;

  let cursor: HtmlElementNode | undefined = node.parent;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const part = parts[i]!;
    const combinator = parts[i + 1]!.combinator;
    if (combinator === ">") {
      if (!cursor || !matchesCompound(cursor, part.selector)) return false;
      cursor = cursor.parent;
      continue;
    }
    if (combinator === "+") {
      const previous = previousElement(parts[i + 1]!.node ?? node);
      if (!previous || !matchesCompound(previous, part.selector)) return false;
      cursor = previous.parent;
      parts[i]!.node = previous;
      continue;
    }
    if (combinator === "~") {
      let sibling = previousElement(parts[i + 1]!.node ?? node);
      while (sibling && !matchesCompound(sibling, part.selector)) sibling = previousElement(sibling);
      if (!sibling) return false;
      cursor = sibling.parent;
      parts[i]!.node = sibling;
      continue;
    }
    while (cursor && !matchesCompound(cursor, part.selector)) cursor = cursor.parent;
    if (!cursor) return false;
    parts[i]!.node = cursor;
    cursor = cursor.parent;
  }
  return true;
}

function selectorParts(selector: string): Array<{ selector: string; combinator: " " | ">" | "+" | "~"; node?: HtmlElementNode }> {
  const parts: Array<{ selector: string; combinator: " " | ">" | "+" | "~" }> = [];
  let buffer = "";
  let combinator: " " | ">" | "+" | "~" = " ";
  let depth = 0;
  let quote = "";

  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed) parts.push({ selector: trimmed, combinator });
    buffer = "";
    combinator = " ";
  };

  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i]!;
    if (quote) {
      buffer += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
      continue;
    }
    if (char === "[" || char === "(") depth += 1;
    if (char === "]" || char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === ">" || char === "+" || char === "~")) {
      flush();
      combinator = char;
      continue;
    }
    if (depth === 0 && /\s/.test(char)) {
      let next = i + 1;
      while (next < selector.length && /\s/.test(selector[next]!)) next += 1;
      if (!buffer.trim() || selector[next] === ">" || selector[next] === "+" || selector[next] === "~") {
        i = next - 1;
        continue;
      }
      flush();
      i = next - 1;
      continue;
    }
    buffer += char;
  }
  flush();
  return parts;
}

function matchesCompound(node: HtmlElementNode, selector: string): boolean {
  const stripped = stripSupportedPseudos(selector, node);
  if (stripped === undefined) return false;
  selector = stripped;
  if (selector === "*") return true;
  if (!matchesAttributes(node, selector)) return false;
  selector = selector.replace(/\[[^\]]+\]/g, "");
  const id = /#([A-Za-z0-9_-]+)/.exec(selector)?.[1];
  if (id && node.attrs.id !== id) return false;
  const classes = [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  const nodeClasses = new Set((node.attrs.class ?? "").split(/\s+/).filter(Boolean));
  if (classes.some((klass) => !nodeClasses.has(klass))) return false;
  const tag = selector.replace(/[#.][A-Za-z0-9_-]+/g, "").trim();
  return tag.length === 0 || tag === "*" || tag.toLowerCase() === node.tag;
}

function specificity(selector: string): number {
  const ids = (selector.match(/#[A-Za-z0-9_-]+/g) ?? []).length;
  const classes =
    (selector.match(/\.[A-Za-z0-9_-]+/g) ?? []).length +
    (selector.match(/\[[^\]]+\]/g) ?? []).length +
    (selector.match(/:[A-Za-z-]+(?:\([^)]*\))?/g) ?? []).length;
  const tags = selectorParts(selector).filter((part) => /^[A-Za-z]/.test(part.selector.replace(/[#.:\[].*$/, ""))).length;
  return ids * 100 + classes * 10 + tags;
}

function stripSupportedPseudos(selector: string, node: HtmlElementNode): string | undefined {
  let out = selector;
  const pseudos = [...out.matchAll(/:([A-Za-z-]+)(?:\(([^)]*)\))?/g)];
  for (const match of pseudos) {
    const name = match[1]!;
    const arg = match[2]?.trim();
    if (name === "first-child") {
      if (elementIndex(node) !== 1) return undefined;
    } else if (name === "last-child") {
      if (elementIndex(node) !== elementSiblings(node).length) return undefined;
    } else if (name === "nth-child") {
      if (!matchesNth(elementIndex(node), arg)) return undefined;
    } else if (name === "first-of-type") {
      if (typeIndex(node) !== 1) return undefined;
    } else if (name === "last-of-type") {
      if (typeIndex(node) !== typeSiblings(node).length) return undefined;
    } else if (name === "nth-of-type") {
      if (!matchesNth(typeIndex(node), arg)) return undefined;
    } else {
      return undefined;
    }
    out = out.replace(match[0], "");
  }
  return out;
}

function matchesAttributes(node: HtmlElementNode, selector: string): boolean {
  for (const match of selector.matchAll(/\[([^\]=~|^$*\s]+)(?:\s*([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/g)) {
    const name = match[1]!;
    const op = match[2];
    const expected = match[3] ?? match[4] ?? match[5] ?? "";
    const actual = node.attrs[name];
    if (actual === undefined) return false;
    if (!op) continue;
    if (op === "=" && actual !== expected) return false;
    if (op === "~=" && !actual.split(/\s+/).includes(expected)) return false;
    if (op === "|=" && actual !== expected && !actual.startsWith(`${expected}-`)) return false;
    if (op === "^=" && !actual.startsWith(expected)) return false;
    if (op === "$=" && !actual.endsWith(expected)) return false;
    if (op === "*=" && !actual.includes(expected)) return false;
  }
  return true;
}

function previousElement(node: HtmlElementNode): HtmlElementNode | undefined {
  const siblings = elementSiblings(node);
  return siblings[elementIndex(node) - 2];
}

function elementSiblings(node: HtmlElementNode): HtmlElementNode[] {
  return node.parent?.children.filter((child): child is HtmlElementNode => child.kind === "element") ?? [];
}

function typeSiblings(node: HtmlElementNode): HtmlElementNode[] {
  return elementSiblings(node).filter((sibling) => sibling.tag === node.tag);
}

function elementIndex(node: HtmlElementNode): number {
  return elementSiblings(node).indexOf(node) + 1;
}

function typeIndex(node: HtmlElementNode): number {
  return typeSiblings(node).indexOf(node) + 1;
}

function matchesNth(index: number, arg: string | undefined): boolean {
  if (!arg) return false;
  const normalized = arg.replace(/\s+/g, "").toLowerCase();
  if (normalized === "odd") return index % 2 === 1;
  if (normalized === "even") return index % 2 === 0;
  const exact = Number(normalized);
  if (Number.isInteger(exact)) return index === exact;
  const match = /^([+-]?\d*)n([+-]\d+)?$/.exec(normalized);
  if (!match) return false;
  const aRaw = match[1]!;
  const a = aRaw === "" || aRaw === "+" ? 1 : aRaw === "-" ? -1 : Number(aRaw);
  const b = match[2] ? Number(match[2]) : 0;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return index === b;
  return (index - b) / a >= 0 && Number.isInteger((index - b) / a);
}

function compareRule(a: CssRule, b: CssRule): number {
  return a.specificity - b.specificity || a.order - b.order;
}
