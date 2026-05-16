export type { HtmlToBoxpdfOptions, ParsedHtml, RenderResult } from "./types.js";

import { parseStylesheets } from "./css.js";
import { parseHtml } from "./dom.js";
import { renderStyledTree } from "./render.js";
import { computeStyles, defaultStyle } from "./style.js";
import type { HtmlToBoxpdfOptions, RenderResult } from "./types.js";

export function htmlToBoxpdf(html: string, options: HtmlToBoxpdfOptions): RenderResult {
  const parsed = parseHtml(html);
  const rules = parseStylesheets(parsed.stylesheets);
  const styled = computeStyles(parsed.root, rules, {
    ...defaultStyle(options.defaultFontSize ?? 12),
    color: options.defaultColor,
    lineHeight: options.defaultLineHeight
  });
  return renderStyledTree(styled, options);
}

export { parseHtml };
