import type { PDFFont } from "pdf-lib";
import type { FontStyle, FontWeight, HtmlFontResolver, HtmlFontRequest } from "./types.js";

export type FontFamilyFace = PDFFont | Partial<Record<FontStyle | "bold" | "boldItalic" | `${number}`, PDFFont>>;
export type FontFamilyMap = Record<string, FontFamilyFace>;

export function fontFamily(families: FontFamilyMap): HtmlFontResolver {
  const normalized = new Map<string, FontFamilyFace>();
  for (const [name, face] of Object.entries(families)) {
    normalized.set(normalizeFamily(name), face);
  }

  return (request) => {
    for (const family of request.families) {
      const face = normalized.get(normalizeFamily(family));
      const font = face && resolveFace(face, request);
      if (font) return font;
    }
    return undefined;
  };
}

function resolveFace(face: FontFamilyFace, request: HtmlFontRequest): PDFFont | undefined {
  if (isPdfFont(face)) return face;
  const preferred = preferredKeys(request.weight, request.style);
  for (const key of preferred) {
    const font = face[key];
    if (font) return font;
  }
  return face.normal ?? face.bold ?? face.italic;
}

function preferredKeys(weight: FontWeight, style: FontStyle): Array<keyof Exclude<FontFamilyFace, PDFFont>> {
  const keys: Array<keyof Exclude<FontFamilyFace, PDFFont>> = [];
  if (typeof weight === "number") keys.push(`${weight}`);
  if (isBold(weight) && style === "italic") keys.push("boldItalic");
  if (style === "italic") keys.push("italic");
  if (isBold(weight)) keys.push("bold");
  keys.push("normal");
  return keys;
}

function isBold(weight: FontWeight): boolean {
  return weight === "bold" || (typeof weight === "number" && weight >= 600);
}

function normalizeFamily(family: string): string {
  return family.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}

function isPdfFont(value: FontFamilyFace): value is PDFFont {
  return "embedder" in value;
}
