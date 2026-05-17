import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fontFamily, htmlToBoxpdf } from "../dist/index.js";
import { renderFlow } from "../../dist/index.js";
import { comparisons } from "./comparisons.mjs";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const coreRequire = createRequire(resolve(root, "../package.json"));
const { PDFDocument, StandardFonts } = coreRequire("pdf-lib");
const tempRoot = mkdtempSync(join(tmpdir(), "boxpdf-html-visual-"));
const failures = [];

try {
  for (const [fixture, outDir] of comparisons) {
    const fixturePath = resolve(root, fixture);
    const baseline = resolve(root, outDir, "boxpdf-html.png");
    if (!existsSync(baseline)) {
      failures.push(`${outDir}/boxpdf-html.png is missing`);
      continue;
    }

    const name = outDir.replace(/^artifacts\//, "");
    const actualPrefix = resolve(tempRoot, name, "boxpdf-html");
    mkdirSync(dirname(actualPrefix), { recursive: true });
    await renderBoxpdf(fixturePath, `${actualPrefix}.pdf`);
    renderPng(`${actualPrefix}.pdf`, actualPrefix);

    const expectedBytes = readFileSync(baseline);
    const actualBytes = readFileSync(`${actualPrefix}.png`);
    if (!expectedBytes.equals(actualBytes)) failures.push(`${outDir}/boxpdf-html.png changed`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(["BoxPDF visual baselines changed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
  process.exit(1);
}

console.log(`BoxPDF visual baselines match (${comparisons.length} fixtures).`);

async function renderBoxpdf(input, output) {
  const source = readFileSync(input, "utf8");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await doc.embedFont(StandardFonts.HelveticaOblique);
  const boldItalicFont = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  const images = await embedImages(doc, source, dirname(input));
  const result = htmlToBoxpdf(source, {
    font,
    boldFont,
    italicFont,
    resolveFont: fontFamily({
      Helvetica: { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont },
      Arial: { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont },
      "sans-serif": { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont }
    }),
    resolveImage: ({ url }) => images.get(resolve(dirname(input), url)),
    baseUrl: dirname(input),
    width: 532
  });

  if (result.warnings.length > 0) {
    console.warn(result.warnings.join("\n"));
  }

  await renderFlow(doc, result.nodes, { margin: 40 });
  writeFileSync(output, await doc.save());
}

async function embedImages(doc, source, baseDir) {
  const images = new Map();
  for (const url of imageUrls(source)) {
    if (!url || /^(https?:|data:)/i.test(url)) continue;
    const imagePath = resolve(baseDir, url);
    if (!existsSync(imagePath)) continue;
    if (!images.has(imagePath)) images.set(imagePath, await embedImage(doc, imagePath));
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

function embedImage(doc, imagePath) {
  const bytes = readFileSync(imagePath);
  const ext = extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return doc.embedJpg(bytes);
  return doc.embedPng(bytes);
}

function renderPng(pdf, prefix) {
  run("pdftoppm", ["-png", "-singlefile", "-r", "144", pdf, prefix]);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}
