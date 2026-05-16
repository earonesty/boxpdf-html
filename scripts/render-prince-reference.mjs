import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { htmlToBoxpdf } from "../dist/index.js";
import { renderFlow } from "../../dist/index.js";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require("pdf-lib");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  const result = htmlToBoxpdf(source, { font, boldFont, italicFont, width: 532 });

  if (result.warnings.length > 0) {
    console.warn(result.warnings.join("\n"));
  }

  await renderFlow(doc, result.nodes, { margin: 40 });
  writeFileSync(output, await doc.save());
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
