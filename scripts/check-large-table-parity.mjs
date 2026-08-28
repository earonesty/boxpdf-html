import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { renderFlow } from "@boxpdf/writer";
import { htmlToBoxpdf, streamHtmlToPdf } from "../dist/index.js";

const source = `<style>
  table { width: 440px; border-collapse: collapse; }
  td { padding: 4px; border: 1px solid #94a3b8; font-size: 9px; }
</style><table><tbody>${
  Array.from(
    { length: 400 },
    (_, index) => `<tr><td>Bounded table row ${index + 1}</td><td>${index + 1}</td></tr>`
  ).join("")
}</tbody></table>`;

const root = mkdtempSync(join(tmpdir(), "boxpdf-html-large-table-"));
try {
  const buffered = await documentAndFonts();
  const nodes = htmlToBoxpdf(source, {
    font: buffered.font,
    boldFont: buffered.bold,
    width: 532
  }).nodes;
  await renderFlow(buffered.pdf, nodes, { margin: 40 });
  const bufferedPdf = join(root, "buffered.pdf");
  writeFileSync(bufferedPdf, await buffered.pdf.save());

  const streamed = await documentAndFonts();
  const chunks = [];
  await streamHtmlToPdf(
    () => sourceChunks(source, 256),
    new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      }
    }),
    {
      pdf: streamed.pdf,
      font: streamed.font,
      boldFont: streamed.bold,
      width: 532,
      margin: 40,
      fragmentChildren: 16
    }
  );
  const streamedPdf = join(root, "streamed.pdf");
  writeFileSync(streamedPdf, concat(chunks));

  const bufferedPages = rasterize(bufferedPdf, join(root, "buffered"));
  const streamedPages = rasterize(streamedPdf, join(root, "streamed"));
  if (bufferedPages.length !== streamedPages.length) {
    throw new Error(`large table page count differs (${bufferedPages.length} buffered, ${streamedPages.length} streamed)`);
  }
  for (let index = 0; index < bufferedPages.length; index += 1) {
    if (!readFileSync(bufferedPages[index]).equals(readFileSync(streamedPages[index]))) {
      throw new Error(`large table page ${index + 1} differs`);
    }
  }
  console.log(`large streamed table: ${bufferedPages.length} page(s) match`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function documentAndFonts() {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  return {
    pdf,
    font: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold)
  };
}

async function* sourceChunks(value, size) {
  const bytes = new TextEncoder().encode(value);
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.slice(offset, offset + size);
  }
}

function rasterize(pdf, prefix) {
  execFileSync("pdftoppm", ["-png", "-r", "144", pdf, prefix], { stdio: "pipe" });
  const pages = readdirSync(dirname(prefix))
    .filter((name) => name.startsWith(`${basename(prefix)}-`) && name.endsWith(".png"))
    .sort((left, right) => pageNumber(left) - pageNumber(right))
    .map((name) => join(dirname(prefix), name));
  if (pages.length === 0) throw new Error(`no rasterized pages for ${pdf}`);
  return pages;
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
