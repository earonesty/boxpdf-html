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
