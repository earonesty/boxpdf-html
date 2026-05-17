import {
  type BackgroundImage,
  hline,
  hstack,
  image as boxImage,
  imageFit,
  inlineNode,
  measure,
  paragraph,
  type ParagraphFloat,
  run,
  table,
  text,
  vstack,
  type Node as BoxNode,
  type ParagraphItem,
  type TextRunStyle
} from "boxpdf";
import type { GridTrack, HtmlToBoxpdfOptions, RenderResult, StyledElement, StyledNode, StyledText } from "./types.js";
import type { EdgesInput } from "boxpdf";

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
  if (node.node.tag === "img") {
    const rendered = renderImageNode(node, options, warnings);
    return rendered ? [rendered] : [];
  }
  if (node.node.tag === "br") return [text("", textOptions({ style: node.style } as StyledText, options))];
  if (node.node.tag === "hr") return [hline({ color: node.style.borderColor ?? { r: 0, g: 0, b: 0 }, thickness: node.style.borderWidth ?? 1 })];
  if (node.node.tag === "ul" || node.node.tag === "ol") return [renderList(node, options, warnings)];
  if (node.node.tag === "table") return renderTable(node, options, warnings);
  if (node.style.display === "grid" || node.style.display === "inline-grid") return [renderGrid(node, options, warnings)];
  if (node.style.display === "flex" || node.style.display === "inline-flex") return [renderFlex(node, options, warnings)];
  if (isInlineContainer(node)) {
    return renderInlineGroup(node, options, warnings);
  }
  return [renderBlock(node, options, warnings)];
}

