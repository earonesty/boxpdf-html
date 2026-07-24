import type { PDFDocument, PDFFont } from "pdf-lib";
import {
  PageSizes,
  streamFlow,
  type Node as BoxNode,
  type PageSize,
  type StreamFlowOptions
} from "boxpdf";
import { parseStylesheets } from "../css.js";
import { renderStyledTree } from "../render.js";
import { computeStyles, defaultStyle } from "../style.js";
import type { HtmlElementNode, HtmlNode, HtmlToBoxpdfOptions } from "../types.js";
import { visitHtmlRoots, type StreamDomStats } from "./dom.js";
import { preflightHtml, type HtmlPreflight } from "./preflight.js";

export type HtmlStreamSource = () => AsyncIterable<string | Uint8Array>;

export interface StreamHtmlToPdfOptions extends HtmlToBoxpdfOptions {
  pdf: PDFDocument;
  /**
   * Every custom font that may be selected by resolveFont. The preflight glyph
   * set is encoded into these fonts before streamFlow freezes PDF resources.
   */
  preloadFonts?: PDFFont[];
  margin?: StreamFlowOptions["margin"];
  size?: PageSize;
  debug?: boolean;
  warnings?: boolean;
}

export interface StreamHtmlToPdfResult {
  pageCount: number;
  preflight: HtmlPreflight;
  dom: StreamDomStats;
  warnings: string[];
}

/**
 * Convert a reopenable HTML byte source to PDF without retaining the complete
 * source, DOM, box tree, or PDF page list.
 */
export async function streamHtmlToPdf(
  openInput: HtmlStreamSource,
  writable: WritableStream<Uint8Array>,
  options: StreamHtmlToPdfOptions
): Promise<StreamHtmlToPdfResult> {
  const preflight = await preflightHtml(openInput());
  prepareFonts(options, preflight.glyphs);
  const rules = parseStylesheets(preflight.stylesheets);
  const warnings: string[] = [];
  const nodeStream = new TransformStream<BoxNode, BoxNode>();
  const writer = nodeStream.writable.getWriter();
  let dom: StreamDomStats | undefined;

  const producer = (async () => {
    try {
      dom = await visitHtmlRoots(openInput(), async (node) => {
        for (const rendered of renderRoot(node, rules, options, warnings)) {
          await writer.write(rendered);
        }
      });
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
      throw error;
    }
  })();

  const flowOptions: StreamFlowOptions = {
    size: options.size ?? PageSizes.Letter,
    margin: options.margin ?? 40,
    debug: options.debug,
    warnings: options.warnings
  };
  try {
    const [{ pageCount }] = await Promise.all([
      streamFlow(options.pdf, writable, nodeStream.readable, flowOptions),
      producer
    ]);
    return { pageCount, preflight, dom: dom!, warnings };
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  }
}

function renderRoot(
  node: HtmlNode,
  rules: ReturnType<typeof parseStylesheets>,
  options: StreamHtmlToPdfOptions,
  warnings: string[]
): BoxNode[] {
  const root: HtmlElementNode = {
    kind: "element",
    tag: "body",
    attrs: {},
    children: [node]
  };
  node.parent = root;
  const styled = computeStyles(
    root,
    rules,
    {
      ...defaultStyle(options.defaultFontSize ?? 12),
      color: options.defaultColor,
      lineHeight: options.defaultLineHeight
    },
    options.width
  );
  const result = renderStyledTree(styled, options);
  warnings.push(...result.warnings);
  return result.nodes;
}

function prepareFonts(options: StreamHtmlToPdfOptions, glyphs: Set<string>): void {
  const text = [...glyphs].join("");
  if (!text) return;
  const fonts = new Set<PDFFont>([
    options.font,
    ...(options.boldFont ? [options.boldFont] : []),
    ...(options.italicFont ? [options.italicFont] : []),
    ...(options.preloadFonts ?? [])
  ]);
  for (const font of fonts) font.encodeText(text);
}
