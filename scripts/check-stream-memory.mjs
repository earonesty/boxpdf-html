import { spawnSync } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const worker = resolve(root, "scripts/stream-memory-worker.mjs");
const largeMode = process.argv.includes("--large");
const sizes = largeMode
  ? [10 * 1024 * 1024, 100 * 1024 * 1024]
  : [4 * 1024 * 1024, 40 * 1024 * 1024];
const tempRoot = mkdtempSync(join(tmpdir(), "boxpdf-html-stream-memory-"));

try {
  const results = [];
  for (const size of sizes) {
    const input = join(tempRoot, `${size}.html`);
    await generateHtml(input, size);
    results.push(runWorker(input));
  }

  const [small, large] = results;
  const rssRatio = large.peakRss / small.peakRss;
  const heapGrowth = large.peakHeap - small.peakHeap;
  const retainedGrowth = large.retainedHeap - small.retainedHeap;
  if (rssRatio > 2) {
    throw new Error(`peak RSS scaled with input (${formatBytes(small.peakRss)} to ${formatBytes(large.peakRss)})`);
  }
  if (heapGrowth > 64 * 1024 * 1024) {
    throw new Error(`peak heap grew by ${formatBytes(heapGrowth)} for a 10x input`);
  }
  if (retainedGrowth > 16 * 1024 * 1024) {
    throw new Error(`retained heap grew by ${formatBytes(retainedGrowth)} for a 10x input`);
  }
  for (const result of results) {
    if (result.dom.maxBufferedNodes > 160) {
      throw new Error(`DOM retained ${result.dom.maxBufferedNodes} nodes inside one streamed wrapper`);
    }
  }
  if (large.dom.emittedRoots < small.dom.emittedRoots * 8) {
    throw new Error(
      `continuation fragments did not scale with input ` +
      `(${small.dom.emittedRoots} to ${large.dom.emittedRoots})`
    );
  }

  console.log(
    `stream memory: ${formatBytes(small.htmlBytes)} -> ${formatBytes(large.htmlBytes)}, ` +
    `peak RSS ${formatBytes(small.peakRss)} -> ${formatBytes(large.peakRss)} ` +
    `(${rssRatio.toFixed(2)}x), peak heap growth ${formatBytes(heapGrowth)}, ` +
    `retained heap growth ${formatBytes(retainedGrowth)}`
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

async function generateHtml(path, targetBytes) {
  const output = createWriteStream(path);
  const header = "<!doctype html><style>.skip{display:none}</style><main>\n";
  const footer = "</main>\n";
  const record = `<p class="skip">${"bounded-stream ".repeat(72)}</p>\n`;
  let written = Buffer.byteLength(header);
  output.write(header);
  while (written + Buffer.byteLength(record) + Buffer.byteLength(footer) <= targetBytes) {
    if (!output.write(record)) await once(output, "drain");
    written += Buffer.byteLength(record);
  }
  const remaining = targetBytes - written - Buffer.byteLength(footer);
  if (remaining >= 7) output.write(`<!--${"x".repeat(remaining - 7)}-->`);
  else if (remaining > 0) output.write(" ".repeat(remaining));
  output.end(footer);
  await once(output, "close");
}

function runWorker(input) {
  const child = spawnSync(
    process.execPath,
    ["--expose-gc", "--max-old-space-size=128", worker, input],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }
  );
  if (child.status !== 0) {
    throw new Error(`memory worker failed: ${child.stderr || `exit ${child.status}`}`);
  }
  const line = child.stdout.trim().split("\n").at(-1);
  if (!line) throw new Error("memory worker returned no result");
  return JSON.parse(line);
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
