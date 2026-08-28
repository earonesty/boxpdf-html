import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { PageSizes, pageContent, renderFlow, type PageSize } from "@boxpdf/writer";
import { fontFamily, htmlToBoxpdf } from "./index.js";
import { injectCss, loadFaces, loadImages, resolveAssetUrl } from "./render-file.js";

/**
 * Hand-rolled JSON-RPC / stdio MCP server for boxpdf-html. No SDK dependency —
 * keeps the package lean and the transport identical to core's `boxpdf mcp`.
 *
 * It is the batteries-included agent server: the `html_to_pdf` tool for the
 * one-shot path, plus `boxpdf_docs` and resources that surface BOTH the
 * boxpdf-html and boxpdf library docs (read from the installed `boxpdf`
 * package), so an agent never has to wire up a second server.
 */

const PROTOCOL_VERSION = "2025-11-25";
const INLINE_BYTE_CAP = 1_000_000;
const CORE_TEMPLATES = ["receipt", "boarding-pass", "resume", "order-confirmation", "certificate"] as const;
const DOC_TOPICS = ["quickstart", "fonts", "themes", "tables", "pagination", "streaming", "html-api", "cloudflare"] as const;

type DocTopic = (typeof DOC_TOPICS)[number];

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// Writer package docs (it ships README + templates).
// ---------------------------------------------------------------------------

