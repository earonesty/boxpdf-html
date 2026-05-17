#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { PDFDocument, StandardFonts, type PDFFont, type PDFImage } from "pdf-lib";
import { loadFont, loadImage, renderFlow } from "boxpdf";
import { fontFamily, htmlToBoxpdf, type FontFamilyMap } from "./index.js";

interface CliOptions {
  input?: string;
  output?: string;
  css: string[];
  baseUrl?: string;
  font?: string;
  boldFont?: string;
  italicFont?: string;
  boldItalicFont?: string;
  families: string[];
  width?: number;
  margin: number;
  debug: boolean;
  unsupportedCss: boolean;
  profile: boolean;
}

const help = `boxpdf-html

Usage:
  boxpdf-html <input.html> <output.pdf> [options]
  boxpdf-html - <output.pdf> [options]

Options:
  --css <file>              Inject an extra stylesheet before rendering. Repeatable.
  --base-url <dir-or-url>   Base path for relative images and background URLs.
  --font <file>             Default normal TTF/OTF font.
  --bold-font <file>        Default bold TTF/OTF font.
  --italic-font <file>      Default italic TTF/OTF font.
  --bold-italic-font <file> Default bold italic TTF/OTF font.
  --font-family <mapping>   Map a CSS family to loaded font files. Repeatable.
                            Example: Inter=normal:Inter.ttf,bold:Inter-Bold.ttf
  --width <pt>              CSS containing block width in PDF points.
  --margin <pt>             Page margin for renderFlow. Default: 40.
  --debug                   Draw boxpdf debug overlays.
  --unsupported-css         Print aggregated unsupported CSS diagnostics.
  --profile                 Print render phase timings.
  -h, --help                Show this help.

Examples:
  boxpdf-html invoice.html invoice.pdf
  boxpdf-html invoice.html invoice.pdf --css dist/tailwind.css
  boxpdf-html invoice.html invoice.pdf --font ./Inter.ttf --bold-font ./Inter-Bold.ttf
  boxpdf-html invoice.html invoice.pdf \\
    --font-family 'Inter=normal:Inter.ttf,bold:Inter-Bold.ttf,italic:Inter-Italic.ttf'
`;

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`boxpdf-html: ${message}`);
  process.exit(1);
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input || !options.output) {
    printHelpAndExit(options.input || options.output ? 1 : 0);
  }

  const inputPath = options.input === "-" ? undefined : resolve(options.input);
  const baseUrl = options.baseUrl ? resolve(options.baseUrl) : inputPath ? dirname(inputPath) : process.cwd();
  const html = injectCss(readInput(options.input), options.css.map((path) => readFileSync(resolve(path), "utf8")));
  const pdf = await PDFDocument.create();
  const faces = await loadFaces(pdf, options, baseUrl);
  const images = await loadImages(pdf, html, baseUrl);

  const result = htmlToBoxpdf(html, {
    font: faces.normal,
    boldFont: faces.bold,
    italicFont: faces.italic,
    resolveFont: fontFamily(faces.families),
    resolveImage: ({ url }) => images.get(resolveAssetUrl(url, baseUrl)),
    baseUrl,
    width: options.width ?? Math.max(0, 612 - options.margin * 2),
    diagnostics: options.unsupportedCss ? { unsupportedCss: true, sampleLimit: 5 } : undefined,
    profile: options.profile ? (event) => console.error(`[profile] ${event.phase} ${event.elapsedMs.toFixed(1)}ms`) : undefined
  });

  for (const warning of result.warnings) console.warn(`boxpdf-html: ${warning}`);
  if (options.unsupportedCss) printUnsupportedCss(result.diagnostics?.unsupportedCss ?? []);

  await renderFlow(pdf, result.nodes, { margin: options.margin, debug: options.debug });
  writeFileSync(resolve(options.output), await pdf.save());
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    css: [],
    families: [],
    margin: 40,
    debug: false,
    unsupportedCss: false,
    profile: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help" || arg === "help") printHelpAndExit(0);
    if (!arg.startsWith("-") || arg === "-") {
      if (!options.input) options.input = arg;
      else if (!options.output) options.output = arg;
      else fail(`unexpected argument "${arg}"`);
      continue;
    }

    const next = (): string => {
      const value = args[i + 1];
      if (!value) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };

    switch (arg) {
      case "--css":
        options.css.push(next());
        break;
      case "--base-url":
        options.baseUrl = next();
        break;
      case "--font":
        options.font = next();
        break;
      case "--bold-font":
        options.boldFont = next();
        break;
      case "--italic-font":
        options.italicFont = next();
        break;
      case "--bold-italic-font":
        options.boldItalicFont = next();
        break;
      case "--font-family":
        options.families.push(next());
        break;
      case "--width":
        options.width = parseNumber(next(), arg);
        break;
      case "--margin":
        options.margin = parseNumber(next(), arg);
        break;
      case "--debug":
        options.debug = true;
        break;
      case "--unsupported-css":
        options.unsupportedCss = true;
        break;
      case "--profile":
        options.profile = true;
        break;
      default:
        fail(`unknown option "${arg}"`);
    }
  }

  return options;
}

