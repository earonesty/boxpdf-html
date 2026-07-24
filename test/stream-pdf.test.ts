import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { streamHtmlToPdf } from "../src/stream/pdf.js";

describe("streamHtmlToPdf", () => {
  it("converts many root flow nodes with bounded parser queues", async () => {
    const source = `<main>${Array.from({ length: 1_000 }, (_, index) => `<p>Streamed row ${index}</p>`).join("")}</main>`;
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
    const chunks: Uint8Array[] = [];

    const result = await streamHtmlToPdf(
      () => inputChunks(source, 128),
      new WritableStream({
        write(chunk) {
          chunks.push(chunk);
        }
      }),
      { pdf, font, boldFont, width: 532, margin: 40 }
    );

    const output = concat(chunks);
    const loaded = await PDFDocument.load(output);
    expect(result.pageCount).toBeGreaterThan(10);
    expect(loaded.getPageCount()).toBe(result.pageCount);
    expect(result.dom.emittedRoots).toBeGreaterThan(10);
    expect(result.dom.maxPendingRoots).toBeLessThan(20);
    expect(result.dom.maxBufferedNodes).toBeLessThan(150);
    expect(result.preflight.htmlBytes).toBe(new TextEncoder().encode(source).byteLength);
  });

  it("streams one long table in bounded row-group fragments", async () => {
    const source = `<table><tbody>${Array.from(
      { length: 500 },
      (_, index) => `<tr><td>Row ${index}</td><td>${index}</td></tr>`
    ).join("")}</tbody></table>`;
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const chunks: Uint8Array[] = [];
    const result = await streamHtmlToPdf(
      () => inputChunks(source, 128),
      new WritableStream({
        write(chunk) {
          chunks.push(chunk);
        }
      }),
      { pdf, font, width: 532, margin: 40, fragmentChildren: 16 }
    );

    expect(result.pageCount).toBeGreaterThan(1);
    expect(result.dom.emittedRoots).toBeGreaterThan(10);
    expect(result.dom.maxBufferedNodes).toBeLessThan(200);
    expect((await PDFDocument.load(concat(chunks))).getPageCount()).toBe(result.pageCount);
  });

  it("finishes resource preparation before writing PDF bytes", async () => {
    const source = `<style>.prepared { background-image: url("paper.png"); filter: blur(2px) }</style>
      <p class="prepared">Prepared before output</p>`;
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    let prepared = false;
    const result = await streamHtmlToPdf(
      () => inputChunks(source, 7),
      new WritableStream({
        write() {
          expect(prepared).toBe(true);
        }
      }),
      {
        pdf,
        font,
        width: 532,
        diagnostics: { unsupportedCss: true },
        prepare(preflight) {
          expect([...preflight.assetUrls]).toEqual(["paper.png"]);
          prepared = true;
        }
      }
    );

    expect(prepared).toBe(true);
    expect(result.pageCount).toBe(1);
    expect(result.diagnostics?.unsupportedCss[0]?.property).toBe("filter");
  });
});

async function* inputChunks(source: string, size: number): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(source);
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.slice(offset, offset + size);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
