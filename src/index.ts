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
import { createDiagnostics } from "./diagnostics.js";
import { parseHtml } from "./dom.js";
import { renderStyledTree } from "./render.js";
import { computeStyles, defaultStyle } from "./style.js";
import type { HtmlNode, HtmlProfileEvent, HtmlToBoxpdfOptions, RenderResult, StyledNode } from "./types.js";
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
  const diagnostics = createDiagnostics(options.diagnostics);
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

export { parseHtml };
export { fontFamily } from "./font.js";
export { htmlToPdf, type HtmlToPdfOptions } from "./pdf.js";
export {
  streamHtmlToPdf,
  type HtmlStreamSource,
  type StreamHtmlToPdfOptions,
  type StreamHtmlToPdfResult
} from "./stream/pdf.js";

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
