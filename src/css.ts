import { generate, parse as parseCss, walk } from "css-tree";
import { parseColor } from "./color.js";
import { parseLength, parseLengthPercentage, parseLineHeight, parseLineHeightScale, parsePercentage } from "./units.js";
import type { CssDeclaration, CssRule, CssStyle, CssTransform, Display, GridTrack, HtmlElementNode } from "./types.js";
import type { Border, EdgesInput } from "boxpdf";

type CssNode = { type: string; [key: string]: unknown };
export type DeclarationSet = { declarations: Partial<CssStyle>; importantDeclarations: Partial<CssStyle> };
export type UnsupportedCssSink = (declaration: CssDeclaration) => void;

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
      const declarations = rawDeclarationsFromBlock(block);
      for (const selector of selectorList(prelude)) {
        rules.push({
          selector,
          declarations: declarations.declarations.map((declaration) => ({ ...declaration, selector })),
          importantDeclarations: declarations.importantDeclarations.map((declaration) => ({ ...declaration, selector })),
          specificity: specificity(selector),
          order: order++
        });
      }
    });
  }
  return rules;
}

export function parseStyleAttribute(
  value: string | undefined,
  fontSize: number,
  customProperties: Record<string, string> = {},
  unsupportedCss?: UnsupportedCssSink
): DeclarationSet {
  const declarations: DeclarationSet = { declarations: {}, importantDeclarations: {} };
  if (!value) return declarations;
  const raw = rawDeclarationsFromStyleAttribute(value);
  const vars = mergeCustomProperties(customProperties, raw.declarations, raw.importantDeclarations);
  parseDeclarationsInto(declarations.declarations, raw.declarations, fontSize, vars, unsupportedCss);
  parseDeclarationsInto(declarations.importantDeclarations, raw.importantDeclarations, fontSize, vars, unsupportedCss);
  return declarations;
}

export function ruleDeclarationsFor(
  node: HtmlElementNode,
  rules: CssRule[],
  fontSize: number,
  customProperties: Record<string, string> = {},
  unsupportedCss?: UnsupportedCssSink
): DeclarationSet {
  const out: DeclarationSet = { declarations: {}, importantDeclarations: {} };
  const declarations: CssDeclaration[] = [];
  const importantDeclarations: CssDeclaration[] = [];
  for (const rule of rules.filter((r) => matchesSelector(node, r.selector)).sort(compareRule)) {
    declarations.push(...rule.declarations);
    importantDeclarations.push(...rule.importantDeclarations);
  }
  const vars = mergeCustomProperties(customProperties, declarations, importantDeclarations);
  parseDeclarationsInto(out.declarations, declarations, fontSize, vars, unsupportedCss);
  parseDeclarationsInto(out.importantDeclarations, importantDeclarations, fontSize, vars, unsupportedCss);
  return out;
}

function mergeDeclarations(target: Partial<CssStyle>, source: Partial<CssStyle>): void {
  const borderSides = target.borderSides;
  Object.assign(target, source);
  if (source.borderSides) {
    target.borderSides = { ...borderSides, ...source.borderSides };
  }
}

function rawDeclarationsFromBlock(block: CssNode): { declarations: CssDeclaration[]; importantDeclarations: CssDeclaration[] } {
  const out: { declarations: CssDeclaration[]; importantDeclarations: CssDeclaration[] } = { declarations: [], importantDeclarations: [] };
  const children = block.children as { forEach: (fn: (node: CssNode) => void) => void } | undefined;
  children?.forEach((node) => {
    if (node.type !== "Declaration") return;
    const target = node.important ? out.importantDeclarations : out.declarations;
    target.push({ property: String(node.property), value: generate(node.value) });
  });
  return out;
}

function rawDeclarationsFromStyleAttribute(value: string): { declarations: CssDeclaration[]; importantDeclarations: CssDeclaration[] } {
  const out: { declarations: CssDeclaration[]; importantDeclarations: CssDeclaration[] } = { declarations: [], importantDeclarations: [] };
  for (const chunk of value.split(";")) {
    const colon = chunk.indexOf(":");
    if (colon === -1) continue;
    const parsed = stripImportant(chunk.slice(colon + 1).trim());
    const target = parsed.important ? out.importantDeclarations : out.declarations;
    target.push({ property: chunk.slice(0, colon).trim(), value: parsed.value });
  }
  return out;
}

function parseDeclarationsInto(
  out: Partial<CssStyle>,
  declarations: CssDeclaration[],
  fontSize: number,
  customProperties: Record<string, string>,
  unsupportedCss?: UnsupportedCssSink
): void {
  const vars = customPropertiesFrom(declarations, customProperties);
  for (const declaration of declarations) {
    const property = declaration.property.trim();
    if (property.startsWith("--")) continue;
    if (!isSupportedCssProperty(property)) {
      if (shouldReportUnsupportedCss(declaration)) unsupportedCss?.(declaration);
      continue;
    }
    applyDeclaration(out, property, resolveVars(declaration.value, vars), fontSize);
  }
  if (Object.keys(vars).length > 0) out.customProperties = vars;
}

function shouldReportUnsupportedCss(declaration: CssDeclaration): boolean {
  return declaration.selector === undefined || declaration.selector.includes(".");
}

