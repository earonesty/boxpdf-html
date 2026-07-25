import { once } from "node:events";
import { finished } from "node:stream/promises";
import { SAXParser, type EndTag, type StartTag, type Text } from "parse5-sax-parser";

export interface HtmlPreflight {
  stylesheets: string[];
  assetUrls: Set<string>;
  glyphs: Set<string>;
  htmlBytes: number;
}

const NON_RENDERED = new Set(["script", "noscript", "template", "title"]);

/**
 * Scan HTML without retaining its DOM. The result contains the document-wide
 * resources that must be known before streamed PDF output can begin.
 */
export async function preflightHtml(
  input: AsyncIterable<string | Uint8Array>
): Promise<HtmlPreflight> {
  const parser = new SAXParser();
  // SAXParser is a pass-through Transform. Drain its readable side so large
  // inputs cannot stall on an output buffer nobody consumes.
  parser.resume();
  const stylesheets: string[] = [];
  const assetUrls = new Set<string>();
  const glyphs = new Set<string>();
  const decoder = new TextDecoder();
  const openTags: string[] = [];
  let styleText: string[] | undefined;
  let htmlBytes = 0;

  parser.on("startTag", (token: StartTag) => {
    const tag = token.tagName.toLowerCase();
    openTags.push(tag);
    const attrs = Object.fromEntries(token.attrs.map((attr) => [attr.name.toLowerCase(), attr.value]));
    if ((tag === "img" || tag === "source") && attrs.src) assetUrls.add(attrs.src);
    if (tag === "img" || tag === "source") {
      for (const url of srcsetUrls(attrs.srcset)) assetUrls.add(url);
    }
    for (const url of cssUrls(attrs.style)) assetUrls.add(url);
    if (tag === "style") styleText = [];
  });

  parser.on("text", (token: Text) => {
    if (styleText) {
      styleText.push(token.text);
      return;
    }
    if (openTags.some((tag) => NON_RENDERED.has(tag))) return;
    for (const glyph of token.text) glyphs.add(glyph);
  });

  parser.on("endTag", (token: EndTag) => {
    const tag = token.tagName.toLowerCase();
    if (tag === "style" && styleText) {
      const css = styleText.join("");
      if (css.trim()) {
        stylesheets.push(css);
        for (const url of cssUrls(css)) assetUrls.add(url);
      }
      styleText = undefined;
    }
    const index = openTags.lastIndexOf(tag);
    if (index >= 0) openTags.splice(index);
  });

  for await (const chunk of input) {
    const bytes =
      typeof chunk === "string"
        ? new TextEncoder().encode(chunk)
        : chunk;
    htmlBytes += bytes.byteLength;
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (text && !parser.write(text)) await once(parser, "drain");
  }
  const tail = decoder.decode();
  if (tail) parser.write(tail);
  parser.end();
  await finished(parser);

  return { stylesheets, assetUrls, glyphs, htmlBytes };
}

function cssUrls(css: string | undefined): string[] {
  if (!css) return [];
  const urls: string[] = [];
  for (const match of css.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*?))\s*\)/gi)) {
    const url = (match[1] ?? match[2] ?? match[3])?.trim();
    if (url) urls.push(url);
  }
  return urls;
}

function srcsetUrls(srcset: string | undefined): string[] {
  if (!srcset) return [];
  return srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/, 1)[0])
    .filter((url): url is string => Boolean(url));
}
