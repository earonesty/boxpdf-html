import type { PDFDocument, PDFFont } from "pdf-lib";
import {
  PageSizes,
  streamFlow,
  type Node as BoxNode,
  type PageSize,
  type StreamFlowOptions
} from "@boxpdf/writer";
import * as boxpdfCapabilities from "@boxpdf/writer";
import { parseStylesheets } from "../css.js";
import { createDiagnostics, type HtmlDiagnosticsRecorder } from "../diagnostics.js";
import { renderStyledTree } from "../render.js";
import { computeStyles, defaultStyle } from "../style.js";
import type { HtmlDiagnostics, HtmlElementNode, HtmlNode, HtmlToBoxpdfOptions } from "../types.js";
import { visitHtmlRoots, type StreamDomStats } from "./dom.js";
import { preflightHtml, type HtmlPreflight } from "./preflight.js";

export type HtmlStreamSource = () => AsyncIterable<string | Uint8Array>;

const FRAGMENT_SENSITIVE_SELECTOR =
  /(?:^|[^\\])[+~]|:(?:first|last|only|nth|nth-last)-(?:child|of-type)|:has\(/i;

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
  /** Completed children retained per ordinary streamed wrapper. Default 64. */
  fragmentChildren?: number;
  /** Hard cap for nodes retained inside atomic layout contexts. */
  maxBufferedNodes?: number;
  /** Hard cap for one uninterrupted UTF-8 text node. */
  maxTextBytes?: number;
  /**
   * Runs after the resource preflight and before PDF output starts. Use this
   * to embed images discovered by the first pass.
   */
  prepare?: (preflight: HtmlPreflight) => void | Promise<void>;
  encryption?: StreamFlowOptions["encryption"];
}

export interface StreamHtmlToPdfResult {
  pageCount: number;
  preflight: HtmlPreflight;
  dom: StreamDomStats;
  warnings: string[];
  diagnostics?: HtmlDiagnostics;
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
  if (
    typeof (
      boxpdfCapabilities as unknown as {
        flowContinuation?: unknown;
      }
    ).flowContinuation !== "function"
  ) {
    throw new Error(
      "streamHtmlToPdf requires @boxpdf/writer 1.12.0 or newer; upgrade the writer before using --stream"
    );
  }
  const preflight = await preflightHtml(openInput());
  await options.prepare?.(preflight);
  prepareFonts(options, preflight.glyphs);
  const rules = parseStylesheets(preflight.stylesheets);
  const warnings: string[] = [];
  const diagnostics = createDiagnostics(options.diagnostics);
  const nodeStream = new TransformStream<BoxNode, BoxNode>();
  const writer = nodeStream.writable.getWriter();
  let dom: StreamDomStats | undefined;

  const producer = (async () => {
    try {
      dom = await visitHtmlRoots(
        openInput(),
        async (node) => {
          for (const rendered of renderRoot(node, rules, options, warnings, diagnostics)) {
            await writer.write(rendered);
          }
        },
        {
          fragmentChildren: options.fragmentChildren,
          maxBufferedNodes: options.maxBufferedNodes,
          maxTextBytes: options.maxTextBytes,
          canFragment: (element) => isStreamableElement(element, rules, options)
        }
      );
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
    warnings: options.warnings,
    encryption: options.encryption
  };
  try {
    const [{ pageCount }] = await Promise.all([
      streamFlow(options.pdf, writable, nodeStream.readable, flowOptions),
      producer
    ]);
    return {
      pageCount,
      preflight,
      dom: dom!,
      warnings,
      diagnostics: diagnostics?.toJSON()
    };
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  }
}

function isStreamableElement(
  element: HtmlElementNode,
  rules: ReturnType<typeof parseStylesheets>,
  options: StreamHtmlToPdfOptions
): boolean {
  if (rules.some((rule) => FRAGMENT_SENSITIVE_SELECTOR.test(rule.selector))) {
    return false;
  }
  const root: HtmlElementNode = {
    kind: "element",
    tag: "body",
    attrs: {},
    children: [element]
  };
  element.parent = root;
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
  const child = styled.children[0];
  if (!child || "text" in child) return false;
  const style = child.style;
  return (
    style.display === "block" &&
    (!style.float || style.float === "none") &&
    style.position !== "absolute" &&
    style.height === undefined &&
    style.rotate === undefined &&
    style.translate === undefined &&
    style.scale === undefined &&
    (!style.transform || style.transform.length === 0)
  );
}

function renderRoot(
  node: HtmlNode,
  rules: ReturnType<typeof parseStylesheets>,
  options: StreamHtmlToPdfOptions,
  warnings: string[],
  diagnostics: HtmlDiagnosticsRecorder | undefined
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
    options.width,
    diagnostics ? (declaration) => diagnostics.recordUnsupportedCss(declaration) : undefined
  );
  const result = renderStyledTree(styled, options);
  warnings.push(...result.warnings);
  return result.nodes;
}

function prepareFonts(options: StreamHtmlToPdfOptions, glyphs: Set<string>): void {
  const fonts = new Set<PDFFont>([
    options.font,
    ...(options.boldFont ? [options.boldFont] : []),
    ...(options.italicFont ? [options.italicFont] : []),
    ...(options.preloadFonts ?? [])
  ]);
  for (const font of fonts) {
    for (const glyph of glyphs) {
      const rendered = /\s/u.test(glyph) ? " " : glyph;
      try {
        font.encodeText(rendered);
      } catch {
        // A fallback family may legitimately lack glyphs assigned to another
        // face. Rendering still reports an error if this face is selected.
      }
    }
  }
}
