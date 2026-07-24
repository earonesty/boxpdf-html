import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { fontFamily, htmlToBoxpdf, streamHtmlToPdf } from "../dist/index.js";
import { loadFont, renderFlow } from "boxpdf";
import { comparisons } from "./comparisons.mjs";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "boxpdf-html-stream-visual-"));
const filters = process.argv.slice(2).filter((filter) => filter !== "--");
const selected =
  filters.length === 0
    ? comparisons
    : comparisons.filter(([fixture, outDir]) =>
        filters.some((filter) => fixture.includes(filter) || outDir.includes(filter))
      );

try {
  for (const [fixture, outDir] of selected) {
    const fixturePath = resolve(root, fixture);
    const name = outDir.replace(/^artifacts\//, "");
    const outputDir = resolve(tempRoot, name);
    mkdirSync(outputDir, { recursive: true });

    const buffered = await buildFixture(fixturePath);
    await renderFlow(buffered.doc, buffered.nodes, { margin: 40 });
    const bufferedPdf = resolve(outputDir, "buffered.pdf");
    writeFileSync(bufferedPdf, await buffered.doc.save());

    const streamed = await buildFixture(fixturePath, false);
    const chunks = [];
    await streamHtmlToPdf(
      () => sourceChunks(streamed.source),
      new WritableStream({
        write(chunk) {
          chunks.push(chunk);
        }
      }),
      {
        ...streamed.options,
        pdf: streamed.doc,
        preloadFonts: streamed.fonts,
        margin: 40
      }
    );
    const streamedPdf = resolve(outputDir, "streamed.pdf");
    writeFileSync(streamedPdf, concat(chunks));

    const bufferedPages = rasterize(bufferedPdf, resolve(outputDir, "buffered"));
    const streamedPages = rasterize(streamedPdf, resolve(outputDir, "streamed"));
    if (bufferedPages.length !== streamedPages.length) {
      throw new Error(
        `${fixture}: page count differs (${bufferedPages.length} buffered, ${streamedPages.length} streamed)`
      );
    }
    for (let index = 0; index < bufferedPages.length; index += 1) {
      if (!readFileSync(bufferedPages[index]).equals(readFileSync(streamedPages[index]))) {
        throw new Error(`${fixture}: page ${index + 1} differs`);
      }
    }
    console.log(`${fixture}: ${bufferedPages.length} page(s) match`);
  }
} finally {
  if (process.env.BOXPDF_KEEP_VISUALS === "1") console.error(`Visual artifacts kept in ${tempRoot}`);
  else rmSync(tempRoot, { recursive: true, force: true });
}

if (selected.length === 0) {
  throw new Error(`No visual fixtures matched: ${filters.join(", ")}`);
}

async function buildFixture(input, buildNodes = true) {
  const source = readFileSync(input, "utf8");
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await loadFont(doc, readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), { subset: false });
  const boldFont = await loadFont(doc, readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"), { subset: false });
  const italicFont = await loadFont(doc, readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf"), { subset: false });
  const boldItalicFont = await loadFont(doc, readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf"), { subset: false });
  const images = await embedImages(doc, source, dirname(input));
  const options = {
    font,
    boldFont,
    italicFont,
    resolveFont: fontFamily({
      Helvetica: { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont },
      Arial: { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont },
      "sans-serif": { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont },
      "New York Times": { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont },
      "nyt-cheltenham": { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont },
      "nyt-franklin": { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont }
    }),
    resolveImage: ({ url }) => images.get(resolve(dirname(input), url)),
    baseUrl: dirname(input),
    width: 532
  };
  if (!buildNodes) return { doc, source, options, fonts: [font, boldFont, italicFont, boldItalicFont] };
  const result = htmlToBoxpdf(source, options);
  if (result.warnings.length > 0) console.warn(result.warnings.join("\n"));
  return { doc, nodes: result.nodes, source, options, fonts: [font, boldFont, italicFont, boldItalicFont] };
}

async function* sourceChunks(source) {
  const bytes = new TextEncoder().encode(source);
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    yield bytes.slice(offset, offset + 4096);
  }
}

async function embedImages(doc, source, baseDir) {
  const images = new Map();
  for (const url of imageUrls(source)) {
    if (!url || /^(https?:|data:)/i.test(url)) continue;
    const imagePath = resolve(baseDir, url);
    if (!existsSync(imagePath) || images.has(imagePath)) continue;
    const bytes = readFileSync(imagePath);
    const ext = extname(imagePath).toLowerCase();
    images.set(imagePath, ext === ".jpg" || ext === ".jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes));
  }
  return images;
}

function imageUrls(source) {
  const urls = [];
  for (const match of source.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*?))\s*\)/gi)) {
    urls.push((match[1] ?? match[2] ?? match[3])?.trim());
  }
  for (const match of source.matchAll(/<(?:img|source)\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    urls.push((match[1] ?? match[2] ?? match[3])?.trim());
  }
  for (const match of source.matchAll(/<(?:img|source)\b[^>]*\bsrcset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^>]+))/gi)) {
    const srcset = (match[1] ?? match[2] ?? match[3])?.trim();
    for (const candidate of srcset?.split(",") ?? []) {
      const [url] = candidate.trim().split(/\s+/, 1);
      if (url) urls.push(url);
    }
  }
  return urls;
}

function rasterize(pdf, prefix) {
  execFileSync("pdftoppm", ["-png", "-r", "144", pdf, prefix], { stdio: "pipe" });
  const stem = prefix.slice(prefix.lastIndexOf("/") + 1);
  return readdirSync(dirname(prefix))
    .filter((name) => name.startsWith(`${stem}-`) && name.endsWith(".png"))
    .sort((left, right) => pageNumber(left) - pageNumber(right))
    .map((name) => resolve(dirname(prefix), name));
}

function pageNumber(name) {
  const match = name.match(/-(\d+)\.png$/);
  if (!match) throw new Error(`unexpected raster filename: ${name}`);
  return Number(match[1]);
}

function concat(chunks) {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
