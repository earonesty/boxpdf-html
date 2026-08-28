#!/usr/bin/env node

import {
  createReadStream,
  createWriteStream,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PDFDocument, type PDFFont, type PDFImage } from "pdf-lib";
import { nodeAdapter, renderFlow, savePdf } from "@boxpdf/writer";
import { fontFamily, htmlToBoxpdf, streamHtmlToPdf, type HtmlStreamSource } from "./index.js";
import { passwordFromEnvironment } from "./password-env.js";
import {
  injectCss,
  loadFaces,
  loadImages,
  loadImageUrls,
  resolveAssetUrl,
  type LoadedFaces
} from "./render-file.js";

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
  stream: boolean;
  passwordEnv?: string;
}

const help = `boxpdf-html

Usage:
  boxpdf-html <input.html> <output.pdf> [options]
  boxpdf-html - <output.pdf> [options]
  boxpdf-html mcp                              # start the MCP server (stdio)

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
  --stream                  Use bounded-memory two-pass HTML and PDF streaming.
  --password-env <name>     Encrypt with the password stored in this environment variable.
  -h, --help                Show this help.

Examples:
  boxpdf-html invoice.html invoice.pdf
  boxpdf-html invoice.html invoice.pdf --css dist/tailwind.css
  boxpdf-html archive.html archive.pdf --stream
  type archive.html | boxpdf-html - archive.pdf --stream
  BOXPDF_PASSWORD='open me' boxpdf-html invoice.html invoice.pdf --password-env BOXPDF_PASSWORD
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
  const argv = process.argv.slice(2);
  if (argv[0] === "mcp") {
    const { startMcpServer } = await import("./mcp.js");
    startMcpServer();
    return;
  }

  const options = parseArgs(argv);
  if (!options.input || !options.output) {
    printHelpAndExit(options.input || options.output ? 1 : 0);
  }
  const password = passwordFromEnvironment(options.passwordEnv);

  const inputPath = options.input === "-" ? undefined : resolve(options.input);
  const baseUrl = options.baseUrl ? resolve(options.baseUrl) : inputPath ? dirname(inputPath) : process.cwd();
  if (options.stream) {
    await renderStreamed(
      { ...options, input: options.input, output: options.output },
      inputPath,
      baseUrl,
      password
    );
    return;
  }
  const html = injectCss(readInput(options.input), options.css.map((path) => readFileSync(resolve(path), "utf8")));
  const pdf = await PDFDocument.create();
  const faces = await loadFaces(pdf, options, baseUrl);
  const images = await loadImages(pdf, html, baseUrl, {
    allowRemote: true,
    onWarn: (message) => console.warn(`boxpdf-html: ${message}`)
  });

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
  const bytes = password === undefined
    ? await pdf.save()
    : await savePdf(pdf, { encryption: { password } });
  writeFileSync(resolve(options.output), bytes);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    css: [],
    families: [],
    margin: 40,
    debug: false,
    unsupportedCss: false,
    profile: false,
    stream: false
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
      case "--stream":
        options.stream = true;
        break;
      case "--password-env":
        options.passwordEnv = next();
        break;
      default:
        fail(`unknown option "${arg}"`);
    }
  }

  return options;
}

async function renderStreamed(
  options: CliOptions & { input: string; output: string },
  inputPath: string | undefined,
  baseUrl: string,
  password: string | undefined
): Promise<void> {
  const startedAt = performance.now();
  const inputTemp = inputPath ? undefined : mkdtempSync(join(tmpdir(), "boxpdf-html-input-"));
  const sourcePath = inputPath ?? join(inputTemp!, "stdin.htm");
  const outputPath = resolve(options.output);
  const outputTemp = mkdtempSync(join(dirname(outputPath), `.${basename(outputPath)}-`));
  const partialPath = join(outputTemp, "output.pdf");

  try {
    if (!inputPath) await pipeline(process.stdin, createWriteStream(sourcePath));
    const stylesheets = options.css.map((path) => readFileSync(resolve(path), "utf8"));
    const openInput = fileSource(sourcePath, stylesheets);
    const pdf = await PDFDocument.create();
    const faces = await loadFaces(pdf, options, baseUrl);
    let images = new Map<string, PDFImage>();
    const result = await streamHtmlToPdf(openInput, nodeAdapter(createWriteStream(partialPath)), {
      pdf,
      font: faces.normal,
      boldFont: faces.bold,
      italicFont: faces.italic,
      preloadFonts: faceFonts(faces),
      resolveFont: fontFamily(faces.families),
      resolveImage: ({ url }) => images.get(resolveAssetUrl(url, baseUrl)),
      baseUrl,
      width: options.width ?? Math.max(0, 612 - options.margin * 2),
      margin: options.margin,
      debug: options.debug,
      warnings: true,
      diagnostics: options.unsupportedCss ? { unsupportedCss: true, sampleLimit: 5 } : undefined,
      encryption: password === undefined ? undefined : { password },
      prepare: async (preflight) => {
        images = await loadImageUrls(pdf, preflight.assetUrls, baseUrl, {
          allowRemote: true,
          onWarn: (message) => console.warn(`boxpdf-html: ${message}`)
        });
      }
    });
    for (const warning of result.warnings) console.warn(`boxpdf-html: ${warning}`);
    if (options.unsupportedCss) printUnsupportedCss(result.diagnostics?.unsupportedCss ?? []);
    renameSync(partialPath, outputPath);
    if (options.profile) {
      console.error(
        `[profile] stream ${(performance.now() - startedAt).toFixed(1)}ms, ` +
        `${result.pageCount} pages, ${result.preflight.htmlBytes} HTML bytes, ` +
        `max ${result.dom.maxBufferedNodes} DOM nodes buffered`
      );
    }
  } finally {
    rmSync(outputTemp, { recursive: true, force: true });
    if (inputTemp) rmSync(inputTemp, { recursive: true, force: true });
  }
}

function fileSource(path: string, stylesheets: string[]): HtmlStreamSource {
  const injected = stylesheets.length === 0
    ? undefined
    : new TextEncoder().encode(`<style>\n${stylesheets.join("\n")}\n</style>`);
  return async function* openInput() {
    for await (const chunk of createReadStream(path)) yield chunk;
    if (injected) yield injected;
  };
}

function faceFonts(faces: LoadedFaces): PDFFont[] {
  const fonts = new Set<PDFFont>([faces.normal, faces.bold, faces.italic, faces.boldItalic]);
  for (const family of Object.values(faces.families)) {
    if ("embedder" in family) {
      fonts.add(family);
      continue;
    }
    for (const font of Object.values(family)) {
      if (font) fonts.add(font);
    }
  }
  return [...fonts];
}

function readInput(input: string): string {
  if (input === "-") return readFileSync(0, "utf8");
  return readFileSync(resolve(input), "utf8");
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

function printHelpAndExit(code: number): never {
  console.log(help);
  process.exit(code);
}

function fail(message: string): never {
  console.error(`boxpdf-html: ${message}`);
  process.exit(1);
}
