import {
  hline,
  hstack,
  paragraph,
  run,
  table,
  text,
  vstack,
  type Node as BoxNode,
  type ParagraphItem,
  type TextRunStyle
} from "boxpdf";
import type { HtmlToBoxpdfOptions, RenderResult, StyledElement, StyledNode, StyledText } from "./types.js";

export function renderStyledTree(root: StyledElement, options: HtmlToBoxpdfOptions): RenderResult {
  const warnings: string[] = [];
  const nodes = root.children.flatMap((child) => renderNode(child, options, warnings));
  return { nodes, warnings };
}

function renderNode(node: StyledNode, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode[] {
  if ("text" in node) {
    const trimmed = node.text.trim();
    return trimmed ? [text(trimmed, textOptions(node, options))] : [];
  }
  if (node.style.display === "none") return [];
  if (node.node.tag === "br") return [text("", textOptions({ style: node.style } as StyledText, options))];
  if (node.node.tag === "hr") return [hline({ color: node.style.borderColor ?? { r: 0, g: 0, b: 0 }, thickness: node.style.borderWidth ?? 1 })];
  if (node.node.tag === "table") return renderTable(node, options, warnings);
  if (node.style.display === "flex") return [renderFlex(node, options, warnings)];
  if (node.style.display === "inline" || node.style.display === "inline-block") {
    return renderInlineGroup(node, options, warnings);
  }
  return [renderBlock(node, options, warnings)];
}

function renderBlock(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode {
  const children = renderBlockChildren(node, options, warnings);
  return vstack(
    {
      width: node.style.width,
      height: node.style.height,
      margin: node.style.margin,
      padding: node.style.padding,
      gap: node.style.gap ?? 0,
      background: node.style.background,
      border: border(node)
    },
    ...children
  );
}

function renderBlockChildren(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode[] {
  const out: BoxNode[] = [];
  let inlineBuffer: StyledNode[] = [];

  const flushInline = (): void => {
    const runs = collectInlineRuns(inlineBuffer, options);
    if (runs.length > 0) {
      out.push(paragraph({ width: node.style.width, align: node.style.textAlign }, ...runs));
    }
    inlineBuffer = [];
  };

  for (const child of node.children) {
    if (isInlineLike(child)) {
      inlineBuffer.push(child);
      continue;
    }
    flushInline();
    out.push(...renderNode(child, options, warnings));
  }
  flushInline();
  return out;
}

function renderFlex(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode {
  const children = node.children.flatMap((child) => renderNode(child, options, warnings));
  const style = {
    width: node.style.width,
    height: node.style.height,
    margin: node.style.margin,
    padding: node.style.padding,
    gap: node.style.gap ?? 0,
    align: node.style.alignItems,
    justify: node.style.justifyContent,
    background: node.style.background,
    border: border(node)
  };
  return node.style.flexDirection === "row" ? hstack(style, ...children) : vstack(style, ...children);
}

function renderInlineGroup(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode[] {
  const runs = collectInlineRuns([node], options);
  if (runs.length === 0) return [];
  return [paragraph({ width: node.style.width, align: node.style.textAlign }, ...runs)];
}

function collectInlineRuns(nodes: StyledNode[], options: HtmlToBoxpdfOptions): ParagraphItem[] {
  const runs: ParagraphItem[] = [];
  for (const node of nodes) {
    if ("text" in node) {
      if (node.text.trim()) runs.push(run(node.text, runStyle(node, options)));
      continue;
    }
    if (node.style.display === "inline" || node.style.display === "inline-block") {
      runs.push(...collectInlineRuns(node.children, options));
    }
  }
  return runs;
}

function renderTable(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode[] {
  const rows = tableRows(node);
  if (rows.length === 0) {
    warnings.push("table without direct tr children was flattened as a block");
    return [renderBlock(node, options, warnings)];
  }
  return [
    table({
      width: node.style.width ?? options.width,
      columns: inferColumns(rows),
      columnGap: 0,
      margin: node.style.margin,
      rows: rows.map((row) =>
        row.children
          .filter((child): child is StyledElement => !("text" in child) && (child.node.tag === "td" || child.node.tag === "th"))
          .map((cell) => ({
            content: renderCellContent(cell, options, warnings),
            padding: cell.style.padding ?? 4,
            background: cell.style.background,
            border: border(cell),
            align: cell.style.textAlign,
            valign: cell.style.verticalAlign === "middle" ? "middle" : "top"
          }))
      )
    })
  ];
}

function renderCellContent(cell: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode {
  const children = renderBlockChildren(cell, options, warnings);
  if (children.length === 1) return children[0]!;
  return vstack({ gap: cell.style.gap ?? 0 }, ...children);
}

function tableRows(node: StyledElement): StyledElement[] {
  const rows: StyledElement[] = [];
  for (const child of node.children) {
    if ("text" in child) continue;
    if (child.node.tag === "tr") rows.push(child);
    if (child.node.tag === "thead" || child.node.tag === "tbody" || child.node.tag === "tfoot") {
      rows.push(...child.children.filter((row): row is StyledElement => !("text" in row) && row.node.tag === "tr"));
    }
  }
  return rows;
}

function isInlineLike(node: StyledNode): boolean {
  return "text" in node || node.style.display === "inline" || node.style.display === "inline-block";
}

function inferColumns(rows: StyledElement[]): Array<{ width: `${number}fr` }> {
  const count = Math.max(
    1,
    ...rows.map((row) =>
      row.children.filter((child) => !("text" in child) && (child.node.tag === "td" || child.node.tag === "th")).length
    )
  );
  return Array.from({ length: count }, () => ({ width: "1fr" as const }));
}

function textOptions(node: StyledText, options: HtmlToBoxpdfOptions) {
  return {
    ...runStyle(node, options),
    width: node.style.width,
    align: node.style.textAlign,
    margin: node.style.margin
  };
}

function runStyle(node: StyledText, options: HtmlToBoxpdfOptions): TextRunStyle {
  return {
    size: node.style.fontSize,
    font: fontFor(node, options),
    color: node.style.color ?? options.defaultColor,
    lineHeight: node.style.lineHeight
  };
}

function fontFor(node: StyledText, options: HtmlToBoxpdfOptions) {
  const resolved = options.resolveFont?.({
    families: node.style.fontFamily ?? [],
    weight: node.style.fontWeight,
    style: node.style.fontStyle
  });
  if (resolved) return resolved;
  if (isBold(node.style.fontWeight)) return options.boldFont ?? options.font;
  if (node.style.fontStyle === "italic") return options.italicFont ?? options.font;
  return options.font;
}

function isBold(weight: StyledText["style"]["fontWeight"]): boolean {
  return weight === "bold" || (typeof weight === "number" && weight >= 600);
}

function border(node: StyledElement) {
  if (!node.style.borderWidth || !node.style.borderColor) return undefined;
  return { width: node.style.borderWidth, color: node.style.borderColor };
}
