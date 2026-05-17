import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fontFamily, htmlToBoxpdf } from "../dist/index.js";
import { loadFont, renderFlow } from "../../dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRequire = createRequire(resolve(root, "../package.json"));
const { PDFDocument } = coreRequire("pdf-lib");

const input = resolve(root, process.argv[2] ?? "fixtures/alpha-mvp.html");
const output = resolve(root, process.argv[3] ?? "artifacts/profile/boxpdf-html.pdf");
const startedAt = now();
const coreProfile = makeCoreProfileReporter();

try {
  mark("start", { input, output });
  const html = readFileSync(input, "utf8");
  mark("read-html", { bytes: byteLength(html) });

  const doc = await PDFDocument.create();
  mark("pdf-created");

  const font = await loadFont(doc, readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"));
  const boldFont = await loadFont(doc, readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"));
  const italicFont = await loadFont(doc, readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf"));
  const boldItalicFont = await loadFont(doc, readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf"));
  mark("fonts-loaded");

  const images = await embedImages(doc, html, dirname(input));
  mark("images-loaded", { count: images.size });

  const result = htmlToBoxpdf(html, {
    font,
    boldFont,
    italicFont,
    resolveFont: fontFamily({
      Helvetica: { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont },
      Arial: { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont },
      "sans-serif": { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont },
      "New York Times": { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont },
      "nyt-cheltenham": { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont },
      "nyt-franklin": { normal: font, bold: boldFont, italic: italicFont, boldItalic: boldItalicFont }
    }),
    resolveImage: ({ url }) => images.get(resolve(dirname(input), url)),
    baseUrl: dirname(input),
    width: 532,
    profile: (event) => mark(`html:${event.phase}`, event)
  });
  mark("html-to-boxpdf-finished", { warnings: result.warnings.length, nodes: result.nodes.length });
  for (const warning of result.warnings.slice(0, 20)) mark("warning", { message: warning });

  const flow = await renderFlow(doc, result.nodes, {
    margin: 40,
    warnings: false,
    profile: coreProfile
  });
  coreProfile.flush();
  mark("render-flow-finished", { pages: flow.pages.length });

  writeFileSync(output, await doc.save());
  mark("pdf-saved");
} catch (error) {
  coreProfile.flush();
  mark("error", {
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  process.exitCode = 1;
}

function mark(phase, data = {}) {
  process.stderr.write(`${JSON.stringify({ elapsedMs: Math.round((now() - startedAt) * 100) / 100, phase, ...data })}\n`);
}

function makeCoreProfileReporter() {
  const started = now();
  const stats = {
    measureEvents: 0,
    measureEnds: 0,
    resolveEnds: 0,
    maxDepth: 0,
    totalMeasureMs: 0,
    totalResolveMs: 0,
    slowMeasures: 0,
    slowResolves: 0,
    cacheHits: 0,
    byKind: new Map(),
    byDepth: new Map()
  };
  const sampleLimits = new Map();
  let lastPulse = started;
  let flushed = false;

  const reporter = (event) => {
    if (event.phase !== "measure-detail") {
      mark(`core:${event.phase}`, event);
      return;
    }

    const measure = event.measure;
    if (!measure) return;
    stats.measureEvents += 1;
    if (measure.depth !== undefined) {
      stats.maxDepth = Math.max(stats.maxDepth, measure.depth);
      increment(stats.byDepth, measure.depth);
    }

    if (measure.phase === "measure-cache-hit") {
      stats.cacheHits += 1;
      if (measure.nodeKind) increment(stats.byKind, `${measure.nodeKind}:cached`);
    } else if (measure.phase === "measure-end") {
      stats.measureEnds += 1;
      stats.totalMeasureMs += measure.durationMs ?? 0;
      if (measure.nodeKind) increment(stats.byKind, measure.nodeKind);
      if (measure.nodeKind === "vstack" && (measure.durationMs ?? 0) >= 1000 && allowSample(sampleLimits, "slow-measure", 20)) {
        stats.slowMeasures += 1;
        mark("core:slow-measure", summarizeMeasure(measure));
      }
    } else if (measure.phase === "resolve-main-end") {
      stats.resolveEnds += 1;
      stats.totalResolveMs += measure.durationMs ?? 0;
      if (((measure.durationMs ?? 0) >= 1000 || (measure.childCount ?? 0) >= 100) && allowSample(sampleLimits, "slow-resolve", 20)) {
        stats.slowResolves += 1;
        mark("core:slow-resolve-main", summarizeMeasure(measure));
      }
    }

    const elapsed = now() - lastPulse;
    if (elapsed >= 5000) {
      lastPulse = now();
      mark("core:measure-progress", summarizeStats(stats, now() - started));
    }
  };

  reporter.flush = () => {
    if (flushed) return;
    flushed = true;
    mark("core:measure-summary", summarizeStats(stats, now() - started));
  };

  return reporter;
}

function summarizeMeasure(measure) {
  return compact({
    measurePhase: measure.phase,
    nodeKind: measure.nodeKind,
    depth: measure.depth,
    parentWidth: round(measure.parentWidth),
    width: round(measure.width),
    height: round(measure.height),
    axis: measure.axis,
    childCount: measure.childCount,
    childIndex: measure.childIndex,
    availableMain: round(measure.availableMain),
    availableCross: round(measure.availableCross),
    durationMs: round(measure.durationMs)
  });
}

function summarizeStats(stats, elapsedMs) {
  return {
    coreElapsedMs: round(elapsedMs),
    measureEvents: stats.measureEvents,
    measureEnds: stats.measureEnds,
    resolveEnds: stats.resolveEnds,
    maxDepth: stats.maxDepth,
    totalMeasureMs: round(stats.totalMeasureMs),
    totalResolveMs: round(stats.totalResolveMs),
    slowMeasures: stats.slowMeasures,
    slowResolves: stats.slowResolves,
    cacheHits: stats.cacheHits,
    topKinds: topEntries(stats.byKind, 8),
    topDepths: topEntries(stats.byDepth, 8)
  };
}

function allowSample(map, key, limit) {
  const count = map.get(key) ?? 0;
  if (count >= limit) return false;
  map.set(key, count + 1);
  return true;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topEntries(map, count) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key, value]) => ({ key, value }));
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function round(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

function now() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function byteLength(value) {
  return typeof TextEncoder === "undefined" ? value.length : new TextEncoder().encode(value).length;
}

async function embedImages(doc, source, baseDir) {
  const images = new Map();
  for (const url of imageUrls(source)) {
    if (!url || /^(https?:|data:)/i.test(url)) continue;
    const imagePath = resolve(baseDir, url);
    if (!existsSync(imagePath) || images.has(imagePath)) continue;
    images.set(imagePath, await embedImage(doc, imagePath));
  }
  return images;
}

function imageUrls(source) {
  const urls = [];
  for (const match of source.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*?))\s*\)/gi)) {
    urls.push((match[1] ?? match[2] ?? match[3])?.trim());
  }
  for (const match of source.matchAll(/<(?:img|source)\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
    urls.push((match[1] ?? match[2] ?? match[3])?.trim());
  }
  for (const match of source.matchAll(/<(?:img|source)\b[^>]*\bsrcset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^>]+))/gi)) {
    const srcset = (match[1] ?? match[2] ?? match[3])?.trim();
    for (const candidate of srcset?.split(",") ?? []) {
      const [url] = candidate.trim().split(/\s+/, 1);
      if (url) urls.push(url);
    }
  }
  return urls;
}

function embedImage(doc, imagePath) {
  const bytes = readFileSync(imagePath);
  const ext = extname(imagePath).toLowerCase();
  if (ext === ".png") return doc.embedPng(bytes);
  if (ext === ".jpg" || ext === ".jpeg") return doc.embedJpg(bytes);
  return undefined;
}