function renderBlock(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode {
  const children = renderBlockChildren(node, options, warnings);
  return vstack(
    {
      width: cssBoxWidth(node),
      height: cssBoxHeight(node),
      margin: node.style.margin,
      padding: layoutPadding(node),
      gap: node.style.gap ?? 0,
      background: node.style.background,
      backgroundImage: backgroundImage(node, options),
      border: border(node),
      borderSides: node.style.borderSides,
      borderRadius: node.style.borderRadius,
      overflow: node.style.overflow,
      position: node.style.position,
      top: node.style.top,
      right: node.style.right,
      bottom: node.style.bottom,
      left: node.style.left,
      zIndex: node.style.zIndex
    },
    ...children
  );
}

function renderBlockChildren(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode[] {
  const out: BoxNode[] = [];
  let inlineBuffer: StyledNode[] = [];
  let floats: ParagraphFloat[] = [];

  const flushInline = (): void => {
    const runs = collectInlineRuns(inlineBuffer, options, warnings);
    if (runs.length > 0 || floats.length > 0) {
      out.push(paragraph({ width: contentWidth(node), align: node.style.textAlign, wrap: shouldWrap(node.style), floats }, ...runs));
      floats = [];
    }
    inlineBuffer = [];
  };

  for (const child of node.children) {
    if (!("text" in child) && child.style.float && child.style.float !== "none") {
      floats.push({ node: renderFloatNode(child, options, warnings), side: child.style.float });
      continue;
    }
    if (isInlineLike(child)) {
      inlineBuffer.push(child);
      continue;
    }
    if (inlineBuffer.some(hasInlineContent)) flushInline();
    else inlineBuffer = [];
    const rendered = renderNode(child, options, warnings);
    if (floats.length > 0) {
      const attached = attachFloatsToFirstParagraph(rendered, floats);
      if (attached.attached) {
        out.push(...attached.nodes);
        floats = [];
        continue;
      }
      flushInline();
    }
    out.push(...rendered);
  }
  flushInline();
  return out;
}

function hasInlineContent(node: StyledNode): boolean {
  if ("text" in node) return node.text.trim().length > 0;
  if (node.node.tag === "br") return true;
  return node.children.some(hasInlineContent);
}

function renderFloatNode(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode {
  if (node.node.tag === "table") return renderTable(node, options, warnings)[0] ?? renderBlock(node, options, warnings);
  if (node.style.display === "flex" || node.style.display === "inline-flex") return renderFlex(node, options, warnings);
  if (node.style.display === "grid" || node.style.display === "inline-grid") return renderGrid(node, options, warnings);
  return renderBlock(node, options, warnings);
}

function attachFloatsToFirstParagraph(nodes: BoxNode[], floats: ParagraphFloat[]): { nodes: BoxNode[]; attached: boolean } {
  let attached = false;
  const next = nodes.map((node) => {
    if (attached) return node;
    const result = attachFloatsToNode(node, floats);
    attached = result.attached;
    return result.node;
  });
  return { nodes: next, attached };
}

function attachFloatsToNode(node: BoxNode, floats: ParagraphFloat[]): { node: BoxNode; attached: boolean } {
  if (node.kind === "paragraph") {
    return { node: { ...node, props: { ...node.props, floats: [...floats, ...(node.props.floats ?? [])] } }, attached: true };
  }
  if (node.kind !== "vstack" && node.kind !== "hstack") return { node, attached: false };
  let attached = false;
  const children = node.children.map((child) => {
    if (attached) return child;
    const result = attachFloatsToNode(child, floats);
    attached = result.attached;
    return result.node;
  });
  return attached ? { node: { ...node, children }, attached } : { node, attached };
}

function renderFlex(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode {
  const children = node.children.flatMap((child) => renderNode(child, options, warnings)).map(defaultFlexItem);
  const style = {
    width: cssBoxWidth(node),
    height: cssBoxHeight(node),
    margin: node.style.margin,
    padding: layoutPadding(node),
    gap: node.style.gap ?? 0,
    align: node.style.alignItems,
    justify: node.style.justifyContent,
    background: node.style.background,
    backgroundImage: backgroundImage(node, options),
    border: border(node),
    borderSides: node.style.borderSides,
    borderRadius: node.style.borderRadius,
    overflow: node.style.overflow,
    position: node.style.position,
    top: node.style.top,
    right: node.style.right,
    bottom: node.style.bottom,
    left: node.style.left,
    zIndex: node.style.zIndex
  };
  return node.style.flexDirection === "row" ? hstack(style, ...children) : vstack(style, ...children);
}

function renderGrid(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode {
  const children = node.children.filter(hasRenderedContent).flatMap((child) => renderNode(child, options, warnings));
  const gridGap = node.style.columnGap ?? node.style.gap ?? 0;
  const gridWidth =
    contentWidth(node) ??
    (node.style.display === "inline-grid"
      ? inlineGridIntrinsicWidth(children, node.style.gridTemplateColumns, gridGap, options.width)
      : options.width);
  const tracks = resolveGridTracks(node.style.gridTemplateColumns, gridWidth, gridGap);
  if (tracks.length === 0) return renderBlock(node, options, warnings);
  const rows: BoxNode[] = [];
  for (let index = 0; index < children.length; index += tracks.length) {
    const rowChildren = children
      .slice(index, index + tracks.length)
      .map((child, childIndex) => constrainGridItem(child, tracks[childIndex] ?? tracks[tracks.length - 1]!));
    rows.push(hstack({ gap: node.style.columnGap ?? node.style.gap ?? 0, align: node.style.alignItems }, ...stretchGridRow(rowChildren, tracks)));
  }
  return vstack(
    {
      width: cssBoxWidth(node),
      height: cssBoxHeight(node),
      margin: node.style.margin,
      padding: layoutPadding(node),
      gap: node.style.rowGap ?? node.style.gap ?? 0,
      background: node.style.background,
      backgroundImage: backgroundImage(node, options),
      border: border(node),
      borderSides: node.style.borderSides,
      borderRadius: node.style.borderRadius,
      overflow: node.style.overflow,
      position: node.style.position,
      top: node.style.top,
      right: node.style.right,
      bottom: node.style.bottom,
      left: node.style.left,
      zIndex: node.style.zIndex
    },
    ...rows
  );
}

function inlineGridIntrinsicWidth(children: BoxNode[], tracks: GridTrack[] | undefined, gap: number, parentWidth: number | undefined): number | undefined {
  if (!tracks || tracks.length === 0) {
    const widths = children.map((child) => measure(child, parentWidth ?? Number.POSITIVE_INFINITY).width);
    return widths.length === 0 ? undefined : Math.max(0, ...widths);
  }
  const widths = tracks.map((track, trackIndex) => {
    if (track.kind === "length") return track.value;
    return children
      .filter((_, childIndex) => childIndex % tracks.length === trackIndex)
      .reduce((max, child) => Math.max(max, measure(child, parentWidth ?? Number.POSITIVE_INFINITY).width), 0);
  });
  return widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
}

function hasRenderedContent(node: StyledNode): boolean {
  if ("text" in node) return node.text.trim().length > 0;
  return node.style.display !== "none";
}

function resolveGridTracks(tracks: GridTrack[] | undefined, width: number | undefined, gap: number): number[] {
  if (!tracks || tracks.length === 0) {
    return width === undefined ? [] : [width];
  }
  const available = width === undefined ? undefined : Math.max(0, width - gap * Math.max(0, tracks.length - 1));
  const fixed = tracks.reduce((sum, track) => {
    if (track.kind === "length") return sum + track.value;
    if (track.kind === "percent" && available !== undefined) return sum + available * track.value;
    return sum;
  }, 0);
  const fr = tracks.reduce((sum, track) => sum + (track.kind === "fr" ? track.value : 0), 0);
  const frUnit = available === undefined || fr === 0 ? 0 : Math.max(0, available - fixed) / fr;
  return tracks.map((track) => {
    if (track.kind === "length") return track.value;
    if (track.kind === "percent" && available !== undefined) return available * track.value;
    return frUnit * track.value;
  });
}

function constrainGridItem(node: BoxNode, width: number): BoxNode {
  if (node.kind === "vstack" || node.kind === "hstack") {
    return { ...node, style: { ...node.style, width: node.style.width ?? width, shrink: node.style.shrink ?? 1 } };
  }
  if (node.kind === "paragraph") {
    return { ...node, props: { ...node.props, width: node.props.width ?? width } };
  }
  if (node.kind === "text") {
    return { ...node, props: { ...node.props, width: node.props.width ?? width, shrink: node.props.shrink ?? 1 } };
  }
  return vstack({ width, shrink: 1 }, node);
}

function stretchGridRow(nodes: BoxNode[], tracks: number[]): BoxNode[] {
  const heights = nodes.map((node, index) => measure(node, tracks[index] ?? tracks[tracks.length - 1] ?? Number.POSITIVE_INFINITY).height);
  const rowHeight = Math.max(0, ...heights);
  return nodes.map((node, index) => {
    if (node.kind === "vstack" || node.kind === "hstack") {
      return { ...node, style: { ...node.style, height: node.style.height ?? rowHeight } };
    }
    return vstack({ width: tracks[index], height: rowHeight }, node);
  });
}

function defaultFlexItem(node: BoxNode): BoxNode {
  if (node.kind === "vstack" || node.kind === "hstack") {
    return { ...node, style: { ...node.style, shrink: node.style.shrink ?? 1 } };
  }
  if (node.kind === "text") {
    return { ...node, props: { ...node.props, shrink: node.props.shrink ?? 1 } };
  }
  return node;
}

function renderInlineGroup(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode[] {
  const runs = collectInlineRuns([node], options, warnings);
  if (runs.length === 0) return [];
  return [paragraph({ width: contentWidth(node), align: node.style.textAlign, wrap: shouldWrap(node.style) }, ...runs)];
}

function renderList(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode {
  const items = node.children.filter((child): child is StyledElement => !("text" in child) && child.node.tag === "li");
  const listPadding = edges(node.style.padding);
  const markerWidth = Math.max(node.style.fontSize * 1.5, listPadding.left * 0.65);
  const leftPadding = node.style.listStyleType === "none" ? listPadding.left : Math.max(0, listPadding.left - markerWidth);
  return vstack(
    {
      margin: node.style.margin,
      padding: { ...listPadding, left: leftPadding },
      gap: node.style.gap ?? 0
    },
    ...items.flatMap((item, index) => renderListItem(item, index, node.style.listStyleType, markerWidth, options, warnings))
  );
}

function renderListItem(
  item: StyledElement,
  index: number,
  listStyleType: StyledElement["style"]["listStyleType"],
  markerWidth: number,
  options: HtmlToBoxpdfOptions,
  warnings: string[]
): BoxNode[] {
  const runs = collectInlineRuns(item.children, options, warnings);
  const marker = listStyleType === "none" ? "" : listStyleType === "decimal" ? `${index + 1}.  ` : "•  ";
  const paragraphs = runs.length > 0
    ? [
        paragraph(
          {
            width: item.style.width,
            align: item.style.textAlign,
            margin: item.style.margin,
            paddingLeft: marker ? markerWidth : 0,
            textIndent: marker ? -markerWidth : 0,
            wrap: shouldWrap(item.style)
          },
          ...(marker ? [run(marker, runStyle({ style: item.style } as StyledText, options))] : []),
          ...runs
        )
      ]
    : [];
  const blockChildren = item.children.filter((child) => !isInlineLike(child)).flatMap((child) => renderNode(child, options, warnings));
  return [...paragraphs, ...blockChildren];
}

function collectInlineRuns(nodes: StyledNode[], options: HtmlToBoxpdfOptions, warnings: string[]): ParagraphItem[] {
  const runs: ParagraphItem[] = [];
  for (const node of nodes) {
    if ("text" in node) {
      if (preservesWhitespace(node.style) && node.text.length > 0) {
        runs.push(run(node.text, runStyle(node, options)));
      } else if (node.text.trim()) {
        runs.push(run(node.text, runStyle(node, options)));
      } else if (runs.length > 0) {
        runs.push(run(" ", runStyle(node, options)));
      }
      continue;
    }
    if (node.node.tag === "br") {
      runs.push(run("\n", runStyle({ style: node.style } as StyledText, options)));
      continue;
    }
    if (node.node.tag === "img") {
      const rendered = renderImageNode(node, options, warnings);
      if (rendered) {
        const measured = imageSize(node, options);
        runs.push(inlineNode(rendered, { width: measured.width, height: measured.height, verticalAlign: node.style.verticalAlign === "middle" ? "middle" : undefined }));
      }
      continue;
    }
    if (isAtomicInlineContainer(node)) {
      const rendered = renderAtomicInlineNode(node, options, warnings);
      const measured = measure(rendered, contentWidth(node) ?? options.width ?? Number.POSITIVE_INFINITY);
      runs.push(inlineNode(rendered, { width: measured.width, height: measured.height, verticalAlign: node.style.verticalAlign === "middle" ? "middle" : undefined }));
      continue;
    }
    if (node.style.display === "inline") {
      runs.push(...collectInlineRuns(node.children, options, warnings));
    }
  }
  return runs;
}

function renderAtomicInlineNode(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode {
  if (node.style.display === "inline-flex") return renderFlex(node, options, warnings);
  if (node.style.display === "inline-grid") return renderGrid(node, options, warnings);
  return renderBlock(node, options, warnings);
}

function renderImageNode(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode | undefined {
  const src = node.node.attrs.src;
  if (!src || !options.resolveImage) {
    warnings.push("img without a resolvable src was skipped");
    return undefined;
  }
  const pdfImage = options.resolveImage({ url: src, baseUrl: options.baseUrl });
  if (!pdfImage) {
    warnings.push(`img src "${src}" did not resolve`);
    return undefined;
  }
  const size = imageSize(node, options, pdfImage);
  if (node.style.objectFit === "contain" || node.style.objectFit === "cover") {
    return imageFit(pdfImage, { width: size.width, height: size.height, fit: node.style.objectFit, margin: node.style.margin });
  }
  return boxImage(pdfImage, { width: size.width, height: size.height, margin: node.style.margin });
}

function imageSize(node: StyledElement, options: HtmlToBoxpdfOptions, resolvedImage?: ReturnType<NonNullable<HtmlToBoxpdfOptions["resolveImage"]>>): { width: number; height: number } {
  const src = node.node.attrs.src;
  const pdfImage = resolvedImage ?? (src ? options.resolveImage?.({ url: src, baseUrl: options.baseUrl }) : undefined);
  const naturalWidth = Math.max(1, (pdfImage?.width ?? 1) * 0.75);
  const naturalHeight = Math.max(1, (pdfImage?.height ?? 1) * 0.75);
  const width = node.style.width;
  const height = node.style.height;
  if (width !== undefined && height !== undefined) return { width, height };
  if (width !== undefined) return { width, height: width * (naturalHeight / naturalWidth) };
  if (height !== undefined) return { width: height * (naturalWidth / naturalHeight), height };
  return { width: naturalWidth, height: naturalHeight };
}

function renderTable(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode[] {
  const rows = tableRows(node);
  if (rows.length === 0) {
    warnings.push("table without direct tr children was flattened as a block");
    return [renderBlock(node, options, warnings)];
  }
  return [
    table({
      width: cssBoxWidth(node) ?? options.width,
      columns: inferColumns(rows),
      columnGap: 0,
      borderCollapse: node.style.borderCollapse,
      margin: node.style.margin,
      rows: rows.map((row) =>
        row.children
          .filter((child): child is StyledElement => !("text" in child) && (child.node.tag === "td" || child.node.tag === "th"))
          .map((cell) => ({
            content: renderCellContent(cell, options, warnings),
            padding: layoutPadding(cell, 4),
            background: cell.style.background,
            backgroundImage: backgroundImage(cell, options),
            border: border(cell),
            borderSides: cell.style.borderSides,
            borderRadius: cell.style.borderRadius,
            overflow: cell.style.overflow,
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
  return "text" in node || isInlineContainer(node);
}

function isInlineContainer(node: StyledElement): boolean {
  return node.style.display === "inline" || isAtomicInlineContainer(node);
}

function isAtomicInlineContainer(node: StyledElement): boolean {
  return node.style.display === "inline-block" || node.style.display === "inline-flex" || node.style.display === "inline-grid";
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

function cssBoxWidth(node: StyledElement): number | undefined {
  if (node.style.width === undefined) return undefined;
  if (node.style.boxSizing === "border-box") return node.style.width;
  const padding = edges(node.style.padding);
  const borders = borderWidths(node);
  return node.style.width + padding.left + padding.right + borders.left + borders.right;
}

function cssBoxHeight(node: StyledElement): number | undefined {
  if (node.style.height === undefined) return undefined;
  if (node.style.boxSizing === "border-box") return node.style.height;
  const padding = edges(node.style.padding);
  const borders = borderWidths(node);
  return node.style.height + padding.top + padding.bottom + borders.top + borders.bottom;
}

function contentWidth(node: StyledElement): number | undefined {
  if (node.style.width !== undefined && node.style.boxSizing === "border-box") {
    const padding = edges(node.style.padding);
    const borders = borderWidths(node);
    return Math.max(0, node.style.width - padding.left - padding.right - borders.left - borders.right);
  }
  return node.style.width;
}

function edges(input: EdgesInput | undefined): { top: number; right: number; bottom: number; left: number } {
  if (input === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof input === "number") return { top: input, right: input, bottom: input, left: input };
  return {
    top: input.top ?? 0,
    right: input.right ?? 0,
    bottom: input.bottom ?? 0,
    left: input.left ?? 0
  };
}

function borderWidths(node: StyledElement): { top: number; right: number; bottom: number; left: number } {
  const all = node.style.borderWidth ?? 0;
  return {
    top: node.style.borderSides?.top?.width ?? all,
    right: node.style.borderSides?.right?.width ?? all,
    bottom: node.style.borderSides?.bottom?.width ?? all,
    left: node.style.borderSides?.left?.width ?? all
  };
}

function layoutPadding(node: StyledElement, fallback?: EdgesInput): EdgesInput | undefined {
  const padding = edges(node.style.padding ?? fallback);
  const borders = borderWidths(node);
  const out = {
    top: padding.top + borders.top,
    right: padding.right + borders.right,
    bottom: padding.bottom + borders.bottom,
    left: padding.left + borders.left
  };
  if (out.top === 0 && out.right === 0 && out.bottom === 0 && out.left === 0) return undefined;
  if (out.top === out.right && out.right === out.bottom && out.bottom === out.left) return out.top;
  return out;
}

function backgroundImage(node: StyledElement, options: HtmlToBoxpdfOptions): BackgroundImage | undefined {
  if (!node.style.backgroundImageUrl || !options.resolveImage) return undefined;
  const image = options.resolveImage({ url: node.style.backgroundImageUrl, baseUrl: options.baseUrl });
  if (!image) return undefined;
  const width = cssBoxWidth(node);
  const height = cssBoxHeight(node);
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  const sizing = node.style.backgroundSize ?? "auto";
  const naturalWidth = image.width * 0.75;
  const naturalHeight = image.height * 0.75;
  const scale =
    sizing === "cover"
      ? Math.max(width / naturalWidth, height / naturalHeight)
      : sizing === "contain"
        ? Math.min(width / naturalWidth, height / naturalHeight)
        : 1;
  const imageWidth = naturalWidth * scale;
  const imageHeight = naturalHeight * scale;
  const x = node.style.backgroundPositionX ?? 0;
  const y = node.style.backgroundPositionY ?? 0;
  return {
    image,
    width: imageWidth,
    height: imageHeight,
    offsetX: (width - imageWidth) * x,
    offsetY: (height - imageHeight) * y,
    repeat: node.style.backgroundRepeat ?? "repeat"
  };
}

function textOptions(node: StyledText, options: HtmlToBoxpdfOptions) {
  return {
    ...runStyle(node, options),
    width: node.style.width,
    wrap: shouldWrap(node.style),
    align: node.style.textAlign,
    margin: node.style.margin
  };
}

function runStyle(node: StyledText, options: HtmlToBoxpdfOptions): TextRunStyle {
  return {
    size: node.style.fontSize,
    font: fontFor(node, options),
    color: node.style.color ?? options.defaultColor,
    lineHeight: node.style.lineHeight,
    underline: node.style.textDecorationLine === "underline",
    strikethrough: node.style.textDecorationLine === "line-through"
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

function shouldWrap(style: StyledText["style"]): boolean {
  return style.whiteSpace !== "nowrap" && style.whiteSpace !== "pre";
}

function preservesWhitespace(style: StyledText["style"]): boolean {
  return style.whiteSpace === "pre" || style.whiteSpace === "pre-wrap";
}

function border(node: StyledElement) {
  if (!node.style.borderWidth || !node.style.borderColor) return undefined;
  return { width: node.style.borderWidth, color: node.style.borderColor };
}