const supportedCssProperties = new Set([
  "display", "float", "order", "flex-direction", "align-items", "justify-content",
  "color", "background", "background-color", "background-image", "background-size", "background-repeat", "background-position",
  "object-fit", "overflow", "overflow-x", "overflow-y",
  "font-size", "font", "font-family", "font-weight", "font-style", "line-height",
  "white-space", "text-align", "text-decoration", "text-decoration-line", "text-transform", "text-indent", "vertical-align",
  "box-sizing", "position", "top", "right", "bottom", "left", "inset", "inset-block", "inset-inline", "inset-block-start", "inset-block-end", "inset-inline-start", "inset-inline-end",
  "z-index", "list-style", "list-style-type",
  "width", "min-width", "max-width", "height", "min-height", "max-height", "aspect-ratio",
  "align-self", "flex-wrap", "opacity", "rotate", "translate", "scale", "transform", "transform-origin", "letter-spacing",
  "margin", "margin-block", "margin-inline", "margin-block-start", "margin-block-end", "margin-inline-start", "margin-inline-end", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-block", "padding-inline", "padding-block-start", "padding-block-end", "padding-inline-start", "padding-inline-end", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "gap", "column-gap", "grid-column-gap", "row-gap", "grid-row-gap",
  "grid-template-columns", "grid-column", "grid-column-start", "grid-column-end",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-block", "border-inline", "border-block-start", "border-block-end", "border-inline-start", "border-inline-end",
  "border-style", "border-top-style", "border-right-style", "border-bottom-style", "border-left-style", "border-block-start-style", "border-block-end-style", "border-inline-start-style", "border-inline-end-style",
  "border-width", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-block-start-width", "border-block-end-width", "border-inline-start-width", "border-inline-end-width",
  "border-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-block-start-color", "border-block-end-color", "border-inline-start-color", "border-inline-end-color",
  "border-radius", "border-collapse"
]);

function isSupportedCssProperty(property: string): boolean {
  return supportedCssProperties.has(property.trim().toLowerCase());
}

function mergeCustomProperties(
  inherited: Record<string, string>,
  declarations: CssDeclaration[],
  importantDeclarations: CssDeclaration[]
): Record<string, string> {
  return customPropertiesFrom(importantDeclarations, customPropertiesFrom(declarations, inherited));
}

function customPropertiesFrom(declarations: CssDeclaration[], inherited: Record<string, string>): Record<string, string> {
  let out = inherited;
  for (const declaration of declarations) {
    const property = declaration.property.trim();
    if (!property.startsWith("--")) continue;
    if (out === inherited) out = { ...inherited };
    out[property] = declaration.value.trim();
  }
  return out;
}

function resolveVars(value: string, customProperties: Record<string, string>, seen = new Set<string>()): string {
  let out = "";
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf("var(", index);
    if (start === -1) {
      out += value.slice(index);
      break;
    }
    out += value.slice(index, start);
    const end = closingParenIndex(value, start + 4);
    if (end === -1) {
      out += value.slice(start);
      break;
    }
    out += resolveVarFunction(value.slice(start + 4, end), customProperties, seen);
    index = end + 1;
  }
  return out;
}

function resolveVarFunction(args: string, customProperties: Record<string, string>, seen: Set<string>): string {
  const comma = topLevelCommaIndex(args);
  const name = (comma === -1 ? args : args.slice(0, comma)).trim();
  if (!/^--[A-Za-z0-9_-]+$/.test(name)) return "";
  const fallback = comma === -1 ? undefined : args.slice(comma + 1).trim();
  if (seen.has(name)) return fallback ? resolveVars(fallback, customProperties, seen) : "";
  const replacement = customProperties[name];
  if (replacement === undefined) return fallback ? resolveVars(fallback, customProperties, seen) : "";
  const nextSeen = new Set(seen);
  nextSeen.add(name);
  return resolveVars(replacement, customProperties, nextSeen);
}

function closingParenIndex(value: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    if (char === ")") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

function topLevelCommaIndex(value: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) return index;
  }
  return -1;
}

function stripImportant(value: string): { value: string; important: boolean } {
  if (!/!\s*important\s*$/i.test(value)) return { value, important: false };
  return { value: value.replace(/!\s*important\s*$/i, "").trim(), important: true };
}

