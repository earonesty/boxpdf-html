import { describe, expect, it } from "vitest";
import { preflightHtml } from "../src/stream/preflight.js";

describe("streaming HTML preflight", () => {
  it("collects document-wide CSS, assets, and glyphs across chunk boundaries", async () => {
    async function* chunks(): AsyncIterable<Uint8Array> {
      const source = [
        "<style>.hero { background-image: url('hero.png') }</style>",
        "<div style=\"background:url(tile.png)\">Hé",
        "llo <img src=\"photo.jpg\" srcset=\"small.jpg 1x, large.jpg 2x\"></div>",
        "<script>ignoredGlyphs()</script>"
      ].join("");
      const bytes = new TextEncoder().encode(source);
      for (let offset = 0; offset < bytes.length; offset += 7) {
        yield bytes.slice(offset, offset + 7);
      }
    }

    const result = await preflightHtml(chunks());

    expect(result.stylesheets).toEqual([".hero { background-image: url('hero.png') }"]);
    expect([...result.assetUrls].sort()).toEqual([
      "hero.png",
      "large.jpg",
      "photo.jpg",
      "small.jpg",
      "tile.png"
    ]);
    for (const glyph of "Hélo ") expect(result.glyphs).toContain(glyph);
    expect(result.glyphs).not.toContain("G");
    expect(result.htmlBytes).toBeGreaterThan(100);
  });

  it("accepts string chunks", async () => {
    async function* chunks(): AsyncIterable<string> {
      yield "<p>first ";
      yield "second</p>";
    }

    const result = await preflightHtml(chunks());
    expect(result.glyphs).toEqual(new Set("first second"));
  });
});
