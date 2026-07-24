import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { PDFDocument, StandardFonts, type PDFFont, type PDFImage } from "pdf-lib";
import { loadFont, loadImage } from "boxpdf";
import { fontFamily, type FontFamilyMap } from "./font.js";

/**
 * Shared, filesystem-aware rendering helpers used by both the `boxpdf-html`
 * CLI and the MCP server. These throw `Error` on bad input (the CLI's
 * top-level handler turns that into a `boxpdf-html: <message>` exit; the MCP
 * server turns it into a tool error result).
 */

export interface FaceSpec {
  /** Path to a regular-weight TTF/OTF. Falls back to built-in Helvetica. */
  font?: string;
  /** Path to a bold TTF/OTF. Falls back to Helvetica-Bold. */
  boldFont?: string;
  /** Path to an italic TTF/OTF. Falls back to Helvetica-Oblique. */
  italicFont?: string;
  /** Path to a bold-italic TTF/OTF. Falls back to Helvetica-BoldOblique. */
  boldItalicFont?: string;
  /** Repeatable `Family=normal:a.ttf,bold:b.ttf` mappings (CLI form). */
  families?: string[];
}

export interface LoadedFaces {
  normal: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  families: FontFamilyMap;
}

export function injectCss(html: string, stylesheets: string[]): string {
  if (stylesheets.length === 0) return html;
  const style = `<style>\n${stylesheets.join("\n")}\n</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${style}\n</head>`);
  return `${style}\n${html}`;
}

export async function loadFaces(pdf: PDFDocument, spec: FaceSpec, baseUrl: string): Promise<LoadedFaces> {
  const normal = spec.font ? await loadFont(pdf, readFileSync(resolve(spec.font))) : await pdf.embedFont(StandardFonts.Helvetica);
  const bold = spec.boldFont ? await loadFont(pdf, readFileSync(resolve(spec.boldFont))) : await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = spec.italicFont ? await loadFont(pdf, readFileSync(resolve(spec.italicFont))) : await pdf.embedFont(StandardFonts.HelveticaOblique);
  const boldItalic = spec.boldItalicFont
    ? await loadFont(pdf, readFileSync(resolve(spec.boldItalicFont)))
    : await pdf.embedFont(StandardFonts.HelveticaBoldOblique);

  const faces = { normal, bold, italic, boldItalic };
  const families: FontFamilyMap = {
    Helvetica: faces,
    Arial: faces,
    "sans-serif": faces,
    serif: faces,
    monospace: faces
  };

  for (const mapping of spec.families ?? []) {
    const [name, familySpec] = splitOnce(mapping, "=");
    if (!name || !familySpec) throw new Error(`invalid --font-family "${mapping}"`);
    families[name.trim()] = await loadFamily(pdf, familySpec, baseUrl);
  }

  return { normal, bold, italic, boldItalic, families };
}

async function loadFamily(pdf: PDFDocument, spec: string, baseUrl: string): Promise<FontFamilyMap[string]> {
  const out: Exclude<FontFamilyMap[string], PDFFont> = {};
  for (const part of spec.split(",")) {
    const [rawKey, rawPath] = splitOnce(part, ":");
    if (!rawKey || !rawPath) throw new Error(`invalid font family face "${part}"`);
    const key = rawKey.trim();
    if (!["normal", "bold", "italic", "boldItalic"].includes(key) && !/^\d+$/.test(key)) {
      throw new Error(`invalid font face key "${key}"`);
    }
    out[key as keyof typeof out] = await loadFont(pdf, readFileSync(resolveAssetUrl(rawPath.trim(), baseUrl)));
  }
  return out;
}

export interface LoadImagesOptions {
  /** Allow fetching http(s) image URLs. Off by default to prevent SSRF. */
  allowRemote?: boolean;
  /** Called with a human-readable message when an image fails to load. */
  onWarn?: (message: string) => void;
}

export async function loadImages(
  pdf: PDFDocument,
  html: string,
  baseUrl: string,
  options: LoadImagesOptions = {}
): Promise<Map<string, PDFImage>> {
  return loadImageUrls(pdf, imageUrls(html), baseUrl, options);
}

export async function loadImageUrls(
  pdf: PDFDocument,
  urls: Iterable<string>,
  baseUrl: string,
  options: LoadImagesOptions = {}
): Promise<Map<string, PDFImage>> {
  const images = new Map<string, PDFImage>();
  for (const url of urls) {
    const resolved = resolveAssetUrl(url, baseUrl);
    if (images.has(resolved)) continue;
    try {
      images.set(resolved, await loadImage(pdf, assetSource(resolved, options.allowRemote ?? false)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onWarn?.(`image "${url}" did not load: ${message}`);
    }
  }
  return images;
}

export function imageUrls(source: string): string[] {
  const urls: string[] = [];
  for (const match of source.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*?))\s*\)/gi)) {
    const url = (match[1] ?? match[2] ?? match[3])?.trim();
    if (url) urls.push(url);
  }
  for (const match of source.matchAll(/<(?:img|source)\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    const url = (match[1] ?? match[2] ?? match[3])?.trim();
    if (url) urls.push(url);
  }
  return urls;
}

export function resolveAssetUrl(url: string, baseUrl: string): string {
  if (/^(https?:|data:)/i.test(url)) return url;
  if (url.startsWith("file://")) return new URL(url).pathname;
  if (/^[a-z]+:\/\//i.test(url)) return url;
  return isAbsolute(url) ? url : resolve(baseUrl, url);
}

function assetSource(resolved: string, allowRemote: boolean): string | Uint8Array {
  if (/^(https?:)/i.test(resolved)) {
    if (!allowRemote) throw new Error(`remote fetch blocked (allowRemote is off): ${resolved}`);
    return resolved;
  }
  if (/^data:/i.test(resolved)) return resolved;
  if (!existsSync(resolved)) throw new Error(`file not found: ${resolved}`);
  return readFileSync(resolved);
}

export function splitOnce(value: string, separator: string): [string, string] | [string, undefined] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, undefined];
  return [value.slice(0, index), value.slice(index + separator.length)];
}
