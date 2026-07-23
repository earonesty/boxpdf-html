import { describe, expect, it, beforeAll } from "vitest";
import { PDFDocument, StandardFonts, type PDFImage, type PDFFont } from "pdf-lib";
import { fontFamily, htmlToBoxpdf, parseHtml } from "../src/index.js";

let font: PDFFont;
let bold: PDFFont;
let boldItalic: PDFFont;

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  font = await pdf.embedFont(StandardFonts.Helvetica);
  bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  boldItalic = await pdf.embedFont(StandardFonts.HelveticaBoldOblique);
});

describe("parseHtml", () => {
  it("normalizes HTML into a small internal DOM and extracts stylesheets", () => {
    const parsed = parseHtml("<style>p{color:#111}</style><p>Hello <strong>world</strong></p>");
    expect(parsed.stylesheets).toEqual(["p{color:#111}"]);
    expect(parsed.root.children[0]).toMatchObject({ kind: "element", tag: "p" });
  });

  it("does not render the title from a full HTML document", () => {
    const parsed = parseHtml(
      '<!doctype html><html><head><meta charset="utf-8"><title>Document title</title><style>p{color:#111}</style></head><body><p>Visible content</p></body></html>'
    );

    const elements = [parsed.root];
    for (const element of elements) {
      elements.push(...element.children.filter((child) => child.kind === "element"));
    }

    expect(parsed.stylesheets).toEqual(["p{color:#111}"]);
    expect(elements).not.toContainEqual(expect.objectContaining({ tag: "title" }));
    expect(elements).toContainEqual(expect.objectContaining({ tag: "p" }));
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

  it("lets block flex containers fill the available width", () => {
    const result = htmlToBoxpdf(
      `<style>.wrap{padding:32px}.row{display:flex;justify-content:space-between}</style>
       <div class="wrap"><div class="row"><span>Total</span><span>$1,250.00</span></div></div>`,
      { font, width: 300 }
    );
    const wrap = result.nodes[0];
    if (wrap?.kind !== "vstack") throw new Error("expected wrapper");
    const row = wrap.children[0];
    if (row?.kind !== "hstack") throw new Error("expected flex row");
    expect(row.style.width).toBe(252);
    expect(row.children).toHaveLength(2);
    expect(row.children[0]).toMatchObject({ kind: "vstack", style: { width: expect.any(Number) } });
  });

  it("keeps padded justify-between flex items at their content width", () => {
    const result = htmlToBoxpdf(
      `<style>.row{display:flex;justify-content:space-between;padding:16px;width:300px}</style>
       <div class="row"><span>Amount due</span><span style="font-weight:bold;font-size:20px">$1,250.00</span></div>`,
      { font, boldFont: bold, width: 500 }
    );
    const row = result.nodes[0];
    if (row?.kind !== "hstack") throw new Error("expected flex row");
    const amount = row.children[1];
    if (amount?.kind !== "vstack") throw new Error("expected flex item");
    expect(amount.style.width).toBeGreaterThan(65);
    expect(amount.style.shrink).toBe(0);
  });

  it("does not pre-stretch auto-width block flex items before spacing them", () => {
    const result = htmlToBoxpdf(
      `<style>.row{display:flex;justify-content:space-between;width:300px}.title{display:block}.thumb{width:48px;height:48px}</style>
       <div class="row"><div class="title"><strong>Acme Studio</strong><span>Tailwind</span></div><div class="thumb"></div></div>`,
      { font, boldFont: bold, width: 500 }
    );
    const row = result.nodes[0];
    if (row?.kind !== "hstack") throw new Error("expected flex row");
    const title = row.children[0];
    const thumb = row.children[1];
    if (title?.kind !== "vstack" || thumb?.kind !== "vstack") throw new Error("expected flex items");
    expect((title.style.width ?? 0) + (thumb.style.width ?? 0)).toBeLessThanOrEqual(row.style.width ?? 0);
    expect(thumb.style.width).toBe(36);
  });

  it("parses generated Tailwind utility values used by invoice-style HTML", () => {
    const result = htmlToBoxpdf(
      `<style>
        :root{--spacing:.25rem;--color-gray-900:oklch(21% .034 264.665);--text-2xl:1.5rem;--text-2xl--line-height:calc(2 / 1.5);--font-weight-bold:700}
        h1{font-size:inherit;font-weight:inherit}
        .p-8{padding:calc(var(--spacing) * 8)}
        .text-2xl{font-size:var(--text-2xl);line-height:var(--text-2xl--line-height)}
        .font-bold{font-weight:var(--font-weight-bold)}
        .text-gray-900{color:var(--color-gray-900)}
      </style>
      <div class="p-8"><h1 class="text-2xl font-bold text-gray-900">Invoice #1234</h1></div>`,
      { font, boldFont: bold, width: 300 }
    );
    const wrap = result.nodes[0];
    if (wrap?.kind !== "vstack") throw new Error("expected wrapper");
    expect(wrap.style.padding).toBe(24);
    const heading = wrap.children[0];
    if (heading?.kind !== "vstack") throw new Error("expected heading");
    const paragraph = heading.children[0];
    if (paragraph?.kind !== "paragraph") throw new Error("expected paragraph");
    const firstRun = paragraph.runs[0];
    if (!("text" in firstRun)) throw new Error("expected text run");
    expect(firstRun.style.size).toBe(18);
    expect(firstRun.style.lineHeight).toBe(24);
    expect(firstRun.style.font).toBe(bold);
    expect(firstRun.style.color?.r).toBeLessThan(0.2);
    expect(firstRun.style.color?.g).toBeLessThan(0.25);
    expect(firstRun.style.color?.b).toBeLessThan(0.35);
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
    if (second?.kind !== "vstack") throw new Error("expected flex item");
    const paragraph = second.children[0];
    if (paragraph?.kind !== "paragraph") throw new Error("expected paragraph");
    expect(paragraph.runs[0]).toMatchObject({ style: { color: { r: 0.4, g: 0.4, b: 0.4 } } });
  });

  it("matches escaped Tailwind class selectors", () => {
    const result = htmlToBoxpdf(
      `<style>
        .md\\:flex{display:flex}
        .w-\\[240px\\]{width:240px}
        .bg-\\[\\#fafafa\\]{background:#fafafa}
        .text-\\[13px\\]{font-size:13px}
      </style>
      <div class="md:flex w-[240px] bg-[#fafafa] text-[13px]">Escaped</div>`,
      { font, width: 400 }
    );
    const node = result.nodes[0];
    if (node?.kind !== "hstack") throw new Error("expected flex box");
    expect(node.style.width).toBe(180);
    expect(node.style.background).toMatchObject({ r: 250 / 255, g: 250 / 255, b: 250 / 255 });
    const child = node.children[0];
    expect(child).toMatchObject({ kind: "text", props: { size: 9.75 } });
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

  it("maps floated boxes to paragraph float wrapping", () => {
    const result = htmlToBoxpdf(
      `<style>.float{float:left;width:48px;height:24px;margin-right:8px;background:#dbeafe}.wrap{width:120px}</style>
       <div class="wrap"><span class="float">F</span>alpha beta gamma delta epsilon zeta</div>`,
      { font, width: 320 }
    );
    const block = result.nodes[0];
    if (block?.kind !== "vstack") throw new Error("expected block");
    const paragraphNode = block.children[0];
    if (paragraphNode?.kind !== "paragraph") throw new Error("expected paragraph");
    expect(paragraphNode.props.floats).toHaveLength(1);
    expect(paragraphNode.props.floats?.[0]).toMatchObject({ side: "left" });
  });

  it("wraps a following block paragraph around preceding floats", () => {
    const result = htmlToBoxpdf(
      `<style>.float{float:left;width:48px;height:24px;margin-right:8px;background:#dbeafe}.wrap{width:120px}</style>
       <div class="wrap"><div class="float">F</div>
       <p>alpha beta gamma delta epsilon zeta</p></div>`,
      { font, width: 320 }
    );
    const block = result.nodes[0];
    if (block?.kind !== "vstack") throw new Error("expected block");
    const paragraphBlock = block.children[0];
    if (paragraphBlock?.kind !== "vstack") throw new Error("expected paragraph block");
    const paragraphNode = paragraphBlock.children[0];
    if (paragraphNode?.kind !== "paragraph") throw new Error("expected paragraph");
    expect(paragraphNode.props.floats).toHaveLength(1);
    expect(paragraphNode.props.floats?.[0]).toMatchObject({ side: "left" });
  });

  it("emits an empty paragraph to paint floats without text", () => {
    const result = htmlToBoxpdf(
      `<style>.float{float:right;width:48px;height:24px;background:#dbeafe}.wrap{width:120px}</style>
       <div class="wrap"><div class="float">F</div></div>`,
      { font, width: 320 }
    );
    const block = result.nodes[0];
    if (block?.kind !== "vstack") throw new Error("expected block");
    const paragraphNode = block.children[0];
    if (paragraphNode?.kind !== "paragraph") throw new Error("expected paragraph");
    expect(paragraphNode.runs).toHaveLength(0);
    expect(paragraphNode.props.floats).toHaveLength(1);
    expect(paragraphNode.props.floats?.[0]).toMatchObject({ side: "right" });
  });

  it("maps img elements to replaced image nodes", () => {
    const image = { width: 2, height: 1 } as PDFImage;
    const result = htmlToBoxpdf(
      `<style>img{width:30px;height:20px;object-fit:contain}</style><p>A <img src="x.png"> B</p>`,
      { font, width: 320, resolveImage: () => image }
    );
    const block = result.nodes[0];
    if (block?.kind !== "vstack") throw new Error("expected block");
    const paragraphNode = block.children[0];
    if (paragraphNode?.kind !== "paragraph") throw new Error("expected paragraph");
    const inline = paragraphNode.runs.find((item) => "node" in item);
    expect(inline).toMatchObject({ width: 22.5, height: 15 });
    if (!inline || !("node" in inline)) throw new Error("expected inline image");
    expect(inline.node.kind).toBe("imageBox");
  });

  it("maps styled inline-block elements to atomic inline nodes", () => {
    const result = htmlToBoxpdf(
      `<style>.badge{display:inline-block;padding:2px 6px;border:1px solid #2563eb;background:#dbeafe;border-radius:4px;vertical-align:middle}</style>
       <p>Status <span class="badge">PAID</span> after</p>`,
      { font, width: 320 }
    );
    const block = result.nodes[0];
    if (block?.kind !== "vstack") throw new Error("expected block");
    const paragraphNode = block.children[0];
    if (paragraphNode?.kind !== "paragraph") throw new Error("expected paragraph");
    const inline = paragraphNode.runs.find((item) => "node" in item);
    expect(inline).toMatchObject({ verticalAlign: "middle" });
    if (!inline || !("node" in inline)) throw new Error("expected inline block");
    expect(inline.node).toMatchObject({
      kind: "vstack",
      style: {
        background: { r: 0.8588235294117647, g: 0.9176470588235294, b: 0.996078431372549 },
        borderRadius: 3
      }
    });
  });

  it("maps inline-flex and inline-grid to atomic inline nodes", () => {
    const result = htmlToBoxpdf(
      `<style>
        .pill{display:inline-flex;gap:4px;padding:2px 5px;background:#dcfce7;vertical-align:middle}
        .grid{display:inline-grid;grid-template-columns:1fr 1fr;gap:2px;padding:2px;background:#dbeafe}
      </style>
      <p><span class="pill"><span>A</span><span>B</span></span> and <span class="grid"><span>1</span><span>2</span></span></p>`,
      { font, width: 320 }
    );
    const block = result.nodes[0];
    if (block?.kind !== "vstack") throw new Error("expected block");
    const paragraphNode = block.children[0];
    if (paragraphNode?.kind !== "paragraph") throw new Error("expected paragraph");
    const inlineNodes = paragraphNode.runs.filter((item): item is Extract<typeof item, { node: unknown }> => "node" in item);
    expect(inlineNodes).toHaveLength(2);
    expect(inlineNodes[0]?.node.kind).toBe("hstack");
    expect(inlineNodes[1]?.node.kind).toBe("vstack");
  });

  it("maps simple CSS grids to row hstacks", () => {
    const result = htmlToBoxpdf(
      `<style>.grid{display:grid;grid-template-columns:1fr 2fr 60px;column-gap:10px;row-gap:8px;width:300px}.item{padding:4px}</style>
       <div class="grid"><div class="item">A</div><div class="item">B</div><div class="item">C</div><div class="item">D</div></div>`,
      { font, width: 320 }
    );
    const grid = result.nodes[0];
    if (grid?.kind !== "vstack") throw new Error("expected grid vstack");
    expect(grid.gap).toBe(6);
    expect(grid.children).toHaveLength(2);
    const firstRow = grid.children[0];
    if (firstRow?.kind !== "hstack") throw new Error("expected row hstack");
    expect(firstRow.gap).toBe(7.5);
    expect(firstRow.children.map((child) => (child.kind === "vstack" || child.kind === "hstack" ? child.style.width : undefined))).toEqual([55, 110, 45]);
  });

  it("maps CSS overflow clipping to stack overflow hidden", () => {
    const result = htmlToBoxpdf(
      `<style>.clip{width:80px;height:24px;overflow:hidden}.scroll{width:80px;height:24px;overflow:auto}</style>
       <div class="clip">Tall clipped content</div><div class="scroll">Scrollable content clips in PDF</div>`,
      { font, width: 320 }
    );
    const clip = result.nodes[0];
    const scroll = result.nodes[1];
    if (clip?.kind !== "vstack" || scroll?.kind !== "vstack") throw new Error("expected blocks");
    expect(clip.style.overflow).toBe("hidden");
    expect(scroll.style.overflow).toBeUndefined();
  });

  it("resolves inherited CSS custom properties and var fallbacks", () => {
    const result = htmlToBoxpdf(
      `<style>
        :root { --brand: #2563eb; --space: 12px; --missing-test: var(--missing, var(--danger)); --danger: #dc2626; }
        .panel { color: var(--brand); padding: var(--space); border: 1px solid var(--brand); }
        .panel strong { color: var(--missing-test); }
      </style>
      <div class="panel">Brand <strong>fallback</strong></div>`,
      { font, width: 320 }
    );
    const panel = result.nodes[0];
    if (panel?.kind !== "vstack") throw new Error("expected panel");
    expect(panel.style.padding).toBe(9.75);
    expect(panel.style.border?.color).toMatchObject({ r: 0.1450980392156863, g: 0.38823529411764707, b: 0.9215686274509803 });
    const paragraphNode = panel.children[0];
    if (paragraphNode?.kind !== "paragraph") throw new Error("expected paragraph");
    const colors = paragraphNode.runs.filter((run) => "text" in run).map((run) => ("text" in run ? run.style.color : undefined));
    expect(colors[0]).toMatchObject({ r: 0.1450980392156863, g: 0.38823529411764707, b: 0.9215686274509803 });
    expect(colors[1]).toMatchObject({ r: 0.8627450980392157, g: 0.14901960784313725, b: 0.14901960784313725 });
  });

  it("maps modern CSS colors", () => {
    const result = htmlToBoxpdf(
      `<style>
        .rgb { color: rgb(37 99 235 / 80%); background: hsl(210 100% 96%); }
        .rgba { color: rgba(220, 38, 38, 0.7); border: 1px solid hsl(142 72% 29%); }
      </style>
      <div class="rgb">Blue</div><div class="rgba">Red</div>`,
      { font, width: 320 }
    );
    const rgb = result.nodes[0];
    const rgba = result.nodes[1];
    if (rgb?.kind !== "vstack" || rgba?.kind !== "vstack") throw new Error("expected boxes");
    expect(rgb.style.background?.r).toBeCloseTo(0.92);
    expect(rgb.style.background?.g).toBeCloseTo(0.96);
    expect(rgb.style.background?.b).toBeCloseTo(1);
    const rgbText = rgb.children[0];
    if (rgbText?.kind !== "paragraph") throw new Error("expected paragraph");
    const rgbRun = rgbText.runs[0];
    if (!rgbRun || !("text" in rgbRun)) throw new Error("expected text run");
    expect(rgbRun.style.color).toMatchObject({ r: 0.1450980392156863, g: 0.38823529411764707, b: 0.9215686274509803 });
    const rgbaText = rgba.children[0];
    if (rgbaText?.kind !== "paragraph") throw new Error("expected paragraph");
    const rgbaRun = rgbaText.runs[0];
    if (!rgbaRun || !("text" in rgbaRun)) throw new Error("expected text run");
    expect(rgbaRun.style.color).toMatchObject({ r: 0.8627450980392157, g: 0.14901960784313725, b: 0.14901960784313725 });
    expect(rgba.style.border?.color?.r).toBeCloseTo(0.0812);
    expect(rgba.style.border?.color?.g).toBeCloseTo(0.4988);
    expect(rgba.style.border?.color?.b).toBeCloseTo(0.2343);
  });

  it("maps logical spacing, borders, insets, and text indent", () => {
    const result = htmlToBoxpdf(
      `<style>
        .box {
          position: relative;
          padding-inline: 12px 20px;
          padding-block: 4px 8px;
          margin-block-start: 10px;
          border-inline-start: 2px solid #2563eb;
          text-indent: 16px;
        }
        .abs { position: absolute; inset-inline-end: 6px; inset-block-start: 4px; }
      </style>
      <div class="box">Indented text<div class="abs">A</div></div>`,
      { font, width: 320 }
    );
    const box = result.nodes[0];
    if (box?.kind !== "vstack") throw new Error("expected box");
    expect(box.style.margin).toMatchObject({ top: 7.5 });
    expect(box.style.padding).toMatchObject({ top: 3, right: 15, bottom: 6, left: 10.5 });
    expect(box.style.borderSides?.left?.width).toBe(1.5);
    const paragraphNode = box.children.find((child) => child.kind === "paragraph");
    if (paragraphNode?.kind !== "paragraph") throw new Error("expected paragraph");
    expect(paragraphNode.props.textIndent).toBe(12);
    const abs = box.children.find((child) => child.kind === "vstack");
    if (abs?.kind !== "vstack") throw new Error("expected absolute child");
    expect(abs.style).toMatchObject({ position: "absolute", right: 4.5, top: 3 });
  });

  it("renders display contents without an intermediate box and maps flow-root to block", () => {
    const result = htmlToBoxpdf(
      `<style>.contents{display:contents;color:#2563eb}.flow{display:flow-root;padding:4px}</style>
       <div><span>Before </span><span class="contents"><strong>inside</strong></span><span> after</span></div>
       <section class="flow">Flow root</section>`,
      { font, boldFont: bold, width: 320 }
    );
    const paragraphBox = result.nodes[0];
    const flow = result.nodes[1];
    if (paragraphBox?.kind !== "vstack" || flow?.kind !== "vstack") throw new Error("expected boxes");
    expect(paragraphBox.children).toHaveLength(1);
    const paragraphNode = paragraphBox.children[0];
    if (paragraphNode?.kind !== "paragraph") throw new Error("expected paragraph");
    expect(paragraphNode.runs.map((item) => ("text" in item ? item.text : ""))).toEqual(["Before ", "inside", " after"]);
    const contentsRun = paragraphNode.runs[1];
    if (!contentsRun || !("text" in contentsRun)) throw new Error("expected text run");
    expect(contentsRun.style.color).toMatchObject({ r: 0.1450980392156863, g: 0.38823529411764707, b: 0.9215686274509803 });
    expect(flow.style.padding).toBe(3);
  });

  it("resolves calc, rem, and viewport length values", () => {
    const result = htmlToBoxpdf(
      `<style>.outer{width:300px}.calc{width:calc(50% - 10px);padding:calc(1rem + 2px)}.vw{width:10vw}</style>
       <div class="outer"><div class="calc">A</div><div class="vw">B</div></div>`,
      { font, width: 400 }
    );
    const outer = result.nodes[0];
    if (outer?.kind !== "vstack") throw new Error("expected outer");
    const calc = outer.children[0];
    const vw = outer.children[1];
    if (calc?.kind !== "vstack" || vw?.kind !== "vstack") throw new Error("expected boxes");
    expect(calc.style.width).toBe(132);
    expect(calc.style.padding).toBe(13.5);
    expect(vw.style.width).toBe(61.2);
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

  it("centers fixed-width blocks with horizontal auto margins", () => {
    const result = htmlToBoxpdf(`<div style="width:120px;margin:0 auto">Centered</div>`, { font, width: 300 });
    const node = result.nodes[0];
    if (node?.kind !== "vstack") throw new Error("expected block");
    expect(node.style.width).toBe(90);
    expect(node.style.margin).toMatchObject({ left: 105, right: 105 });
  });

  it("honors reverse flex directions", () => {
    const row = htmlToBoxpdf(`<div style="display:flex;flex-direction:row-reverse"><span>A</span><span>B</span></div>`, { font, width: 300 });
    const column = htmlToBoxpdf(`<div style="display:flex;flex-direction:column-reverse"><div>A</div><div>B</div></div>`, { font, width: 300 });
    const rowNode = row.nodes[0];
    const columnNode = column.nodes[0];
    if (rowNode?.kind !== "hstack" || columnNode?.kind !== "vstack") throw new Error("expected flex boxes");
    const rowFirst = rowNode.children[0];
    const columnFirst = columnNode.children[0];
    if (rowFirst?.kind !== "vstack" || columnFirst?.kind !== "vstack") throw new Error("expected rendered children");
    expect(rowFirst.children[0]).toMatchObject({ kind: "paragraph", runs: [{ text: "B" }] });
    expect(columnFirst.children[0]).toMatchObject({ kind: "paragraph", runs: [{ text: "B" }] });
  });

  it("orders flex and grid items with CSS order", () => {
    const flex = htmlToBoxpdf(
      `<div style="display:flex"><span style="order:2">A</span><span style="order:1">B</span><span>C</span></div>`,
      { font, width: 300 }
    );
    const grid = htmlToBoxpdf(
      `<style>.grid{display:grid;width:300px;grid-template-columns:1fr 1fr}.last{order:2}.first{order:-1}</style>
       <div class="grid"><div class="last">A</div><div>B</div><div class="first">C</div></div>`,
      { font, width: 300 }
    );
    const flexNode = flex.nodes[0];
    const gridNode = grid.nodes[0];
    if (flexNode?.kind !== "hstack" || gridNode?.kind !== "vstack") throw new Error("expected flex and grid boxes");
    const firstFlex = flexNode.children[0];
    const firstGridRow = gridNode.children[0];
    if (firstFlex?.kind !== "vstack" || firstGridRow?.kind !== "hstack") throw new Error("expected rendered children");
    expect(firstFlex.children[0]).toMatchObject({ kind: "paragraph", runs: [{ text: "C" }] });
    expect(firstGridRow.children[0]).toMatchObject({ kind: "vstack", children: [{ kind: "paragraph", runs: [{ text: "C" }] }] });
  });

  it("places grid items with grid-column spans", () => {
    const result = htmlToBoxpdf(
      `<style>.grid{display:grid;width:300px;grid-template-columns:1fr 2fr 1fr;column-gap:10px}.wide{grid-column:2 / span 2}</style>
       <div class="grid"><div>A</div><div class="wide">Wide</div><div>C</div></div>`,
      { font, width: 400 }
    );
    const grid = result.nodes[0];
    if (grid?.kind !== "vstack") throw new Error("expected grid");
    const firstRow = grid.children[0];
    if (firstRow?.kind !== "hstack") throw new Error("expected row");
    expect(firstRow.children).toHaveLength(2);
    expect(firstRow.children[0]).toMatchObject({ kind: "vstack", style: { width: 52.5 } });
    expect(firstRow.children[1]).toMatchObject({ kind: "vstack", style: { width: 165 } });
  });

  it("preserves unresolved image layout boxes when dimensions are known", () => {
    const result = htmlToBoxpdf(`<img src="missing.jpg" width="200" height="100">`, { font, width: 300 });
    expect(result.warnings).toContain(`img src "missing.jpg" did not resolve; preserved its layout box`);
    expect(result.nodes[0]).toMatchObject({ kind: "vstack", style: { width: 150, height: 75 } });
  });

  it("uses CSS aspect-ratio for missing dimensions", () => {
    const result = htmlToBoxpdf(`<div style="width:160px;aspect-ratio:16 / 9"></div><div style="height:50px;aspect-ratio:2"></div>`, {
      font,
      width: 300
    });
    expect(result.nodes[0]).toMatchObject({ kind: "vstack", style: { width: 120, height: 67.5 } });
    expect(result.nodes[1]).toMatchObject({ kind: "vstack", style: { width: 300, height: 37.5 } });
  });

  it("selects image candidates from srcset and picture sources", () => {
    const seen: string[] = [];
    const image = { width: 400, height: 200 } as PDFImage;
    const result = htmlToBoxpdf(
      `<p>
        <img style="width:120px" src="fallback.png" srcset="small.png 80w, large.png 240w">
        <picture><source srcset="source-small.png 80w, source-large.png 240w"><img style="width:120px" src="fallback-two.png"></picture>
      </p>`,
      {
        font,
        width: 320,
        resolveImage: ({ url }) => {
          seen.push(url);
          return image;
        }
      }
    );
    expect(result.warnings).toEqual([]);
    expect(seen).toEqual(["large.png", "source-large.png"]);
  });

  it("aggregates unsupported CSS diagnostics when requested", () => {
    const result = htmlToBoxpdf(
      `<style>.a{filter:blur(2px);backdrop-filter:blur(1px)}.b{filter:blur(2px)}</style><div class="a"></div><div class="b"></div>`,
      { font, width: 320, diagnostics: { unsupportedCss: true, sampleLimit: 1 } }
    );
    expect(result.diagnostics?.unsupportedCss).toEqual([
      { property: "filter", value: "blur(2px)", count: 2, samples: [".a { filter: blur(2px) }"] },
      { property: "backdrop-filter", value: "blur(1px)", count: 1, samples: [".a { backdrop-filter: blur(1px) }"] }
    ]);
  });

  it("maps common CSS rotation forms onto box paint rotation", () => {
    const result = htmlToBoxpdf(
      `<style>
        .degrees{transform:rotate(45deg)}
        .radians{transform:rotateZ(1.5707963267948966rad)}
        .turns{rotate:-.25turn}
        .grads{rotate:100grad}
      </style>
      <div class="degrees">A</div>
      <div class="radians">B</div>
      <div class="turns">C</div>
      <div class="grads">D</div>`,
      { font, width: 320 }
    );

    expect(result.nodes[0]).toMatchObject({ kind: "vstack", style: { transform: [{ kind: "rotate", degrees: 45 }] } });
    expect(result.nodes[1]).toMatchObject({ kind: "vstack", style: { transform: [{ kind: "rotate", degrees: 90 }] } });
    expect(result.nodes[2]).toMatchObject({ kind: "vstack", style: { transform: [{ kind: "rotate", degrees: -90 }] } });
    expect(result.nodes[3]).toMatchObject({ kind: "vstack", style: { transform: [{ kind: "rotate", degrees: 90 }] } });
  });

  it("preserves standalone transform ordering, origins, percentages, matrix, and skew", () => {
    const result = htmlToBoxpdf(
      `<div style="
        width:200px;height:80px;
        translate:10px 25%;
        rotate:30deg;
        scale:150% .5;
        transform-origin:left bottom;
        transform:translateX(calc(50% - 10px)) scaleY(2) skew(10deg,-5deg) matrix(1,.2,.3,1,4,6)
      ">Combined</div>`,
      { font, width: 320 }
    );

    expect(result.nodes[0]).toMatchObject({
      kind: "vstack",
      style: {
        transformOrigin: {
          x: { length: 0, percent: 0 },
          y: { length: 0, percent: 1 }
        },
        transform: [
          { kind: "translate", x: { length: 7.5, percent: 0 }, y: { length: 0, percent: 0.25 } },
          { kind: "rotate", degrees: 30 },
          { kind: "scale", x: 1.5, y: 0.5 },
          { kind: "translate", x: { length: -7.5, percent: 0.5 }, y: { length: 0, percent: 0 } },
          { kind: "scale", x: 1, y: 2 },
          { kind: "skew", xDegrees: 10, yDegrees: -5 },
          { kind: "matrix", a: 1, b: 0.2, c: 0.3, d: 1, e: 3, f: 4.5 }
        ]
      }
    });
  });

  it("keeps valid transform declarations when later declarations are invalid", () => {
    const result = htmlToBoxpdf(
      `<div style="
        transform:rotate(15deg);transform:not-a-transform;
        translate:10px;translate:invalid;
        rotate:20deg;rotate:invalid;
        scale:150%;scale:invalid;
        transform-origin:left top;transform-origin:invalid invalid
      ">Fallbacks</div>
      <div style="rotate:20deg;rotate:z, 45deg">Invalid comma</div>`,
      { font, width: 320 }
    );

    expect(result.nodes[0]).toMatchObject({
      kind: "vstack",
      style: {
        transformOrigin: {
          x: { length: 0, percent: 0 },
          y: { length: 0, percent: 0 }
        },
        transform: [
          { kind: "translate", x: { length: 7.5, percent: 0 }, y: { length: 0, percent: 0 } },
          { kind: "rotate", degrees: 20 },
          { kind: "scale", x: 1.5, y: 1.5 },
          { kind: "rotate", degrees: 15 }
        ]
      }
    });
    expect(result.nodes[1]).toMatchObject({
      kind: "vstack",
      style: {
        transform: [{ kind: "rotate", degrees: 20 }]
      }
    });
  });

  it("accepts reordered transform-origin keywords and 2D z-axis rotations", () => {
    const result = htmlToBoxpdf(
      `<div style="transform-origin:center left;rotate:z 45deg">Left</div>
       <div style="transform-origin:center right;rotate:45deg z">Right</div>
       <div style="transform-origin:top 10px;rotate:15deg">Top with z-offset</div>`,
      { font, width: 320 }
    );

    expect(result.nodes[0]).toMatchObject({
      kind: "vstack",
      style: {
        transformOrigin: {
          x: { length: 0, percent: 0 },
          y: { length: 0, percent: 0.5 }
        },
        transform: [{ kind: "rotate", degrees: 45 }]
      }
    });
    expect(result.nodes[1]).toMatchObject({
      kind: "vstack",
      style: {
        transformOrigin: {
          x: { length: 0, percent: 1 },
          y: { length: 0, percent: 0.5 }
        },
        transform: [{ kind: "rotate", degrees: 45 }]
      }
    });
    expect(result.nodes[2]).toMatchObject({
      kind: "vstack",
      style: {
        transformOrigin: {
          x: { length: 0, percent: 0.5 },
          y: { length: 0, percent: 0 }
        },
        transform: [{ kind: "rotate", degrees: 15 }]
      }
    });
  });

  it("keeps Tailwind unsupported CSS diagnostics focused on utilities", () => {
    const result = htmlToBoxpdf(
      `<style>
        *{-webkit-text-size-adjust:100%;font-feature-settings:normal}
        h1{font-variation-settings:normal}
        .tracking-wide{letter-spacing:.025em}
        .shadow-sm{box-shadow:0 1px 2px #0003}
        .shadow-again{box-shadow:0 1px 2px #0003}
      </style>
      <h1 class="tracking-wide shadow-sm shadow-again">Tailwind</h1>`,
      { font, width: 320, diagnostics: { unsupportedCss: true, sampleLimit: 2 } }
    );
    expect(result.diagnostics?.unsupportedCss).toEqual([
      {
        property: "box-shadow",
        value: "0 1px 2px #0003",
        count: 2,
        samples: [".shadow-sm { box-shadow: 0 1px 2px #0003 }", ".shadow-again { box-shadow: 0 1px 2px #0003 }"]
      }
    ]);
  });

  it("resolves CSS font families through the helper hook", () => {
    const result = htmlToBoxpdf(`<p style="font-family: Missing, Inter; font-weight: 700">Hello</p>`, {
      font,
      resolveFont: fontFamily({
        Inter: { normal: font, bold, boldItalic }
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

  it("parses CSS font shorthand", () => {
    const result = htmlToBoxpdf(`<p style="font: italic 700 16px/1.5 Inter, sans-serif">Hello</p>`, {
      font,
      boldFont: bold,
      italicFont: font,
      resolveFont: fontFamily({
        Inter: { normal: font, bold, boldItalic }
      })
    });
    const block = result.nodes[0];
    if (block?.kind !== "vstack") throw new Error("expected block");
    const paragraphNode = block.children[0];
    if (paragraphNode?.kind !== "paragraph") throw new Error("expected paragraph");
    const firstRun = paragraphNode.runs[0];
    if (!firstRun || !("text" in firstRun)) throw new Error("expected text run");
    expect(firstRun.style.size).toBe(12);
    expect(firstRun.style.lineHeight).toBe(18);
    expect(firstRun.style.font.name).toBe("Helvetica-BoldOblique");
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