function coreDir(): string | undefined {
  // The writer's `exports` map blocks resolving package.json directly,
  // so resolve the entry point and climb to the package root.
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve("@boxpdf/writer"));
    for (let i = 0; i < 8; i += 1) {
      const pkg = resolve(dir, "package.json");
      if (existsSync(pkg)) {
        try {
          const name = (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name;
          if (name === "@boxpdf/writer" || name === "boxpdf") return dir;
        } catch {
          // keep climbing
        }
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function coreReadme(): string | undefined {
  const dir = coreDir();
  if (!dir) return undefined;
  const path = resolve(dir, "README.md");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function coreTemplate(name: string): string | undefined {
  const dir = coreDir();
  if (!dir) return undefined;
  const path = resolve(dir, "templates", `${name}.ts`);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8")
    .replaceAll('from "../src/index.js"', 'from "@boxpdf/writer"')
    .replaceAll(`new URL("../fixtures/${name}.pdf", import.meta.url)`, `new URL("./${name}.pdf", import.meta.url)`)
    .replaceAll(`wrote fixtures/${name}.pdf`, `wrote ${name}.pdf`);
}

function htmlReadme(): string | undefined {
  try {
    const path = resolve(dirname(new URL(import.meta.url).pathname), "..", "README.md");
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

interface Resource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

function resources(): Resource[] {
  const list: Resource[] = [
    { uri: "boxpdf-html://guide", name: "Agent guide", description: "How to turn HTML into a PDF with boxpdf-html, and when to drop to the boxpdf library.", mimeType: "text/markdown" },
    { uri: "boxpdf-html://readme", name: "boxpdf-html README", description: "Full boxpdf-html README: CLI, htmlToPdf, htmlToBoxpdf, fonts, Tailwind, supported CSS.", mimeType: "text/markdown" },
    { uri: "boxpdf://readme", name: "boxpdf README", description: "Full boxpdf README: layout DSL, themes, fonts, pagination, streaming.", mimeType: "text/markdown" }
  ];
  for (const name of CORE_TEMPLATES) {
    list.push({ uri: `boxpdf://templates/${name}`, name: `${name}.ts`, description: `Copy-paste boxpdf ${name} template source.`, mimeType: "text/typescript" });
  }
  return list;
}

function readResource(uri: string): { uri: string; mimeType: string; text: string } | undefined {
  if (uri === "boxpdf-html://guide") return { uri, mimeType: "text/markdown", text: docText("quickstart") + "\n\n" + docText("html-api") };
  if (uri === "boxpdf-html://readme") {
    const text = htmlReadme();
    return text ? { uri, mimeType: "text/markdown", text } : undefined;
  }
  if (uri === "boxpdf://readme") {
    const text = coreReadme();
    return text ? { uri, mimeType: "text/markdown", text } : undefined;
  }
  const prefix = "boxpdf://templates/";
  if (uri.startsWith(prefix)) {
    const text = coreTemplate(uri.slice(prefix.length));
    return text ? { uri, mimeType: "text/typescript", text } : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tools(): ToolDef[] {
  return [
    {
      name: "html_to_pdf",
      description:
        "Render an HTML string (optionally with extra CSS) to a PDF using boxpdf-html. Supports a practical subset of CSS — flex, grid, tables, borders, colors, typography, and compiled Tailwind. No browser or JS execution. Returns the PDF (written to outputPath, or inline as a base64 resource) plus any warnings and unsupported-CSS diagnostics so you can fix the input.",
      inputSchema: {
        type: "object",
        required: ["html"],
        properties: {
          html: { type: "string", description: "HTML markup. May include <style> blocks and inline styles." },
          css: { type: "string", description: "Extra stylesheet injected before render (e.g. compiled Tailwind output)." },
          outputPath: { type: "string", description: "Where to write the PDF (cwd-relative ok). If omitted, the PDF is returned inline as a base64 resource." },
          size: { type: "string", enum: Object.keys(PageSizes), default: "Letter", description: "Page size." },
          margin: { type: "number", default: 40, description: "Page margin in PDF points." },
          baseUrl: { type: "string", description: "Directory or URL for resolving relative <img> and background-image URLs. Defaults to the working directory." },
          fonts: {
            type: "object",
            description: "Optional TTF/OTF file paths to embed instead of the built-in Helvetica family.",
            properties: {
              regular: { type: "string" },
              bold: { type: "string" },
              italic: { type: "string" },
              boldItalic: { type: "string" }
            }
          },
          allowRemote: { type: "boolean", default: false, description: "Allow fetching http(s) images. Off by default to prevent SSRF." },
          debug: { type: "boolean", default: false, description: "Draw boxpdf debug overlays." }
        }
      }
    },
    {
      name: "boxpdf_docs",
      description:
        "Get focused guidance on using the boxpdf / boxpdf-html libraries directly when html_to_pdf is not enough — custom layout, pagination, tables, fonts, themes, streaming, the HTML API, or Cloudflare Workers.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", enum: [...DOC_TOPICS], default: "quickstart", description: "Documentation topic. Defaults to quickstart." }
        }
      }
    }
  ];
}

interface ToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name === "html_to_pdf") return htmlToPdfTool(args);
  if (name === "boxpdf_docs") return docsTool(args);
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

function docsTool(args: Record<string, unknown>): ToolResult {
  const topic = (typeof args.topic === "string" ? args.topic : "quickstart") as DocTopic;
  if (!DOC_TOPICS.includes(topic)) {
    return { content: [{ type: "text", text: `Unknown topic "${topic}". Available: ${DOC_TOPICS.join(", ")}.` }], isError: true };
  }
  return { content: [{ type: "text", text: docText(topic) }] };
}

async function htmlToPdfTool(args: Record<string, unknown>): Promise<ToolResult> {
  if (typeof args.html !== "string" || args.html.length === 0) {
    return { content: [{ type: "text", text: "html_to_pdf requires a non-empty `html` string." }], isError: true };
  }
  const sizeKey = typeof args.size === "string" ? args.size : "Letter";
  const size = (PageSizes as Record<string, PageSize>)[sizeKey];
  if (!size) {
    return { content: [{ type: "text", text: `Unknown size "${sizeKey}". Available: ${Object.keys(PageSizes).join(", ")}.` }], isError: true };
  }
  const margin = typeof args.margin === "number" ? args.margin : 40;
  const baseUrl = typeof args.baseUrl === "string" ? resolve(args.baseUrl) : process.cwd();
  const fonts = (args.fonts ?? {}) as Record<string, string | undefined>;
  const warnings: string[] = [];

  const html = injectCss(args.html, typeof args.css === "string" ? [args.css] : []);
  const pdf = await PDFDocument.create();
  const faces = await loadFaces(
    pdf,
    { font: fonts.regular, boldFont: fonts.bold, italicFont: fonts.italic, boldItalicFont: fonts.boldItalic },
    baseUrl
  );
  const images = await loadImages(pdf, html, baseUrl, {
    allowRemote: args.allowRemote === true,
    onWarn: (message) => warnings.push(message)
  });

  const result = htmlToBoxpdf(html, {
    font: faces.normal,
    boldFont: faces.bold,
    italicFont: faces.italic,
    resolveFont: fontFamily(faces.families),
    resolveImage: ({ url }) => images.get(resolveAssetUrl(url, baseUrl)),
    baseUrl,
    width: pageContent(size, margin).width,
    diagnostics: { unsupportedCss: true, sampleLimit: 5 }
  });
  warnings.push(...result.warnings);

  const { pages } = await renderFlow(pdf, result.nodes, { margin, size, debug: args.debug === true, warnings: false });
  const bytes = await pdf.save();
  const unsupported = result.diagnostics?.unsupportedCss ?? [];

  const lines: string[] = [];
  const structured: Record<string, unknown> = {
    bytes: bytes.length,
    pages: pages.length,
    warnings,
    unsupportedCss: unsupported.map(({ property, value, count }) => ({ property, value, count }))
  };

  const content: Array<Record<string, unknown>> = [];
  if (typeof args.outputPath === "string" && args.outputPath.length > 0) {
    const out = resolve(args.outputPath);
    writeFileSync(out, bytes);
    structured.outputPath = out;
    lines.push(`Wrote ${out} — ${bytes.length} bytes, ${pages.length} page${pages.length === 1 ? "" : "s"}.`);
  } else if (bytes.length > INLINE_BYTE_CAP) {
    lines.push(
      `Rendered ${bytes.length} bytes across ${pages.length} page${pages.length === 1 ? "" : "s"}, which is too large to return inline. ` +
        "Re-run with an `outputPath` to write the file instead."
    );
  } else {
    lines.push(`Rendered ${bytes.length} bytes, ${pages.length} page${pages.length === 1 ? "" : "s"}.`);
    content.push({
      type: "resource",
      resource: { uri: "boxpdf-html://render.pdf", mimeType: "application/pdf", blob: Buffer.from(bytes).toString("base64") }
    });
  }

  if (warnings.length > 0) lines.push("", "Warnings:", ...warnings.map((w) => `- ${w}`));
  if (unsupported.length > 0) {
    lines.push("", "Unsupported CSS (rendered without these declarations):");
    for (const item of unsupported) lines.push(`- ${item.property}: ${item.value} (${item.count}×)`);
  }

  content.unshift({ type: "text", text: lines.join("\n") });
  return { content, structuredContent: structured };
}

// ---------------------------------------------------------------------------
// Docs content
// ---------------------------------------------------------------------------

function docText(topic: DocTopic): string {
  return DOCS[topic];
}

const DOCS: Record<DocTopic, string> = {
  quickstart: `# boxpdf quickstart (library)

Shortest path to bytes — no pdf-lib import, no manual save:

\`\`\`ts
import { cleanTheme, flowToPdf, hline, hstack, standardFonts, text, vstack } from "@boxpdf/writer";

const bytes = await flowToPdf(async (pdf) => {
  const { font, bold } = await standardFonts(pdf); // built-in Helvetica family
  const t = cleanTheme({ font, bold });
  return [
    vstack({ gap: 8 }, text("Receipt #18472", t.type.h1), text("May 14, 2026", t.type.caption)),
    hline(t.hr),
    hstack({ gap: 16, justify: "between", width: 515 },
      text("Wool socks", t.type.body),
      text("$28.00", { ...t.type.body, font: bold, align: "right", width: 80 }))
  ];
});
\`\`\`

\`standardFonts(pdf, family?)\` returns \`{ font, bold, italic, boldItalic }\` (family: "helvetica" | "times" | "courier"). \`flowToPdf(build, options?)\` owns create + paginate + save. For multiple render passes use \`renderFlow(pdf, nodes, options)\` and call \`pdf.save()\` yourself.`,

  fonts: `# Fonts

- Built-in (no bytes): \`const fonts = await standardFonts(pdf)\` → drop into any theme.
- Custom TTF/OTF: \`const font = await loadFont(pdf, source)\` where source is bytes, a URL, a data URL, or a base64 string.
- Bundled Inter: \`import { embedInter } from "boxpdf/inter"; const { font, bold } = await embedInter(pdf);\`
- Tabular figures for money columns: \`loadFont(pdf, bytes, { features: { tnum: true } })\` or \`embedInter(pdf, { tabularFigures: true })\`.
- Generate a bundled font module: \`npx boxpdf font add ./Acme-Regular.ttf=regular --out src/fonts/acme.ts\`.`,

  themes: `# Themes

\`cleanTheme\`, \`stripeTheme\`, \`editorialTheme\`, \`brutalistTheme\`. Each accepts a \`{ font, bold, italic? }\` object (what \`standardFonts\`/\`embedInter\` return) or positional fonts:

\`\`\`ts
const t = cleanTheme(await standardFonts(pdf));
const serif = editorialTheme(await standardFonts(pdf, "times"));
\`\`\`

Every theme exposes \`colors\`, \`spacing\`, \`radii\`, \`type\` (display/h1/h2/h3/body/bodySmall/caption/label), \`card\`, \`hr\`.`,

  tables: `# Tables

\`table({ columns, rows, ... })\` with fixed / auto / fractional columns, header & footer rows, dividers, colSpan, styled cells, per-side borders, vertical alignment, and row-level page fragmentation under \`renderFlow\` (headers repeat on continuation pages).

\`\`\`ts
table({
  columns: [{ width: "auto" }, { width: "1fr" }, { width: 80 }],
  header: [text("Qty", t.type.label), text("Item", t.type.label), text("Total", t.type.label)],
  rows: items.map((i) => [text(String(i.qty)), text(i.name), text(formatCurrency(i.total), { align: "right" })])
});
\`\`\``,

  pagination: `# Pagination

\`renderFlow(pdf, nodes[], options)\` paginates top-level children. Top-level \`vstack\` nodes fragment between children; \`table()\` fragments between rows. Use \`keepTogether(...)\` or \`breakInside: "avoid"\` to keep a block atomic.

Options: \`size\` (default Letter; \`PageSizes.A4\` etc.), \`margin\`, \`header\`/\`footer\` (receive \`{ pageNumber, totalPages }\`), \`reserveBottom\`, document metadata (\`title\`/\`author\`/...), \`debug\`. For one page, \`renderToPdf(node, options)\` returns bytes directly.`,

  streaming: `# Streaming (memory-bounded)

For long documents use \`streamFlow(pdf, writable, asyncIterable, options)\` — it writes PDF bytes to a \`WritableStream<Uint8Array>\` as each page closes, keeping peak heap flat regardless of page count.

\`\`\`ts
const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
streamFlow(pdf, writable, generate(font, bold)).catch(console.error);
return new Response(readable, { headers: { "content-type": "application/pdf" } });
\`\`\`

All \`embedFont\`/\`embedPng\`/\`embedJpg\` calls must finish before \`streamFlow\`. \`totalPages\` is unavailable in headers/footers when streaming — use \`renderFlow\` if you need "Page X of Y". For Node, wrap a \`stream.Writable\` with \`nodeAdapter\`.`,

  "html-api": `# HTML → PDF (boxpdf-html, as a library)

One call to bytes (fonts default to Helvetica):

\`\`\`ts
import { htmlToPdf } from "@boxpdf/html-reader";
const bytes = await htmlToPdf("<h1>Invoice</h1><p>Thanks!</p>");
\`\`\`

For the nodes, warnings, and diagnostics (full control), use \`htmlToBoxpdf\` + \`renderFlow\`:

\`\`\`ts
import { fontFamily, htmlToBoxpdf } from "@boxpdf/html-reader";
import { renderFlow } from "@boxpdf/writer";
const result = htmlToBoxpdf(html, { font, boldFont, resolveFont: fontFamily({ Inter: { normal: font, bold: boldFont } }), width: 532 });
await renderFlow(pdf, result.nodes, { margin: 40 });
\`\`\`

\`width\` is the CSS containing-block width in points (Letter − 2×margin). Supported CSS is a practical subset (flex, grid, tables, borders, type, Tailwind output); pass \`diagnostics: { unsupportedCss: true }\` to see what was dropped.`,

  cloudflare: `# Cloudflare Workers / edge

Both boxpdf and \`boxpdf/inter\` run on Workers without \`nodejs_compat\`. No headless browser, WASM, or native deps.

\`\`\`ts
import { cleanTheme, flowToPdf, standardFonts, text } from "@boxpdf/writer";

export default {
  async fetch() {
    const bytes = await flowToPdf(async (pdf) => {
      const t = cleanTheme(await standardFonts(pdf));
      return [text("Generated at the edge.", t.type.body)];
    });
    return new Response(bytes, { headers: { "content-type": "application/pdf" } });
  }
};
\`\`\``
};

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

function ok(id: string | number, value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: value };
}

function err(id: string | number, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/**
 * Handle one JSON-RPC request and return the response (or undefined for
 * notifications / messages without an id). Pure and side-effect-free except
 * for the `html_to_pdf` tool's file I/O — exported for tests.
 */
export async function dispatch(message: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
  if (!message.method || message.id === undefined) return undefined;
  const id = message.id;

  switch (message.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { resources: {}, tools: {} },
        serverInfo: { name: "boxpdf-html", title: "boxpdf-html", version: "1.0.0", description: "HTML-to-PDF tool plus boxpdf library docs and templates." },
        instructions:
          "Call html_to_pdf to render HTML (and optional CSS) to a PDF. Read its warnings and unsupportedCss to fix the input. Call boxpdf_docs (or read the resources) when you need to build PDFs with the boxpdf library directly."
      });
    case "ping":
      return ok(id, {});
    case "resources/list":
      return ok(id, { resources: resources() });
    case "resources/read": {
      const uri = readUri(message.params);
      if (!uri) return err(id, -32602, "Missing resource URI");
      const resource = readResource(uri);
      if (!resource) return err(id, -32002, "Resource not found", { uri });
      return ok(id, { contents: [resource] });
    }
    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] });
    case "tools/list":
      return ok(id, { tools: tools() });
    case "tools/call": {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") return err(id, -32602, "Missing tool name");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return ok(id, await callTool(params.name, args));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return ok(id, { content: [{ type: "text", text: `Error: ${text}` }], isError: true });
      }
    }
    case "prompts/list":
      return ok(id, { prompts: [] });
    default:
      return err(id, -32601, `Method not found: ${message.method}`);
  }
}

function readUri(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || !("uri" in params)) return undefined;
  const uri = (params as { uri?: unknown }).uri;
  return typeof uri === "string" ? uri : undefined;
}

export function startMcpServer(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch (error) {
      process.stdout.write(`${JSON.stringify(err(0, -32700, "Parse error", error instanceof Error ? error.message : String(error)))}\n`);
      return;
    }
    void dispatch(message).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
}
