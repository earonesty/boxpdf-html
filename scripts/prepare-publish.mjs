#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = join(root, ".pack");
const npmCache = join(stageRoot, ".npm-cache");
const args = new Set(process.argv.slice(2));
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const writerVersion = process.env.BOXPDF_WRITER_VERSION ?? "^1.13.0";
const packages = [
  { name: "@boxpdf/html-reader", directory: "html-reader" },
  { name: "boxpdf-html", directory: "boxpdf-html" },
];

if (writerVersion.startsWith("file:") || writerVersion.startsWith("npm:")) {
  throw new Error(`Refusing to publish with invalid @boxpdf/writer dependency: ${writerVersion}`);
}

const manifestFor = (name) => ({
  ...rootPackage,
  name,
  scripts: undefined,
  dependencies: {
    ...rootPackage.dependencies,
    "@boxpdf/writer": writerVersion,
  },
});

if (args.has("--verify")) {
  for (const target of packages) verifyManifest(manifestFor(target.name));
  console.log(`publish manifests depend on @boxpdf/writer ${writerVersion}`);
  process.exit(0);
}

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });

for (const target of packages) {
  const directory = join(stageRoot, target.directory);
  mkdirSync(directory, { recursive: true });
  for (const path of ["README.md", "LICENSE", "dist"]) {
    const source = join(root, path);
    if (existsSync(source)) cpSync(source, join(directory, path), { recursive: true });
  }
  const manifest = manifestFor(target.name);
  verifyManifest(manifest);
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (args.has("--pack") || args.has("--publish")) {
  for (const target of packages) {
    if (args.has("--publish") && isPublished(target.name, rootPackage.version)) {
      console.log(`${target.name}@${rootPackage.version} is already published; skipping`);
      continue;
    }
    const directory = join(stageRoot, target.directory);
    const commandArgs = args.has("--publish")
      ? ["publish", "--provenance", "--access", "public"]
      : ["pack", "--pack-destination", stageRoot];
    const result = spawnSync("npm", commandArgs, {
      cwd: directory,
      stdio: "inherit",
      shell: false,
      env: { ...process.env, npm_config_cache: npmCache },
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

console.log(`prepared ${packages.map((target) => target.name).join(" and ")} ${rootPackage.version}`);

function verifyManifest(manifest) {
  const serialized = JSON.stringify(manifest);
  if (serialized.includes("\"file:")) {
    throw new Error(`Refusing to prepare ${manifest.name}: manifest contains a file: dependency`);
  }
  if (manifest.dependencies.boxpdf) {
    throw new Error(`Refusing to prepare ${manifest.name}: legacy boxpdf dependency remains`);
  }
}

function isPublished(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, npm_config_cache: npmCache },
  });
  if (result.status === 0) return true;
  if (`${result.stdout ?? ""}\n${result.stderr ?? ""}`.includes("E404")) return false;
  process.stderr.write(result.stderr ?? result.stdout ?? "npm view failed\n");
  process.exit(result.status ?? 1);
}
