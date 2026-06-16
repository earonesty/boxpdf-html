export type {
  FontStyle,
  FontWeight,
  HtmlFontRequest,
  HtmlFontResolver,
  HtmlDiagnostics,
  HtmlDiagnosticsOptions,
  HtmlProfileEvent,
  HtmlProfileCallback,
  HtmlToBoxpdfOptions,
  HtmlUnsupportedCss,
  ParsedHtml,
  RenderResult
} from "./types.js";
export type { FontFamilyFace, FontFamilyMap } from "./font.js";

import { parseStylesheets } from "./css.js";
import { parseHtml } from "./dom.js";
import { renderStyledTree } from "./render.js";
import { computeStyles, defaultStyle } from "./style.js";
import type { CssDeclaration, HtmlDiagnostics, HtmlNode, HtmlProfileEvent, HtmlToBoxpdfOptions, RenderResult, StyledNode } from "./types.js";
import type { Node as BoxNode } from "boxpdf";

export function htmlToBoxpdf(html: string, options: HtmlToBoxpdfOptions): RenderResult {
  const startedAt = now();
  const profile = (event: Omit<HtmlProfileEvent, "elapsedMs">): void => {
    options.profile?.({ ...event, elapsedMs: now() - startedAt });
  };
  profile({ phase: "start", htmlBytes: byteLength(html) });
  const parsed = parseHtml(html);
  profile({ phase: "parse-html", domNodes: countDomNodes(parsed.root), stylesheets: parsed.stylesheets.length });
  const rules = parseStylesheets(parsed.stylesheets);
  profile({ phase: "parse-css", cssRules: rules.length });
  const diagnostics = createDiagnostics(options);
  const styled = computeStyles(parsed.root, rules, {
    ...defaultStyle(options.defaultFontSize ?? 12),
    color: options.defaultColor,
    lineHeight: options.defaultLineHeight
  }, options.width, diagnostics ? (declaration) => diagnostics.recordUnsupportedCss(declaration) : undefined);
  profile({ phase: "compute-styles", styledNodes: countStyledNodes(styled) });
  const result = renderStyledTree(styled, options);
  if (diagnostics) result.diagnostics = diagnostics.toJSON();
  profile({ phase: "render-tree", ...countBoxNodes(result.nodes) });
  profile({ phase: "finish" });
  return result;
}

function createDiagnostics(options: HtmlToBoxpdfOptions): { recordUnsupportedCss: (declaration: CssDeclaration) => void; toJSON: () => HtmlDiagnostics } | undefined {
  if (!options.diagnostics?.unsupportedCss) return undefined;
  const sampleLimit = options.diagnostics.sampleLimit ?? 3;
  const unsupported = new Map<string, { property: string; value: string; count: number; samples: string[] }>();
  return {
    recordUnsupportedCss(declaration) {
      const property = declaration.property.trim().toLowerCase();
      const value = declaration.value.trim();
      const key = `${property}\n${value}`;
      const entry = unsupported.get(key) ?? { property, value, count: 0, samples: [] };
      entry.count += 1;
      const sample = declaration.selector ? `${declaration.selector} { ${property}: ${value} }` : `${property}: ${value}`;
      if (entry.samples.length < sampleLimit && !entry.samples.includes(sample)) entry.samples.push(sample);
      unsupported.set(key, entry);
    },
    toJSON() {
      return {
        unsupportedCss: [...unsupported.values()]
          .sort((a, b) => b.count - a.count || a.property.localeCompare(b.property))
          .map(({ property, value, count, samples }) => ({ property, value, count, samples: samples.length > 0 ? samples : undefined }))
      };
    }
  };
}

export { parseHtml };
export { fontFamily } from "./font.js";
export { htmlToPdf, type HtmlToPdfOptions } from "./pdf.js";

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function byteLength(value: string): number {
  return typeof TextEncoder === "undefined" ? value.length : new TextEncoder().encode(value).length;
}

function countDomNodes(node: HtmlNode): number {
  if (node.kind === "text") return 1;
  return 1 + node.children.reduce((sum, child) => sum + countDomNodes(child), 0);
}

function countStyledNodes(node: StyledNode): number {
  if ("text" in node) return 1;
  return 1 + node.children.reduce((sum, child) => sum + countStyledNodes(child), 0);
}

function countBoxNodes(nodes: BoxNode[]): { boxNodes: number; paragraphs: number; textRuns: number } {
  return nodes.reduce(
    (sum, node) => {
      const counted = countBoxNode(node);
      return {
        boxNodes: sum.boxNodes + counted.boxNodes,
        paragraphs: sum.paragraphs + counted.paragraphs,
        textRuns: sum.textRuns + counted.textRuns
      };
    },
    { boxNodes: 0, paragraphs: 0, textRuns: 0 }
  );
}

function countBoxNode(node: BoxNode): { boxNodes: number; paragraphs: number; textRuns: number } {
  let out = {
    boxNodes: 1,
    paragraphs: node.kind === "paragraph" ? 1 : 0,
    textRuns: node.kind === "paragraph" ? node.runs.filter((run) => "text" in run).length : node.kind === "text" ? 1 : 0
  };
  if ("children" in node) {
    for (const child of node.children) {
      const counted = countBoxNode(child);
      out = {
        boxNodes: out.boxNodes + counted.boxNodes,
        paragraphs: out.paragraphs + counted.paragraphs,
        textRuns: out.textRuns + counted.textRuns
      };
    }
  }
  return out;
}
