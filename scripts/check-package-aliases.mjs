#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
run(process.execPath, ["scripts/prepare-publish.mjs", "--pack"], root);
const tarballs = readdirSync(join(root, ".pack"))
  .filter((name) => name.endsWith(".tgz"))
  .map((name) => join(root, ".pack", name));
if (tarballs.length !== 2) throw new Error(`expected two package tarballs, found ${tarballs.length}`);

const temporary = mkdtempSync(join(tmpdir(), "boxpdf-html-package-aliases-"));
try {
  writeFileSync(join(temporary, "package.json"), '{"type":"module","private":true}\n');
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "@boxpdf/writer@npm:boxpdf@^1.13.0",
      ...tarballs,
    ],
    temporary,
  );
  const reader = await import(
    pathToFileURL(join(temporary, "node_modules/@boxpdf/html-reader/dist/index.js"))
  );
  const legacy = await import(pathToFileURL(join(temporary, "node_modules/boxpdf-html/dist/index.js")));
  assertEqual(Object.keys(reader).sort(), Object.keys(legacy).sort(), "ESM exports");

  const readerPackage = readPackage(join(temporary, "node_modules/@boxpdf/html-reader/package.json"));
  const legacyPackage = readPackage(join(temporary, "node_modules/boxpdf-html/package.json"));
  assertEqual(readerPackage.exports, legacyPackage.exports, "export maps");
  assertEqual(readerPackage.version, legacyPackage.version, "versions");
  assertEqual(readerPackage.dependencies, legacyPackage.dependencies, "dependencies");
  run(process.execPath, [join(temporary, "node_modules/.bin/boxpdf-html"), "--help"], temporary);
  run(process.execPath, [join(temporary, "node_modules/.bin/html-reader"), "--help"], temporary);
  console.log("scoped and legacy HTML packages expose identical APIs, dependencies, and CLIs");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function readPackage(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} differ:\n${JSON.stringify(actual)}\n${JSON.stringify(expected)}`);
  }
}
