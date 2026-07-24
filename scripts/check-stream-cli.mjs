import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const cli = resolve(root, "dist/cli.js");
const fixture = resolve(root, "fixtures/alpha-mvp.html");
const tempRoot = mkdtempSync(join(tmpdir(), "boxpdf-html-stream-cli-"));

try {
  const css = join(tempRoot, "extra.css");
  const bufferedPdf = join(tempRoot, "buffered.pdf");
  const streamedPdf = join(tempRoot, "streamed.pdf");
  writeFileSync(css, "p { color: #9f1239; }");
  run([cli, fixture, bufferedPdf, "--css", css]);
  run([cli, fixture, streamedPdf, "--css", css, "--stream"]);
  comparePages(bufferedPdf, streamedPdf);

  const stdinPdf = join(tempRoot, "stdin.pdf");
  const stdin = spawnSync(process.execPath, [cli, "-", stdinPdf, "--stream"], {
    input: readFileSync(fixture),
    encoding: "utf8"
  });
  if (stdin.status !== 0) {
    throw new Error(`streamed stdin failed: ${stdin.stderr || `exit ${stdin.status}`}`);
  }
  if ((await PDFDocument.load(readFileSync(stdinPdf))).getPageCount() !== 1) {
    throw new Error("streamed stdin did not produce one PDF page");
  }

  const protectedOutput = join(tempRoot, "protected.pdf");
  const sentinel = "existing output";
  const invalid = join(tempRoot, "atomic-overflow.html");
  writeFileSync(protectedOutput, sentinel);
  writeFileSync(
    invalid,
    `<p>${"<span>x</span>".repeat(100_100)}</p>`
  );
  const failed = spawnSync(process.execPath, [cli, invalid, protectedOutput, "--stream"], {
    encoding: "utf8"
  });
  if (failed.status === 0 || !failed.stderr.includes("atomic layout exceeded")) {
    throw new Error(`expected bounded atomic failure, got: ${failed.stderr || `exit ${failed.status}`}`);
  }
  if (readFileSync(protectedOutput, "utf8") !== sentinel) {
    throw new Error("failed streamed conversion replaced the existing output");
  }
  if (readdirSync(tempRoot).some((name) => name.startsWith(".protected.pdf-"))) {
    throw new Error("failed streamed conversion left a partial output directory");
  }

  console.log("streamed CLI: file, CSS, stdin, parity, and failure cleanup pass");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function run(args) {
  execFileSync(process.execPath, args, { stdio: "pipe" });
}

function comparePages(bufferedPdf, streamedPdf) {
  const bufferedPages = rasterize(bufferedPdf, join(tempRoot, "buffered"));
  const streamedPages = rasterize(streamedPdf, join(tempRoot, "streamed"));
  if (bufferedPages.length !== streamedPages.length) {
    throw new Error(`CLI page count differs (${bufferedPages.length} buffered, ${streamedPages.length} streamed)`);
  }
  for (let index = 0; index < bufferedPages.length; index += 1) {
    if (!readFileSync(bufferedPages[index]).equals(readFileSync(streamedPages[index]))) {
      throw new Error(`CLI page ${index + 1} differs`);
    }
  }
}

function rasterize(pdf, prefix) {
  execFileSync("pdftoppm", ["-png", "-r", "144", pdf, prefix], { stdio: "pipe" });
  const stem = prefix.slice(prefix.lastIndexOf("/") + 1);
  return readdirSync(dirname(prefix))
    .filter((name) => name.startsWith(`${stem}-`) && name.endsWith(".png"))
    .sort((left, right) => pageNumber(left) - pageNumber(right))
    .map((name) => join(dirname(prefix), name));
}

function pageNumber(name) {
  const match = name.match(/-(\d+)\.png$/);
  if (!match) throw new Error(`unexpected raster filename: ${name}`);
  return Number(match[1]);
}
