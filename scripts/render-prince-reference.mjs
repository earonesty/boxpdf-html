import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fontFamily, htmlToBoxpdf } from "../dist/index.js";
import { renderFlow } from "../../dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRequire = createRequire(resolve(root, "../package.json"));
const { PDFDocument, StandardFonts } = coreRequire("pdf-lib");
const input = resolve(root, process.argv[2] ?? "fixtures/alpha-mvp.html");
const outDir = resolve(root, process.argv[3] ?? "artifacts/prince-reference");
const prince = process.env.PRINCE_BIN ?? resolve(root, ".tools/prince/lib/prince/bin/prince");

mkdirSync(outDir, { recursive: true });

const html = readFileSync(input, "utf8");
const boxpdfPdf = resolve(outDir, "boxpdf-html.pdf");
const princePdf = resolve(outDir, "prince.pdf");

await renderBoxpdf(html, boxpdfPdf);
run(prince, [input, "-o", princePdf]);
renderPng(boxpdfPdf, resolve(outDir, "boxpdf-html"));
renderPng(princePdf, resolve(outDir, "prince"));

console.log(`wrote ${boxpdfPdf}`);
console.log(`wrote ${resolve(outDir, "boxpdf-html.png")}`);
console.log(`wrote ${princePdf}`);
console.log(`wrote ${resolve(outDir, "prince.png")}`);

async function renderBoxpdf(source, output) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await doc.embedFont(StandardFonts.HelveticaOblique);
  const images = await embedImages(doc, source, dirname(input));
  const result = htmlToBoxpdf(source, {
    font,
    boldFont,
    italicFont,
    resolveFont: fontFamily({
      Helvetica: { normal: font, bold: boldFont, italic: italicFont },
      Arial: { normal: font, bold: boldFont, italic: italicFont },
      "sans-serif": { normal: font, bold: boldFont, italic: italicFont }
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
  for (const match of source.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*?))\s*\)/gi)) {
    const url = (match[1] ?? match[2] ?? match[3])?.trim();
    if (!url || /^(https?:|data:)/i.test(url)) continue;
    const imagePath = resolve(baseDir, url);
    if (!images.has(imagePath)) images.set(imagePath, await embedImage(doc, imagePath));
  }
  for (const match of source.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    const url = (match[1] ?? match[2] ?? match[3])?.trim();
    if (!url || /^(https?:|data:)/i.test(url)) continue;
    const imagePath = resolve(baseDir, url);
    if (!images.has(imagePath)) images.set(imagePath, await embedImage(doc, imagePath));
  }
  return images;
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
