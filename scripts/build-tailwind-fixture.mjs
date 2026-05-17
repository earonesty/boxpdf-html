import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const inputCss = resolve(root, "fixtures/tailwind-input.css");
const fixtures = [
  ["fixtures/tailwind-invoice-source.html", "fixtures/tailwind-invoice.html"],
  ["fixtures/tailwind-utilities-source.html", "fixtures/tailwind-utilities.html"]
];
const tempRoot = mkdtempSync(join(tmpdir(), "boxpdf-html-tailwind-"));
const outputCss = join(tempRoot, "tailwind.css");

try {
  run(resolve(root, "node_modules/.bin/tailwindcss"), ["-i", inputCss, "-o", outputCss, "--minify"], root);
  const css = readFileSync(outputCss, "utf8");
  for (const [sourceFile, outputFile] of fixtures) {
    const sourcePath = resolve(root, sourceFile);
    const outputHtml = resolve(root, outputFile);
    const source = readFileSync(sourcePath, "utf8");
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(source)?.[1]?.trim() ?? source;
    writeFileSync(
      outputHtml,
      `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
${css}
  </style>
</head>
<body>
${body}
</body>
</html>
`
    );
    console.log(`wrote ${outputHtml}`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
