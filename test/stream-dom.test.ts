import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/dom.js";
import { visitHtmlRoots } from "../src/stream/dom.js";
import type { HtmlNode } from "../src/types.js";

describe("streaming HTML structure", () => {
  it("matches the buffered parser across the visual fixture corpus", async () => {
    const fixtures = [
      "css-basics.html",
      "inline-whitespace.html",
      "lists.html",
      "selectors.html",
      "tailwind-invoice.html",
      "website-css-wins.html"
    ];
    for (const fixture of fixtures) {
      const source = await readFile(resolve("fixtures", fixture), "utf8");
      const streamed: HtmlNode[] = [];
      const stats = await visitHtmlRoots(chunks(source, 113), (node) => {
        streamed.push(node);
      });
      expect(strip(streamed), fixture).toEqual(strip(parseHtml(source).root.children));
      expect(stats.maxPendingRoots).toBeGreaterThan(0);
    }
  });

  it("releases root siblings incrementally with bounded pending nodes", async () => {
    const source = Array.from({ length: 1_000 }, (_, index) => `<p>row ${index}</p>`).join("");
    let visited = 0;
    const stats = await visitHtmlRoots(chunks(source, 64), () => {
      visited += 1;
    });

    expect(visited).toBe(1_000);
    expect(stats.emittedRoots).toBe(1_000);
    expect(stats.maxPendingRoots).toBeLessThan(10);
    expect(stats.maxOpenDepth).toBe(1);
  });
});

async function* chunks(source: string, size: number): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(source);
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.slice(offset, offset + size);
  }
}

function strip(value: HtmlNode[] | HtmlNode): unknown {
  if (Array.isArray(value)) {
    const out: Array<{ kind: string; value?: string } | unknown> = [];
    for (const node of value.map(strip) as Array<{ kind: string; value?: string }>) {
      const previous = out[out.length - 1] as { kind?: string; value?: string } | undefined;
      if (node.kind === "text" && previous?.kind === "text") previous.value = `${previous.value ?? ""}${node.value ?? ""}`;
      else out.push(node);
    }
    return out;
  }
  if (value.kind === "text") return { kind: "text", value: value.value };
  return {
    kind: "element",
    tag: value.tag,
    attrs: value.attrs,
    children: value.children.map(strip)
  };
}