function applyDeclaration(out: Partial<CssStyle>, property: string, rawValue: string, fontSize: number): void {
  const value = rawValue.trim().toLowerCase();
  switch (property.trim().toLowerCase()) {
    case "display":
      if (value === "flow-root" || value === "list-item") out.display = "block";
      else if (["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "contents", "none"].includes(value)) {
        out.display = value as Display;
      }
      break;
    case "float":
      if (value === "none" || value === "left" || value === "right") out.float = value;
      break;
    case "order": {
      const order = Number.parseInt(value, 10);
      if (Number.isFinite(order)) out.order = order;
      break;
    }
    case "flex-direction":
      if (value === "row" || value === "row-reverse" || value === "column" || value === "column-reverse") out.flexDirection = value;
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
      parseBackground(out, rawValue);
      break;
    case "background-color":
      out.background = parseColor(value);
      break;
    case "background-image":
      out.backgroundImageUrl = parseBackgroundImageUrl(rawValue);
      break;
    case "background-size":
      if (value === "auto" || value === "cover" || value === "contain") out.backgroundSize = value;
      break;
    case "background-repeat":
      if (value === "repeat" || value === "repeat-x" || value === "repeat-y" || value === "no-repeat") out.backgroundRepeat = value;
      break;
    case "background-position":
      parseBackgroundPosition(out, value);
      break;
    case "object-fit":
      if (value === "fill" || value === "contain" || value === "cover") out.objectFit = value;
      break;
    case "overflow":
    case "overflow-x":
    case "overflow-y":
      if (value === "hidden" || value === "clip") out.overflow = "hidden";
      else if (value === "visible") out.overflow = "visible";
      break;
    case "font-size":
      out.fontSize = parseLength(value, fontSize) ?? out.fontSize;
      break;
    case "font":
      parseFontShorthand(out, rawValue, fontSize);
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
      {
        const scale = parseLineHeightScale(value);
        if (scale !== undefined) {
          out.lineHeightScale = scale;
          out.lineHeight = undefined;
        } else {
          out.lineHeight = parseLineHeight(value, fontSize);
          out.lineHeightScale = undefined;
        }
      }
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
    case "text-indent":
      out.textIndent = parseLength(value, fontSize);
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
    case "inset":
      applyInset(out, value, fontSize);
      break;
    case "inset-block":
      applyTwoValueInset(out, "top", "bottom", value, fontSize);
      break;
    case "inset-inline":
      applyTwoValueInset(out, "left", "right", value, fontSize);
      break;
    case "inset-block-start":
      out.top = parseLength(value, fontSize);
      break;
    case "inset-block-end":
      out.bottom = parseLength(value, fontSize);
      break;
    case "inset-inline-start":
      out.left = parseLength(value, fontSize);
      break;
    case "inset-inline-end":
      out.right = parseLength(value, fontSize);
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
      setLengthPercentage(out, "width", value, fontSize);
      break;
    case "min-width":
      setLengthPercentage(out, "minWidth", value, fontSize);
      break;
    case "max-width":
      if (value === "none") {
        out.maxWidth = undefined;
        out.maxWidthPercent = undefined;
        out.maxWidthCalc = undefined;
      } else {
        setLengthPercentage(out, "maxWidth", value, fontSize);
      }
      break;
    case "height":
      out.height = parseLength(value, fontSize);
      break;
    case "min-height":
      out.minHeight = parseLength(value, fontSize);
      break;
    case "max-height":
      out.maxHeight = parseLength(value, fontSize);
      break;
    case "align-self":
      if (value === "flex-start") out.alignSelf = "start";
      else if (value === "flex-end") out.alignSelf = "end";
      else if (["start", "center", "end", "stretch", "baseline"].includes(value)) {
        out.alignSelf = value as CssStyle["alignSelf"];
      }
      break;
    case "flex-wrap":
      if (value === "wrap") out.flexWrap = "wrap";
      else if (value === "nowrap") out.flexWrap = "nowrap";
      break;
    case "opacity": {
      const n = Number(value);
      if (Number.isFinite(n)) out.opacity = Math.max(0, Math.min(1, n));
      break;
    }
    case "rotate":
      out.rotate = value === "none" ? undefined : parseAngle(value);
      break;
    case "translate":
      out.translate = value === "none" ? undefined : parseTranslate(value, fontSize);
      break;
    case "scale":
      out.scale = value === "none" ? undefined : parseScale(value);
      break;
    case "transform":
      out.transform = value === "none" ? undefined : parseTransformList(rawValue, fontSize);
      break;
    case "transform-origin":
      out.transformOrigin = parseTransformOrigin(value, fontSize);
      break;
    case "letter-spacing":
      if (value !== "normal") out.letterSpacing = parseLength(value, fontSize);
      break;
    case "aspect-ratio":
      out.aspectRatio = parseAspectRatio(value);
      break;
    case "margin":
      applyMargin(out, value, fontSize);
      break;
    case "margin-block":
      applyTwoValueEdges(out, "margin", "top", "bottom", value, fontSize);
      break;
    case "margin-inline":
      applyTwoValueMargin(out, "left", "right", value, fontSize);
      break;
    case "margin-block-start":
      out.margin = setEdge(out.margin, "top", parseLength(value, fontSize));
      break;
    case "margin-block-end":
      out.margin = setEdge(out.margin, "bottom", parseLength(value, fontSize));
      break;
    case "margin-inline-start":
      setMarginEdge(out, "left", value, fontSize);
      break;
    case "margin-inline-end":
      setMarginEdge(out, "right", value, fontSize);
      break;
    case "margin-top":
    case "margin-right":
    case "margin-bottom":
    case "margin-left":
      setMarginEdge(out, property.slice("margin-".length) as "top" | "right" | "bottom" | "left", value, fontSize);
      break;
    case "padding":
      out.padding = parseEdges(value, fontSize);
      break;
    case "padding-block":
      applyTwoValueEdges(out, "padding", "top", "bottom", value, fontSize);
      break;
    case "padding-inline":
      applyTwoValueEdges(out, "padding", "left", "right", value, fontSize);
      break;
    case "padding-block-start":
      out.padding = setEdge(out.padding, "top", parseLength(value, fontSize));
      break;
    case "padding-block-end":
      out.padding = setEdge(out.padding, "bottom", parseLength(value, fontSize));
      break;
    case "padding-inline-start":
      out.padding = setEdge(out.padding, "left", parseLength(value, fontSize));
      break;
    case "padding-inline-end":
      out.padding = setEdge(out.padding, "right", parseLength(value, fontSize));
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
    case "column-gap":
    case "grid-column-gap":
      out.columnGap = parseLength(value, fontSize);
      break;
    case "row-gap":
    case "grid-row-gap":
      out.rowGap = parseLength(value, fontSize);
      break;
    case "grid-template-columns":
      out.gridTemplateColumns = parseGridTemplateColumns(value, fontSize);
      break;
    case "grid-column":
      parseGridColumn(out, value);
      break;
    case "grid-column-start":
      parseGridColumnLine(out, "gridColumnStart", value);
      break;
    case "grid-column-end":
      parseGridColumnLine(out, "gridColumnEnd", value);
      break;
    case "border":
      parseBorder(out, value, fontSize);
      break;
    case "border-style":
    case "border-top-style":
    case "border-right-style":
    case "border-bottom-style":
    case "border-left-style":
    case "border-block-start-style":
    case "border-block-end-style":
    case "border-inline-start-style":
    case "border-inline-end-style":
      break;
    case "border-top":
    case "border-right":
    case "border-bottom":
    case "border-left":
      setBorderSide(out, property.slice("border-".length), parseBorderValue(value, fontSize));
      break;
    case "border-block":
      setBorderSide(out, "top", parseBorderValue(value, fontSize));
      setBorderSide(out, "bottom", parseBorderValue(value, fontSize));
      break;
    case "border-inline":
      setBorderSide(out, "left", parseBorderValue(value, fontSize));
      setBorderSide(out, "right", parseBorderValue(value, fontSize));
      break;
    case "border-block-start":
      setBorderSide(out, "top", parseBorderValue(value, fontSize));
      break;
    case "border-block-end":
      setBorderSide(out, "bottom", parseBorderValue(value, fontSize));
      break;
    case "border-inline-start":
      setBorderSide(out, "left", parseBorderValue(value, fontSize));
      break;
    case "border-inline-end":
      setBorderSide(out, "right", parseBorderValue(value, fontSize));
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
    case "border-block-start-width":
      setBorderSide(out, "top", { width: parseLength(value, fontSize) });
      break;
    case "border-block-end-width":
      setBorderSide(out, "bottom", { width: parseLength(value, fontSize) });
      break;
    case "border-inline-start-width":
      setBorderSide(out, "left", { width: parseLength(value, fontSize) });
      break;
    case "border-inline-end-width":
      setBorderSide(out, "right", { width: parseLength(value, fontSize) });
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
    case "border-block-start-color":
      setBorderSide(out, "top", { color: parseColor(value) });
      break;
    case "border-block-end-color":
      setBorderSide(out, "bottom", { color: parseColor(value) });
      break;
    case "border-inline-start-color":
      setBorderSide(out, "left", { color: parseColor(value) });
      break;
    case "border-inline-end-color":
      setBorderSide(out, "right", { color: parseColor(value) });
      break;
    case "border-radius":
      out.borderRadius = parseLength(value.split(/\s+/)[0], fontSize);
      break;
    case "border-collapse":
      if (value === "collapse" || value === "separate") out.borderCollapse = value;
      break;
  }
}

function parseAngle(value: string): number | undefined {
  if (value.trim() === "0") return 0;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  switch (match[2]?.toLowerCase()) {
    case "grad":
      return amount * 0.9;
    case "rad":
      return (amount * 180) / Math.PI;
    case "turn":
      return amount * 360;
    default:
      return amount;
  }
}

function parseTransformList(value: string, fontSize: number): CssTransform[] | undefined {
  const transforms: CssTransform[] = [];
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    const nameMatch = /^([a-z][a-z0-9]*)\s*\(/i.exec(value.slice(index));
    if (!nameMatch) return undefined;
    const name = (nameMatch[1] ?? "").toLowerCase();
    const open = index + (nameMatch[0]?.lastIndexOf("(") ?? -1);
    const end = closingParenIndex(value, open + 1);
    if (end === -1) return undefined;
    const transform = parseTransformFunction(name, value.slice(open + 1, end), fontSize);
    if (!transform) return undefined;
    transforms.push(transform);
    index = end + 1;
  }
  return transforms.length > 0 ? transforms : undefined;
}

function parseTransformFunction(name: string, rawArgs: string, fontSize: number): CssTransform | undefined {
  const args = splitTransformArgs(rawArgs);
  if (name === "translate" || name === "translatex" || name === "translatey") {
    if (args.length < 1 || args.length > 2 || (name !== "translate" && args.length !== 1)) return undefined;
    const zero = { length: 0, percent: 0 };
    const first = parseLengthPercentage(args[0], fontSize);
    if (!first) return undefined;
    if (name === "translatex") return { kind: "translate", x: first, y: zero };
    if (name === "translatey") return { kind: "translate", x: zero, y: first };
    const second = args[1] ? parseLengthPercentage(args[1], fontSize) : zero;
    return second ? { kind: "translate", x: first, y: second } : undefined;
  }
  if (name === "scale" || name === "scalex" || name === "scaley") {
    if (args.length < 1 || args.length > 2 || (name !== "scale" && args.length !== 1)) return undefined;
    const first = parseScaleFactor(args[0]);
    if (first === undefined) return undefined;
    if (name === "scalex") return { kind: "scale", x: first, y: 1 };
    if (name === "scaley") return { kind: "scale", x: 1, y: first };
    const second = args[1] === undefined ? first : parseScaleFactor(args[1]);
    return second === undefined ? undefined : { kind: "scale", x: first, y: second };
  }
  if (name === "rotate" || name === "rotatez") {
    if (args.length !== 1) return undefined;
    const degrees = parseAngle(args[0] ?? "");
    return degrees === undefined ? undefined : { kind: "rotate", degrees };
  }
  if (name === "skew" || name === "skewx" || name === "skewy") {
    if (args.length < 1 || args.length > 2 || (name !== "skew" && args.length !== 1)) return undefined;
    const first = parseAngle(args[0] ?? "");
    if (first === undefined) return undefined;
    if (name === "skewx") return { kind: "skew", xDegrees: first, yDegrees: 0 };
    if (name === "skewy") return { kind: "skew", xDegrees: 0, yDegrees: first };
    const second = args[1] === undefined ? 0 : parseAngle(args[1]);
    return second === undefined ? undefined : { kind: "skew", xDegrees: first, yDegrees: second };
  }
  if (name === "matrix") {
    if (args.length !== 6) return undefined;
    const values = args.map(Number);
    if (!values.every(Number.isFinite)) return undefined;
    return {
      kind: "matrix",
      a: values[0]!,
      b: values[1]!,
      c: values[2]!,
      d: values[3]!,
      e: values[4]! * 0.75,
      f: values[5]! * 0.75
    };
  }
  return undefined;
}

function parseTranslate(value: string, fontSize: number): CssStyle["translate"] {
  const args = splitTransformArgs(value);
  if (args.length < 1 || args.length > 2) return undefined;
  const x = parseLengthPercentage(args[0], fontSize);
  const y = args[1] === undefined ? { length: 0, percent: 0 } : parseLengthPercentage(args[1], fontSize);
  return x && y ? { x, y } : undefined;
}

function parseScale(value: string): CssStyle["scale"] {
  const args = splitTransformArgs(value);
  if (args.length < 1 || args.length > 2) return undefined;
  const x = parseScaleFactor(args[0]);
  const y = args[1] === undefined ? x : parseScaleFactor(args[1]);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function parseScaleFactor(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const percent = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(value.trim());
  const number = percent ? Number(percent[1]) / 100 : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseTransformOrigin(value: string, fontSize: number): CssStyle["transformOrigin"] {
  const args = splitTransformArgs(value);
  if (args.length < 1 || args.length > 2) return undefined;
  let [first, second] = args;
  if (args.length === 1 && (first === "top" || first === "bottom")) {
    second = first;
    first = "center";
  } else {
    second ??= "center";
  }
  if ((first === "top" || first === "bottom") && (second === "left" || second === "right" || second === "center")) {
    [first, second] = [second, first];
  }
  const x = parseOriginComponent(first, "x", fontSize);
  const y = parseOriginComponent(second, "y", fontSize);
  return x && y ? { x, y } : undefined;
}

function parseOriginComponent(value: string | undefined, axis: "x" | "y", fontSize: number) {
  if (!value || value === "center") return { length: 0, percent: 0.5 };
  if ((axis === "x" && value === "left") || (axis === "y" && value === "top")) return { length: 0, percent: 0 };
  if ((axis === "x" && value === "right") || (axis === "y" && value === "bottom")) return { length: 0, percent: 1 };
  return parseLengthPercentage(value, fontSize);
}

function splitTransformArgs(value: string): string[] {
  const commaParts = splitTopLevel(value, ",");
  if (commaParts.length > 1) return commaParts.map((part) => part.trim()).filter(Boolean);
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if ((char === undefined || (depth === 0 && /\s/.test(char))) && index > start) {
      parts.push(value.slice(start, index).trim());
      while (/\s/.test(value[index + 1] ?? "")) index += 1;
      start = index + 1;
    }
  }
  return parts.filter(Boolean);
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === delimiter && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function parseAspectRatio(value: string): number | undefined {
  const normalized = value.replace(/\bauto\b/g, "").trim();
  if (!normalized) return undefined;
  const slash = /^([0-9.]+)\s*\/\s*([0-9.]+)$/.exec(normalized);
  if (slash) {
    const width = Number(slash[1]);
    const height = Number(slash[2]);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : undefined;
  }
  const ratio = Number(normalized);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
}

function setLengthPercentage(out: Partial<CssStyle>, property: "width" | "minWidth" | "maxWidth", value: string, fontSize: number): void {
  const parsed = parseLengthPercentage(value, fontSize);
  const percentKey = `${property}Percent` as "widthPercent" | "minWidthPercent" | "maxWidthPercent";
  const calcKey = `${property}Calc` as "widthCalc" | "minWidthCalc" | "maxWidthCalc";
  out[property] = undefined;
  out[percentKey] = undefined;
  out[calcKey] = undefined;
  if (!parsed) return;
  if (parsed.percent !== 0 && parsed.length !== 0) out[calcKey] = parsed;
  else if (parsed.percent !== 0) out[percentKey] = parsed.percent;
  else out[property] = parsed.length;
}

function applyInset(out: Partial<CssStyle>, value: string, fontSize: number): void {
  const lengths = cssValueTokens(value).map((part) => parseLength(part, fontSize));
  if (lengths.some((length) => length === undefined)) return;
  const [top, right = top, bottom = top, left = right] = lengths as number[];
  out.top = top;
  out.right = right;
  out.bottom = bottom;
  out.left = left;
}

function applyTwoValueInset(
  out: Partial<CssStyle>,
  firstSide: "top" | "right" | "bottom" | "left",
  secondSide: "top" | "right" | "bottom" | "left",
  value: string,
  fontSize: number
): void {
  const [firstRaw, secondRaw = firstRaw] = cssValueTokens(value);
  const first = parseLength(firstRaw, fontSize);
  const second = parseLength(secondRaw, fontSize);
  if (first !== undefined) out[firstSide] = first;
  if (second !== undefined) out[secondSide] = second;
}

function applyTwoValueEdges(
  out: Partial<CssStyle>,
  property: "margin" | "padding",
  firstSide: "top" | "right" | "bottom" | "left",
  secondSide: "top" | "right" | "bottom" | "left",
  value: string,
  fontSize: number
): void {
  const [firstRaw, secondRaw = firstRaw] = cssValueTokens(value);
  out[property] = setEdge(out[property], firstSide, parseLength(firstRaw, fontSize));
  out[property] = setEdge(out[property], secondSide, parseLength(secondRaw, fontSize));
}

function applyMargin(out: Partial<CssStyle>, value: string, fontSize: number): void {
  const [topRaw, rightRaw = topRaw, bottomRaw = topRaw, leftRaw = rightRaw] = cssValueTokens(value);
  setMarginEdge(out, "top", topRaw, fontSize);
  setMarginEdge(out, "right", rightRaw, fontSize);
  setMarginEdge(out, "bottom", bottomRaw, fontSize);
  setMarginEdge(out, "left", leftRaw, fontSize);
}

function applyTwoValueMargin(
  out: Partial<CssStyle>,
  firstSide: "top" | "right" | "bottom" | "left",
  secondSide: "top" | "right" | "bottom" | "left",
  value: string,
  fontSize: number
): void {
  const [firstRaw, secondRaw = firstRaw] = cssValueTokens(value);
  setMarginEdge(out, firstSide, firstRaw, fontSize);
  setMarginEdge(out, secondSide, secondRaw, fontSize);
}

function setMarginEdge(out: Partial<CssStyle>, side: "top" | "right" | "bottom" | "left", value: string | undefined, fontSize: number): void {
  if (value === undefined) return;
  if (value === "auto" && (side === "left" || side === "right")) {
    out.margin = setEdge(out.margin, side, 0);
    if (side === "left") out.marginAutoLeft = true;
    else out.marginAutoRight = true;
    return;
  }
  const parsed = parseLength(value, fontSize);
  out.margin = setEdge(out.margin, side, parsed);
  if (parsed !== undefined) {
    if (side === "left") out.marginAutoLeft = undefined;
    if (side === "right") out.marginAutoRight = undefined;
  }
}

function parseGridColumn(out: Partial<CssStyle>, value: string): void {
  const [startRaw, endRaw] = value.split("/").map((part) => part.trim().toLowerCase());
  if (startRaw) parseGridColumnLine(out, "gridColumnStart", startRaw);
  if (endRaw) parseGridColumnLine(out, "gridColumnEnd", endRaw);
  else if (startRaw?.startsWith("span ")) parseGridColumnLine(out, "gridColumnEnd", startRaw);
}

function parseGridColumnLine(out: Partial<CssStyle>, property: "gridColumnStart" | "gridColumnEnd", value: string): void {
  const normalized = value.trim().toLowerCase();
  const span = /^span\s+(\d+)$/.exec(normalized);
  if (span) {
    const amount = Number(span[1]);
    if (Number.isInteger(amount) && amount > 0) out.gridColumnSpan = amount;
    return;
  }
  const line = Number.parseInt(normalized, 10);
  if (!Number.isInteger(line)) return;
  out[property] = line;
}

function parseGridTemplateColumns(value: string, fontSize: number): GridTrack[] | undefined {
  const expanded = expandGridRepeats(value);
  const tracks = gridTrackTokens(expanded).map((token): GridTrack | undefined => {
    if (token === "auto" || token === "min-content" || token === "max-content") return { kind: "fr", value: 1 };
    const fr = /^([0-9.]+)fr$/.exec(token);
    if (fr) {
      const amount = Number(fr[1]);
      return Number.isFinite(amount) && amount > 0 ? { kind: "fr", value: amount } : undefined;
    }
    const percent = parsePercentage(token);
    if (percent !== undefined) return { kind: "percent", value: percent };
    const minmax = /^minmax\([^,]+,\s*([^)]+)\)$/.exec(token);
    if (minmax) return parseGridTemplateColumns(minmax[1]!, fontSize)?.[0];
    const length = parseLength(token, fontSize);
    return length === undefined ? undefined : { kind: "length", value: length };
  });
  if (tracks.length === 0 || tracks.some((track) => track === undefined)) return undefined;
  return tracks as GridTrack[];
}

function expandGridRepeats(value: string): string {
  let out = "";
  let index = 0;
  while (index < value.length) {
    const repeatStart = value.toLowerCase().indexOf("repeat(", index);
    if (repeatStart === -1) {
      out += value.slice(index);
      break;
    }
    out += value.slice(index, repeatStart);
    const argsStart = repeatStart + "repeat(".length;
    const close = closingParenIndex(value, argsStart);
    if (close === -1) {
      out += value.slice(repeatStart);
      break;
    }
    const args = value.slice(argsStart, close);
    const comma = topLevelCommaIndex(args);
    const count = Number(comma === -1 ? NaN : args.slice(0, comma).trim());
    const repeated = comma === -1 ? "" : args.slice(comma + 1).trim();
    out += Number.isInteger(count) && count > 0 && count <= 24
      ? Array.from({ length: count }, () => repeated).join(" ")
      : "";
    index = close + 1;
  }
  return out;
}

function gridTrackTokens(value: string): string[] {
  return cssValueTokens(value).map((token) => token.toLowerCase());
}

function cssValueTokens(value: string): string[] {
  return cssValueTokensPreservingCase(value).map((token) => token.toLowerCase());
}

function cssValueTokensPreservingCase(value: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let depth = 0;
  for (const char of value.trim()) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(char) && depth === 0) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function parseTextDecoration(value: string): CssStyle["textDecorationLine"] | undefined {
  if (value === "none") return "none";
  if (value.includes("underline")) return "underline";
  if (value.includes("line-through")) return "line-through";
  return undefined;
}

function parseBackground(out: Partial<CssStyle>, value: string): void {
  out.background = parseBackgroundColor(value) ?? out.background;
  out.backgroundImageUrl = parseBackgroundImageUrl(value) ?? out.backgroundImageUrl;
  const lower = value.toLowerCase();
  if (/\bcover\b/.test(lower)) out.backgroundSize = "cover";
  else if (/\bcontain\b/.test(lower)) out.backgroundSize = "contain";
  if (/\bno-repeat\b/.test(lower)) out.backgroundRepeat = "no-repeat";
  else if (/\brepeat-x\b/.test(lower)) out.backgroundRepeat = "repeat-x";
  else if (/\brepeat-y\b/.test(lower)) out.backgroundRepeat = "repeat-y";
  else if (/\brepeat\b/.test(lower)) out.backgroundRepeat = "repeat";
  parseBackgroundPosition(out, lower.replace(/\/\s*(cover|contain|auto)\b/g, ""));
}

function parseBackgroundColor(value: string): CssStyle["background"] | undefined {
  const withoutUrls = value.replace(/url\([^)]*\)/gi, " ");
  const tokens = withoutUrls.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+/g) ?? [];
  for (const token of tokens) {
    const color = parseColor(token);
    if (color) return color;
  }
  return undefined;
}