function readInput(input: string): string {
  if (input === "-") return readFileSync(0, "utf8");
  return readFileSync(resolve(input), "utf8");
}

function injectCss(html: string, stylesheets: string[]): string {
  if (stylesheets.length === 0) return html;
  const style = `<style>\n${stylesheets.join("\n")}\n</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${style}\n</head>`);
  return `${style}\n${html}`;
}

async function loadFaces(
  pdf: PDFDocument,
  options: CliOptions,
  baseUrl: string
): Promise<{ normal: PDFFont; bold: PDFFont; italic: PDFFont; families: FontFamilyMap }> {
  const normal = options.font ? await loadFont(pdf, readFileSync(resolve(options.font))) : await pdf.embedFont(StandardFonts.Helvetica);
  const bold = options.boldFont ? await loadFont(pdf, readFileSync(resolve(options.boldFont))) : await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = options.italicFont ? await loadFont(pdf, readFileSync(resolve(options.italicFont))) : await pdf.embedFont(StandardFonts.HelveticaOblique);
  const boldItalic = options.boldItalicFont
    ? await loadFont(pdf, readFileSync(resolve(options.boldItalicFont)))
    : await pdf.embedFont(StandardFonts.HelveticaBoldOblique);

  const families: FontFamilyMap = {
    Helvetica: { normal, bold, italic, boldItalic },
    Arial: { normal, bold, italic, boldItalic },
    "sans-serif": { normal, bold, italic, boldItalic },
    serif: { normal, bold, italic, boldItalic },
    monospace: { normal, bold, italic, boldItalic }
  };

  for (const mapping of options.families) {
    const [name, spec] = splitOnce(mapping, "=");
    if (!name || !spec) fail(`invalid --font-family "${mapping}"`);
    families[name.trim()] = await loadFamily(pdf, spec, baseUrl);
  }

  return { normal, bold, italic, families };
}

async function loadFamily(pdf: PDFDocument, spec: string, baseUrl: string): Promise<FontFamilyMap[string]> {
  const out: Exclude<FontFamilyMap[string], PDFFont> = {};
  for (const part of spec.split(",")) {
    const [rawKey, rawPath] = splitOnce(part, ":");
    if (!rawKey || !rawPath) fail(`invalid font family face "${part}"`);
    const key = rawKey.trim();
    if (!["normal", "bold", "italic", "boldItalic"].includes(key) && !/^\d+$/.test(key)) {
      fail(`invalid font face key "${key}"`);
    }
    out[key as keyof typeof out] = await loadFont(pdf, readFileSync(resolveAssetUrl(rawPath.trim(), baseUrl)));
  }
  return out;
}

async function loadImages(pdf: PDFDocument, html: string, baseUrl: string): Promise<Map<string, PDFImage>> {
  const images = new Map<string, PDFImage>();
  for (const url of imageUrls(html)) {
    const resolved = resolveAssetUrl(url, baseUrl);
    if (images.has(resolved)) continue;
    try {
      images.set(resolved, await loadImage(pdf, assetSource(resolved)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`boxpdf-html: image "${url}" did not load: ${message}`);
    }
  }
  return images;
}

function imageUrls(source: string): string[] {
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

function resolveAssetUrl(url: string, baseUrl: string): string {
  if (/^(https?:|data:)/i.test(url)) return url;
  if (url.startsWith("file://")) return new URL(url).pathname;
  if (/^[a-z]+:\/\//i.test(url)) return url;
  return isAbsolute(url) ? url : resolve(baseUrl, url);
}

function assetSource(resolved: string): string | Uint8Array {
  if (/^(https?:|data:)/i.test(resolved)) return resolved;
  if (!existsSync(resolved)) throw new Error(`file not found: ${resolved}`);
  return readFileSync(resolved);
}

function printUnsupportedCss(items: Array<{ property: string; value: string; count: number; samples?: string[] }>): void {
  if (items.length === 0) return;
  console.error("Unsupported CSS:");
  for (const item of items) {
    console.error(`- ${item.property}: ${item.value} (${item.count})`);
    for (const sample of item.samples ?? []) console.error(`  ${sample}`);
  }
}

function parseNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${option} must be a non-negative number`);
  return parsed;
}

function splitOnce(value: string, separator: string): [string, string] | [string, undefined] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, undefined];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

function printHelpAndExit(code: number): never {
  console.log(help);
  process.exit(code);
}

function fail(message: string): never {
  console.error(`boxpdf-html: ${message}`);
  process.exit(1);
}
