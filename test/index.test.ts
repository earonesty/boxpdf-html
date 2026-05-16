import { describe, expect, it, beforeAll } from "vitest";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { fontFamily, htmlToBoxpdf, parseHtml } from "../src/index.js";

let font: PDFFont;
let bold: PDFFont;

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  font = await pdf.embedFont(StandardFonts.Helvetica);
  bold = await pdf.embedFont(StandardFonts.HelveticaBold);
});

describe("parseHtml", () => {
  it("normalizes HTML into a small internal DOM and extracts stylesheets", () => {
    const parsed = parseHtml("<style>p{color:#111}</style><p>Hello <strong>world</strong></p>");
    expect(parsed.stylesheets).toEqual(["p{color:#111}"]);
    expect(parsed.root.children[0]).toMatchObject({ kind: "element", tag: "p" });
  });
});

describe("htmlToBoxpdf", () => {
  it("renders simple block and inline content into boxpdf nodes", () => {
    const result = htmlToBoxpdf("<h1>Hello</h1><p>A <strong>bold</strong> word.</p>", { font, boldFont: bold, width: 320 });
    expect(result.warnings).toEqual([]);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toMatchObject({ kind: "vstack" });
  });

  it("groups inline children into one paragraph inside a block", () => {
    const result = htmlToBoxpdf("<p>A <strong>bold</strong> word.</p>", { font, boldFont: bold, width: 320 });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      kind: "vstack",
      children: [{ kind: "paragraph" }]
    });
  });

  it("applies basic stylesheet and inline style declarations", () => {
    const result = htmlToBoxpdf(
      `<style>.row{display:flex;flex-direction:row;align-items:baseline;gap:8px}.muted{color:#666}</style>
       <div class="row"><span style="font-size:20px">Big</span><span class="muted">small</span></div>`,
      { font, width: 320 }
    );
    expect(result.nodes[0]).toMatchObject({
      kind: "hstack",
      align: "baseline",
      gap: 6
    });
  });

  it("does not apply a simple class selector to descendants", () => {
    const result = htmlToBoxpdf(
      `<style>.row{display:flex;flex-direction:row;gap:8px}.row .muted{color:#666}</style>
       <div class="row"><span>One</span><span class="muted">Two</span></div>`,
      { font, width: 320 }
    );
    expect(result.nodes[0]).toMatchObject({
      kind: "hstack",
      children: [{ kind: "paragraph" }, { kind: "paragraph" }]
    });
  });

  it("renders parser-inserted table sections", () => {
    const result = htmlToBoxpdf("<table><tr><th>Name</th><th>Total</th></tr><tr><td>A</td><td>$10</td></tr></table>", {
      font,
      boldFont: bold,
      width: 320
    });
    expect(result.warnings).toEqual([]);
    expect(result.nodes[0]).toMatchObject({ fragmentation: { kind: "table" } });
  });

  it("maps table spacing and cell boxes to table primitives", () => {
    const result = htmlToBoxpdf(
      `<style>table{width:200px;margin-top:12px}td{padding:6px;border:1px solid #ccc}</style>
       <table><tr><td>A</td><td>B</td></tr></table>`,
      { font, width: 320 }
    );
    expect(result.nodes[0]).toMatchObject({
      fragmentation: { kind: "table" },
      style: { margin: { top: 9 } }
    });
  });

  it("resolves CSS font families through the helper hook", () => {
    const result = htmlToBoxpdf(`<p style="font-family: Missing, Inter; font-weight: 700">Hello</p>`, {
      font,
      resolveFont: fontFamily({
        Inter: { normal: font, bold }
      })
    });
    expect(result.nodes[0]).toMatchObject({
      kind: "vstack",
      children: [
        {
          kind: "paragraph",
          runs: [{ style: { font: bold } }]
        }
      ]
    });
  });

  it("maps visible text and box styling", () => {
    const result = htmlToBoxpdf(
      `<style>.card > p{border-radius:8px;text-decoration:underline}</style>
       <div class="card"><p style="border:1px solid #ccc">Hello</p><section><p>Nested</p></section></div>`,
      { font, width: 320 }
    );
    expect(result.nodes[0]).toMatchObject({
      kind: "vstack",
      children: [
        {
          kind: "vstack",
          style: { borderRadius: 6 },
          children: [
            {
              kind: "paragraph",
              runs: [{ style: { underline: true } }]
            }
          ]
        },
        {
          kind: "vstack",
          children: [
            {
              kind: "vstack",
              children: [
                {
                  kind: "paragraph",
                  runs: [{ style: { underline: false } }]
                }
              ]
            }
          ]
        }
      ]
    });
  });

  it("applies body styles to fragment children", () => {
    const result = htmlToBoxpdf(`<style>body{font-size:13px;line-height:1.25;color:#666}</style><p>Hello</p>`, {
      font,
      width: 320
    });
    expect(result.nodes[0]).toMatchObject({
      kind: "vstack",
      children: [
        {
          kind: "paragraph",
          runs: [{ style: { size: 9.75, lineHeight: 12.1875 } }]
        }
      ]
    });
  });
});
