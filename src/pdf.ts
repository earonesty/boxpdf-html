import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { PageSizes, pageContent, renderFlow, type EdgesInput, type PageSize } from "boxpdf";
import { fontFamily, type FontFamilyMap } from "./font.js";
import { htmlToBoxpdf } from "./index.js";
import type { HtmlToBoxpdfOptions } from "./types.js";

export interface HtmlToPdfOptions extends Omit<HtmlToBoxpdfOptions, "font" | "width"> {
  /** Regular font. Defaults to the built-in Helvetica (no bytes embedded). */
  font?: PDFFont;
  /** Bold font. Defaults to Helvetica-Bold. */
  boldFont?: PDFFont;
  /** Italic font. Defaults to Helvetica-Oblique. */
  italicFont?: PDFFont;
  /** Bold-italic font. Defaults to Helvetica-BoldOblique. */
  boldItalicFont?: PDFFont;
  /**
   * CSS containing-block width in PDF points. Defaults to the page's content
   * width (page width minus left/right margins), so it tracks `size`/`margin`.
   */
  width?: number;
  /** Page margin handed to `renderFlow`. Default 40. */
  margin?: EdgesInput;
  /** Page size. Default US Letter. */
  size?: PageSize;
  /** Draw boxpdf debug overlays. */
  debug?: boolean;
  /**
   * Render into an existing document instead of a fresh one. Use this when you
   * embedded the fonts/images yourself and want them on the same `PDFDocument`.
   */
  pdf?: PDFDocument;
}

/**
 * Render an HTML string straight to PDF bytes — the one-call path that mirrors
 * what the `boxpdf-html` CLI does internally.
 *
 * Fonts default to pdf-lib's built-in Helvetica family, so the simplest call
 * is just `htmlToPdf(html)`. Pass embedded `font`/`boldFont`/… (via
 * `loadFont`) for brand matching or unicode coverage, and `resolveImage` to
 * supply images. For full control over the document — multiple render passes,
 * the returned nodes, diagnostics — use `htmlToBoxpdf` + `renderFlow` directly.
 *
 * @example
 *   import { htmlToPdf } from "boxpdf-html";
 *
 *   const bytes = await htmlToPdf("<h1>Invoice</h1><p>Thanks!</p>");
 *
 * @example
 *   import { PDFDocument } from "pdf-lib";
 *   import { loadFont, loadImage } from "boxpdf";
 *   import { htmlToPdf } from "boxpdf-html";
 *
 *   const pdf = await PDFDocument.create();
 *   const inter = await loadFont(pdf, interBytes);
 *   const logo = await loadImage(pdf, logoBytes);
 *   const bytes = await htmlToPdf(html, {
 *     pdf,
 *     font: inter,
 *     resolveImage: ({ url }) => (url === "logo.png" ? logo : undefined)
 *   });
 */
export async function htmlToPdf(html: string, options: HtmlToPdfOptions = {}): Promise<Uint8Array> {
  const pdf = options.pdf ?? (await PDFDocument.create());
  const margin = options.margin ?? 40;
  const size = options.size ?? PageSizes.Letter;

  const normal = options.font ?? (await pdf.embedFont(StandardFonts.Helvetica));
  const bold = options.boldFont ?? (await pdf.embedFont(StandardFonts.HelveticaBold));
  const italic = options.italicFont ?? (await pdf.embedFont(StandardFonts.HelveticaOblique));
  const boldItalic = options.boldItalicFont ?? (await pdf.embedFont(StandardFonts.HelveticaBoldOblique));

  // Map the common CSS generic families onto the resolved faces so unstyled
  // documents render without the caller wiring up a font resolver. A
  // caller-supplied `resolveFont` takes priority for the families it covers.
  const faces = { normal, bold, italic, boldItalic };
  const defaultFamilies: FontFamilyMap = {
    Helvetica: faces,
    Arial: faces,
    "sans-serif": faces,
    serif: faces,
    monospace: faces
  };
  const defaultResolver = fontFamily(defaultFamilies);
  const userResolver = options.resolveFont;
  const resolveFont = userResolver
    ? (request: Parameters<typeof defaultResolver>[0]) => userResolver(request) ?? defaultResolver(request)
    : defaultResolver;

  const result = htmlToBoxpdf(html, {
    ...options,
    font: normal,
    boldFont: bold,
    italicFont: italic,
    resolveFont,
    width: options.width ?? pageContent(size, margin).width
  });

  await renderFlow(pdf, result.nodes, { margin, size, debug: options.debug });
  return pdf.save();
}
