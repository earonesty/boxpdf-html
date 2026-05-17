#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, ".pack");
const npmCache = join(stage, ".npm-cache");
const args = new Set(process.argv.slice(2));

const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const parentPkgPath = resolve(root, "..", "package.json");
const parentPkg = existsSync(parentPkgPath)
  ? JSON.parse(readFileSync(parentPkgPath, "utf8"))
  : undefined;
const boxpdfVersion = process.env.BOXPDF_DEP_VERSION ?? `^${parentPkg?.version ?? "1.6.1"}`;

if (!boxpdfVersion || boxpdfVersion.startsWith("file:")) {
  throw new Error(`Refusing to prepare package with invalid boxpdf dependency: ${boxpdfVersion}`);
}

const publishPkg = {
  ...rootPkg,
  scripts: undefined,
  dependencies: {
    ...rootPkg.dependencies,
    boxpdf: boxpdfVersion
  }
};

if (JSON.stringify(publishPkg).includes("\"file:")) {
  throw new Error("Refusing to prepare package: publish manifest still contains a file: dependency");
}

if (args.has("--verify")) {
  console.log(`publish manifest dependency: boxpdf ${publishPkg.dependencies.boxpdf}`);
  process.exit(0);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const path of ["README.md", "LICENSE", "dist"]) {
  const source = join(root, path);
  if (!existsSync(source)) continue;
  cpSync(source, join(stage, path), { recursive: true });
}
writeFileSync(join(stage, "package.json"), `${JSON.stringify(publishPkg, null, 2)}\n`);

if (args.has("--pack") || args.has("--publish")) {
  const commandArgs = args.has("--publish") ? ["publish"] : ["pack"];
  const result = spawnSync("npm", commandArgs, {
    cwd: stage,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      npm_config_cache: npmCache
    }
  });
  process.exit(result.status ?? 1);
}

console.log(`prepared ${stage}`);
