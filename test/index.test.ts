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

  it("maps border-collapse to collapsed table cell borders", () => {
    const result = htmlToBoxpdf(
      `<style>table{width:200px;border-collapse:collapse}td{padding:6px;border:1px solid #ccc}</style>
       <table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>`,
      { font, width: 320 }
    );
    const tableNode = result.nodes[0];
    if (tableNode?.kind !== "vstack") throw new Error("expected table");
    const firstRow = tableNode.children[0];
    if (firstRow?.kind !== "hstack") throw new Error("expected row");
    const firstCell = firstRow.children[0];
    if (firstCell?.kind !== "vstack") throw new Error("expected cell");
    expect(firstRow.gap).toBe(0);
    expect(firstCell.style.border).toBeUndefined();
    expect(firstCell.style.borderSides).toMatchObject({
      top: { width: 0.75 },
      left: { width: 0.75 }
    });
  });

  it("resolves percentage widths against parent content width", () => {
    const result = htmlToBoxpdf(
      `<style>.panel{width:300px;padding:10px}table{width:100%}</style>
       <div class="panel"><table><tr><td>A</td><td>B</td></tr></table></div>`,
      { font, width: 500 }
    );
    const panel = result.nodes[0];
    if (panel?.kind !== "vstack") throw new Error("expected panel");
    const tableNode = panel.children[0];
    if (tableNode?.kind !== "vstack") throw new Error("expected table");
    expect(panel.style.width).toBe(240);
    expect(tableNode.style.width).toBe(225);
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

  it("applies inherited text-transform to text nodes", () => {
    const result = htmlToBoxpdf(
      `<style>.upper{text-transform:uppercase}.cap{text-transform:capitalize}.lower{text-transform:lowercase}</style>
       <p><span class="upper">paid </span><span class="cap">quarterly invoice </span><span class="lower">DUE NOW</span></p>`,
      { font, width: 320 }
    );
    const block = result.nodes[0];
    if (block?.kind !== "vstack") throw new Error("expected block");
    const paragraph = block.children[0];
    if (paragraph?.kind !== "paragraph") throw new Error("expected paragraph");
    expect(paragraph.runs.map((item) => ("text" in item ? item.text : "")).join("")).toBe("PAID Quarterly Invoice due now");
  });

  it("renders list items with hanging-indent paragraphs", () => {
    const result = htmlToBoxpdf(`<ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>`, { font, width: 320 });
    const unordered = result.nodes[0] as Extract<(typeof result.nodes)[number], { kind: "vstack" }>;
    const ordered = result.nodes[1] as Extract<(typeof result.nodes)[number], { kind: "vstack" }>;
    const unorderedFirst = unordered.children[0] as Extract<(typeof unordered.children)[number], { kind: "paragraph" }>;
    const orderedFirst = ordered.children[0] as Extract<(typeof ordered.children)[number], { kind: "paragraph" }>;
    expect(result.nodes).toHaveLength(2);
    expect(unorderedFirst.props).toMatchObject({ paddingLeft: 19.5, textIndent: -19.5 });
    expect(unorderedFirst.runs.map((item) => ("text" in item ? item.text : ""))).toEqual(["•  ", "One"]);
    expect(orderedFirst.runs.map((item) => ("text" in item ? item.text : ""))).toEqual(["1.  ", "First"]);
  });
});