function parseBackgroundImageUrl(value: string): string | undefined {
  const match = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*?))\s*\)/i.exec(value);
  return match ? (match[1] ?? match[2] ?? match[3])?.trim() : undefined;
}

function parseBackgroundPosition(out: Partial<CssStyle>, value: string): void {
  const tokens = value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !["url", "repeat", "repeat-x", "repeat-y", "no-repeat", "cover", "contain", "auto"].includes(token));
  const normalized = tokens.join(" ");
  if (!normalized) return;
  if (/\bleft\b/.test(normalized)) out.backgroundPositionX = 0;
  else if (/\bright\b/.test(normalized)) out.backgroundPositionX = 1;
  else if (/\bcenter\b/.test(normalized)) out.backgroundPositionX = 0.5;
  const percentX = /(^|\s)([0-9.]+)%/.exec(normalized);
  if (percentX) out.backgroundPositionX = Number(percentX[2]) / 100;
  if (/\btop\b/.test(normalized)) out.backgroundPositionY = 0;
  else if (/\bbottom\b/.test(normalized)) out.backgroundPositionY = 1;
  else if (/\bcenter\b/.test(normalized)) out.backgroundPositionY ??= 0.5;
  const percents = [...normalized.matchAll(/([0-9.]+)%/g)];
  if (percents[1]) out.backgroundPositionY = Number(percents[1][1]) / 100;
}

