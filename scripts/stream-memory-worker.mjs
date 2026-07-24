import { createReadStream } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { streamHtmlToPdf } from "../dist/index.js";

const input = process.argv[2];
if (!input) throw new Error("usage: stream-memory-worker.mjs <input.html>");

global.gc?.();
let peakHeap = 0;
let peakRss = 0;
const sample = () => {
  const memory = process.memoryUsage();
  peakHeap = Math.max(peakHeap, memory.heapUsed);
  peakRss = Math.max(peakRss, memory.rss);
};
const timer = setInterval(sample, 5);

try {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const result = await streamHtmlToPdf(
    () => sampledSource(input),
    new WritableStream({
      write() {
        sample();
      }
    }),
    { pdf, font, width: 532, margin: 40 }
  );
  sample();
  global.gc?.();
  const retainedHeap = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({
    htmlBytes: result.preflight.htmlBytes,
    pageCount: result.pageCount,
    peakHeap,
    peakRss,
    retainedHeap,
    dom: result.dom
  }));
} finally {
  clearInterval(timer);
}

async function* sampledSource(path) {
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    sample();
    yield chunk;
  }
}
