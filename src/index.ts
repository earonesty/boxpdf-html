export interface RenderHtmlOptions {
  /**
   * Base URL used later for resolving relative links, stylesheets, fonts, and images.
   */
  baseUrl?: string;
}

export interface HtmlParseResult {
  html: string;
  options: RenderHtmlOptions;
}

export function prepareHtml(html: string, options: RenderHtmlOptions = {}): HtmlParseResult {
  return { html, options };
}
