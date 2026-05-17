import { generate, parse as parseCss, walk } from "css-tree";
import { parseColor } from "./color.js";
import { parseLength, parseLengthPercentage, parseLineHeight, parsePercentage } from "./units.js";
import type { CssDeclaration, CssRule, CssStyle, Display, GridTrack, HtmlElementNode } from "./types.js";
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
      const declarations = rawDeclarationsFromBlock(block);
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

export function parseStyleAttribute(value: string | undefined, fontSize: number, customProperties: Record<string, string> = {}): DeclarationSet {
  const declarations: DeclarationSet = { declarations: {}, importantDeclarations: {} };
  if (!value) return declarations;
  const raw = rawDeclarationsFromStyleAttribute(value);
  const vars = mergeCustomProperties(customProperties, raw.declarations, raw.importantDeclarations);
  parseDeclarationsInto(declarations.declarations, raw.declarations, fontSize, vars);
  parseDeclarationsInto(declarations.importantDeclarations, raw.importantDeclarations, fontSize, vars);
  return declarations;
}

export function ruleDeclarationsFor(
  node: HtmlElementNode,
  rules: CssRule[],
  fontSize: number,
  customProperties: Record<string, string> = {}
): DeclarationSet {
  const out: DeclarationSet = { declarations: {}, importantDeclarations: {} };
  const declarations: CssDeclaration[] = [];
  const importantDeclarations: CssDeclaration[] = [];
  for (const rule of rules.filter((r) => matchesSelector(node, r.selector)).sort(compareRule)) {
    declarations.push(...rule.declarations);
    importantDeclarations.push(...rule.importantDeclarations);
  }
  const vars = mergeCustomProperties(customProperties, declarations, importantDeclarations);
  parseDeclarationsInto(out.declarations, declarations, fontSize, vars);
  parseDeclarationsInto(out.importantDeclarations, importantDeclarations, fontSize, vars);
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
  customProperties: Record<string, string>
): void {
  for (const declaration of declarations) {
    const property = declaration.property.trim();
    if (property.startsWith("--")) continue;
    applyDeclaration(out, property, resolveVars(declaration.value, customProperties), fontSize);
  }
  const vars = customPropertiesFrom(declarations, customProperties);
  if (Object.keys(vars).length > 0) out.customProperties = vars;
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
    case "margin":
      out.margin = parseEdges(value, fontSize);
      break;
    case "margin-block":
      applyTwoValueEdges(out, "margin", "top", "bottom", value, fontSize);
      break;
    case "margin-inline":
      applyTwoValueEdges(out, "margin", "left", "right", value, fontSize);
      break;
    case "margin-block-start":
      out.margin = setEdge(out.margin, "top", parseLength(value, fontSize));
      break;
    case "margin-block-end":
      out.margin = setEdge(out.margin, "bottom", parseLength(value, fontSize));
      break;
    case "margin-inline-start":
      out.margin = setEdge(out.margin, "left", parseLength(value, fontSize));
      break;
    case "margin-inline-end":
      out.margin = setEdge(out.margin, "right", parseLength(value, fontSize));
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
    case "border":
      parseBorder(out, value, fontSize);
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
  return value.replace(/repeat\(\s*(\d+)\s*,\s*([^)]+)\)/g, (_match, countRaw: string, repeated: string) => {
    const count = Number(countRaw);
    if (!Number.isInteger(count) || count <= 0 || count > 24) return "";
    return Array.from({ length: count }, () => repeated.trim()).join(" ");
  });
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
