import { describe, expect, it, beforeAll } from "vitest";
import { PDFDocument, StandardFonts, type PDFImage, type PDFFont } from "pdf-lib";
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

  it("preserves collapsed whitespace between inline elements", () => {
    const result = htmlToBoxpdf(`<p>Hello <strong>bold</strong> <span>world</span></p>`, { font, boldFont: bold, width: 320 });
    const block = result.nodes[0];
    if (block?.kind !== "vstack") throw new Error("expected block");
    const paragraph = block.children[0];
    if (paragraph?.kind !== "paragraph") throw new Error("expected paragraph");
    expect(paragraph.runs.map((item) => ("text" in item ? item.text : "")).join("")).toBe("Hello bold world");
  });

  it("maps white-space rules to paragraph wrapping and hard breaks", () => {
    const result = htmlToBoxpdf(
      `<style>.pre{white-space:pre}.nowrap{white-space:nowrap;width:40px}.preline{white-space:pre-line}</style>
       <p class="pre">alpha   beta
gamma</p><p class="nowrap">one two three</p><p class="preline">a   b
c</p>`,
      { font, width: 320 }
    );
    const pre = result.nodes[0];
    const nowrap = result.nodes[1];
    const preline = result.nodes[2];
    if (pre?.kind !== "vstack" || nowrap?.kind !== "vstack" || preline?.kind !== "vstack") throw new Error("expected blocks");
    const preParagraph = pre.children[0];
    const nowrapParagraph = nowrap.children[0];
    const prelineParagraph = preline.children[0];
    if (preParagraph?.kind !== "paragraph" || nowrapParagraph?.kind !== "paragraph" || prelineParagraph?.kind !== "paragraph") {
      throw new Error("expected paragraphs");
    }
    expect(preParagraph.props.wrap).toBe(false);
    expect(preParagraph.runs.map((item) => ("text" in item ? item.text : "")).join("")).toContain("alpha   beta\n");
    expect(nowrapParagraph.props.wrap).toBe(false);
    expect(prelineParagraph.props.wrap).toBe(true);
    expect(prelineParagraph.runs.map((item) => ("text" in item ? item.text : "")).join("")).toContain("a b\nc");
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

  it("applies descendant selectors", () => {
    const result = htmlToBoxpdf(
      `<style>.row{display:flex;flex-direction:row;gap:8px}.row .muted{color:#666}</style>
       <div class="row"><span>One</span><span class="muted">Two</span></div>`,
      { font, width: 320 }
    );
    const row = result.nodes[0];
    if (row?.kind !== "hstack") throw new Error("expected row");
    const second = row.children[1];
    if (second?.kind !== "paragraph") throw new Error("expected paragraph");
    expect(second.runs[0]).toMatchObject({ style: { color: { r: 0.4, g: 0.4, b: 0.4 } } });
  });

  it("cascades important declarations above inline normal declarations", () => {
    const result = htmlToBoxpdf(
      `<style>.notice{color:#111!important}.notice strong{color:#222}</style>
       <p class="notice" style="color:#333">Important <strong style="color:#444!important">inline</strong></p>`,
      { font, width: 320 }
    );
    const block = result.nodes[0];
    if (block?.kind !== "vstack") throw new Error("expected block");
    const paragraph = block.children[0];
    if (paragraph?.kind !== "paragraph") throw new Error("expected paragraph");
    expect(paragraph.runs[0]).toMatchObject({ style: { color: { r: 0.06666666666666667 } } });
    expect(paragraph.runs[1]).toMatchObject({ style: { color: { r: 0.26666666666666666 } } });
  });

  it("matches attribute, sibling, and structural pseudo selectors", () => {
    const result = htmlToBoxpdf(
      `<style>
        [data-kind="lead"]{color:#111}
        p + p{color:#222}
        p ~ section{color:#333}
        li:first-child{color:#444}
        li:nth-child(2){color:#555}
        li:last-child{color:#666}
      </style>
      <p data-kind="lead">Lead</p><p>Second</p><section>Section</section>
      <ul><li>One</li><li>Two</li><li>Three</li></ul>`,
      { font, width: 320 }
    );
    const lead = result.nodes[0];
    const second = result.nodes[1];
    const section = result.nodes[2];
    const list = result.nodes[3];
    if (lead?.kind !== "vstack" || second?.kind !== "vstack" || section?.kind !== "vstack" || list?.kind !== "vstack") {
      throw new Error("expected blocks");
    }
    const leadParagraph = lead.children[0];
    const secondParagraph = second.children[0];
    const sectionParagraph = section.children[0];
    const firstItem = list.children[0];
    const secondItem = list.children[1];
    const thirdItem = list.children[2];
    if (
      leadParagraph?.kind !== "paragraph" ||
      secondParagraph?.kind !== "paragraph" ||
      sectionParagraph?.kind !== "paragraph" ||
      firstItem?.kind !== "paragraph" ||
      secondItem?.kind !== "paragraph" ||
      thirdItem?.kind !== "paragraph"
    ) {
      throw new Error("expected paragraphs");
    }
    expect(leadParagraph.runs[0]).toMatchObject({ style: { color: { r: 0.06666666666666667 } } });
    expect(secondParagraph.runs[0]).toMatchObject({ style: { color: { r: 0.13333333333333333 } } });
    expect(sectionParagraph.runs[0]).toMatchObject({ style: { color: { r: 0.2 } } });
    expect(firstItem.runs[1]).toMatchObject({ style: { color: { r: 0.26666666666666666 } } });
    expect(secondItem.runs[1]).toMatchObject({ style: { color: { r: 0.3333333333333333 } } });
    expect(thirdItem.runs[1]).toMatchObject({ style: { color: { r: 0.4 } } });
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

  it("maps per-side CSS borders to boxpdf border sides", () => {
    const result = htmlToBoxpdf(
      `<style>.card{width:120px;padding:4px;border-left:4px solid #111;border-bottom:2px solid #222}.accent{border-top:3px solid #333;border-right:5px solid #444}</style>
       <div class="card accent">Sides</div>`,
      { font, width: 320 }
    );
    const card = result.nodes[0];
    if (card?.kind !== "vstack") throw new Error("expected card");
    expect(card.style.width).toBe(102.75);
    expect(card.style.borderSides).toMatchObject({
      top: { width: 2.25, color: { r: 0.2 } },
      right: { width: 3.75, color: { r: 0.26666666666666666 } },
      left: { width: 3, color: { r: 0.06666666666666667 } },
      bottom: { width: 1.5, color: { r: 0.13333333333333333 } }
    });
  });

  it("maps CSS positioning and z-index to box primitives", () => {
    const result = htmlToBoxpdf(
      `<style>.panel{position:relative}.badge{position:absolute;top:8px;right:10px;z-index:2}</style>
       <div class="panel"><div class="badge">New</div><p>Content</p></div>`,
      { font, width: 320 }
    );
    const panel = result.nodes[0];
    if (panel?.kind !== "vstack") throw new Error("expected panel");
    const badge = panel.children[0];
    if (badge?.kind !== "vstack") throw new Error("expected badge");
    expect(panel.style.position).toBe("relative");
    expect(badge.style).toMatchObject({ position: "absolute", top: 6, right: 7.5, zIndex: 2 });
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

  it("maps border-box sizing to outer and child content widths", () => {
    const result = htmlToBoxpdf(
      `<style>.panel{box-sizing:border-box;width:100px;padding:10px;border:2px solid #000}.child{width:100%}</style>
       <div class="panel"><div class="child">Sized</div></div>`,
      { font, width: 320 }
    );
    const panel = result.nodes[0];
    if (panel?.kind !== "vstack") throw new Error("expected panel");
    const child = panel.children[0];
    if (child?.kind !== "vstack") throw new Error("expected child");
    expect(panel.style.width).toBe(75);
    expect(panel.style.padding).toBe(9);
    expect(child.style.width).toBe(57);
  });

  it("clamps explicit and auto widths with min-width and max-width", () => {
    const result = htmlToBoxpdf(
      `<style>
        .max{width:100%;max-width:120px}
        .auto{max-width:80px}
        .min{width:40px;min-width:90px}
      </style>
      <div class="max">Max</div><div class="auto">Auto</div><div class="min">Min</div>`,
      { font, width: 300 }
    );
    const max = result.nodes[0];
    const auto = result.nodes[1];
    const min = result.nodes[2];
    if (max?.kind !== "vstack" || auto?.kind !== "vstack" || min?.kind !== "vstack") throw new Error("expected blocks");
    expect(max.style.width).toBe(90);
    expect(auto.style.width).toBe(60);
    expect(min.style.width).toBe(67.5);
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

  it("maps CSS background images through the image resolver", () => {
    const image = { width: 200, height: 100 } as PDFImage;
    const result = htmlToBoxpdf(
      `<style>.hero{width:100px;height:50px;background:#123 url("hero.png") center/cover no-repeat}</style><div class="hero">Hero</div>`,
      {
        font,
        width: 320,
        resolveImage: ({ url }) => (url === "hero.png" ? image : undefined)
      }
    );
    const hero = result.nodes[0];
    if (hero?.kind !== "vstack") throw new Error("expected hero");
    expect(hero.style.background).toMatchObject({ r: 0.06666666666666667 });
    expect(hero.style.backgroundImage).toMatchObject({
      image,
      width: 75,
      height: 37.5,
      offsetX: 0,
      offsetY: 0,
      repeat: "no-repeat"
    });
  });

  it("uses CSS pixel intrinsic size for auto background images", () => {
    const image = { width: 200, height: 100 } as PDFImage;
    const result = htmlToBoxpdf(
      `<style>.tile{width:100px;height:50px;background-image:url("tile.png");background-size:auto;background-repeat:repeat}</style><div class="tile"></div>`,
      {
        font,
        width: 320,
        resolveImage: ({ url }) => (url === "tile.png" ? image : undefined)
      }
    );
    const tile = result.nodes[0];
    if (tile?.kind !== "vstack") throw new Error("expected tile");
    expect(tile.style.backgroundImage).toMatchObject({
      width: 150,
      height: 75,
      repeat: "repeat"
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