function parseFontFamily(value: string): string[] {
  return value
    .split(",")
    .map((family) => family.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function parseFontShorthand(out: Partial<CssStyle>, value: string, inheritedFontSize: number): void {
  const tokens = cssValueTokensPreservingCase(value);
  const sizeIndex = tokens.findIndex((token) => {
    const [size] = token.split("/");
    return isFontSizeToken(size) && parseLength(size, inheritedFontSize) !== undefined;
  });
  if (sizeIndex < 0) return;

  for (const token of tokens.slice(0, sizeIndex)) {
    const normalized = token.toLowerCase();
    if (normalized === "italic" || normalized === "oblique") out.fontStyle = "italic";
    else if (normalized === "normal") {
      out.fontStyle ??= "normal";
      out.fontWeight ??= "normal";
    } else if (normalized === "bold" || normalized === "bolder" || normalized === "lighter" || /^[1-9]00$/.test(normalized)) {
      out.fontWeight = parseFontWeight(normalized);
    }
  }

  const [sizePart, lineHeightPart] = tokens[sizeIndex]!.split("/");
  const parsedSize = parseLength(sizePart, inheritedFontSize);
  if (parsedSize !== undefined) out.fontSize = parsedSize;
  if (lineHeightPart) out.lineHeight = parseLineHeight(lineHeightPart, parsedSize ?? inheritedFontSize);

  const family = tokens.slice(sizeIndex + 1).join(" ");
  if (family.trim()) out.fontFamily = parseFontFamily(family);
}

function isFontSizeToken(value: string | undefined): boolean {
  return value !== undefined && /^-?(?:\d+|\d*\.\d+)(px|pt|em|rem|vw|vh)$/i.test(value.trim());
}

function parseFontWeight(value: string): CssStyle["fontWeight"] {
  if (value === "bold" || value === "bolder") return "bold";
  if (value === "normal" || value === "lighter") return "normal";
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return "normal";
}

function parseEdges(value: string, fontSize: number): EdgesInput | undefined {
  const lengths = cssValueTokens(value).map((part) => parseLength(part, fontSize));
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
  for (const token of cssValueTokens(value)) {
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
    .map((selector) => stripWhereSelectors(selector.trim()))
    .filter(Boolean);
}

function stripWhereSelectors(selector: string): string {
  let out = "";
  let index = 0;
  while (index < selector.length) {
    const start = selector.indexOf(":where(", index);
    if (start === -1) {
      out += selector.slice(index);
      break;
    }
    out += selector.slice(index, start);
    const argsStart = start + ":where(".length;
    const close = closingParenIndex(selector, argsStart);
    if (close === -1) {
      out += selector.slice(start);
      break;
    }
    out += selector.slice(argsStart, close);
    index = close + 1;
  }
  return out;
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
  if (!matchesAttributes(node, stripSimpleSelectors(selector))) return false;
  const id = simpleSelectorValues(selector, "#")[0];
  if (id && node.attrs.id !== id) return false;
  const classes = simpleSelectorValues(selector, ".");
  const nodeClasses = new Set((node.attrs.class ?? "").split(/\s+/).filter(Boolean));
  if (classes.some((klass) => !nodeClasses.has(klass))) return false;
  const tag = stripSimpleSelectors(selector).replace(/\[[^\]]+\]/g, "").trim();
  return tag.length === 0 || tag === "*" || tag.toLowerCase() === node.tag;
}

function specificity(selector: string): number {
  const ids = selectorParts(selector).reduce((sum, part) => sum + simpleSelectorValues(part.selector, "#").length, 0);
  const classes =
    selectorParts(selector).reduce((sum, part) => sum + simpleSelectorValues(part.selector, ".").length, 0) +
    (selector.match(/\[[^\]]+\]/g) ?? []).length +
    pseudoSelectors(selector).length;
  const tags = selectorParts(selector).filter((part) => /^[A-Za-z]/.test(part.selector.replace(/[#.:\[].*$/, ""))).length;
  return ids * 100 + classes * 10 + tags;
}

function stripSupportedPseudos(selector: string, node: HtmlElementNode): string | undefined {
  let out = selector;
  const pseudos = pseudoSelectors(out).reverse();
  for (const match of pseudos) {
    const name = match.name;
    const arg = match.arg?.trim();
    if (name === "first-child") {
      if (elementIndex(node) !== 1) return undefined;
    } else if (name === "not") {
      if (arg === ":last-child" && elementIndex(node) === elementSiblings(node).length) return undefined;
      else if (arg === ":first-child" && elementIndex(node) === 1) return undefined;
      else if (arg !== ":last-child" && arg !== ":first-child") return undefined;
    } else if (name === "root") {
      if (node.parent !== undefined) return undefined;
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
    out = out.slice(0, match.start) + out.slice(match.end);
  }
  return out;
}

function simpleSelectorValues(selector: string, prefix: "." | "#"): string[] {
  const values: string[] = [];
  for (let index = 0; index < selector.length; index += 1) {
    if (selector[index] !== prefix || isEscaped(selector, index)) continue;
    const read = readCssIdentifier(selector, index + 1);
    if (read.value) values.push(read.value);
    index = read.end - 1;
  }
  return values;
}

function stripSimpleSelectors(selector: string): string {
  let out = "";
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]!;
    if ((char === "." || char === "#") && !isEscaped(selector, index)) {
      index = readCssIdentifier(selector, index + 1).end - 1;
      continue;
    }
    out += char;
  }
  return out;
}

function readCssIdentifier(input: string, start: number): { value: string; end: number } {
  let value = "";
  let index = start;
  while (index < input.length) {
    const char = input[index]!;
    if (char === "\\") {
      const escaped = readCssEscape(input, index);
      value += escaped.value;
      index = escaped.end;
      continue;
    }
    if (char === "[") {
      const close = input.indexOf("]", index + 1);
      if (close === -1) break;
      const body = input.slice(index + 1, close);
      if (body.includes("=")) break;
      value += input.slice(index, close + 1);
      index = close + 1;
      continue;
    }
    if (/[\s>+~.#(]/.test(char)) break;
    value += char;
    index += 1;
  }
  return { value, end: index };
}

function readCssEscape(input: string, start: number): { value: string; end: number } {
  let index = start + 1;
  const hex = /^[0-9a-fA-F]{1,6}/.exec(input.slice(index))?.[0];
  if (hex) {
    index += hex.length;
    if (/\s/.test(input[index] ?? "")) index += 1;
    return { value: String.fromCodePoint(Number.parseInt(hex, 16)), end: index };
  }
  if (index >= input.length) return { value: "", end: index };
  return { value: input[index]!, end: index + 1 };
}

function isEscaped(input: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && input[cursor] === "\\"; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function pseudoSelectors(selector: string): Array<{ name: string; arg?: string; start: number; end: number }> {
  const pseudos: Array<{ name: string; arg?: string; start: number; end: number }> = [];
  for (let index = 0; index < selector.length; index += 1) {
    if (selector[index] !== ":" || isEscaped(selector, index)) continue;
    if (isInsideClassSelector(selector, index)) continue;
    if (selector[index + 1] === ":") {
      const read = readCssIdentifier(selector, index + 2);
      if (read.value) pseudos.push({ name: `:${read.value}`, start: index, end: read.end });
      index = read.end - 1;
      continue;
    }
    const read = readCssIdentifier(selector, index + 1);
    if (!read.value) continue;
    let end = read.end;
    let arg: string | undefined;
    if (selector[end] === "(") {
      const close = closingParenIndex(selector, end + 1);
      if (close === -1) return pseudos;
      arg = selector.slice(end + 1, close);
      end = close + 1;
    }
    pseudos.push({ name: read.value, arg, start: index, end });
    index = end - 1;
  }
  return pseudos;
}

function isInsideClassSelector(selector: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = selector[cursor]!;
    if (isEscaped(selector, cursor)) continue;
    if (char === ".") return true;
    if (/[\s>+~#\[]/.test(char)) return false;
  }
  return false;
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
