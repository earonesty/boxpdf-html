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
  if (node.style.display === "contents") return node.children.flatMap((child) => renderNode(child, options, warnings));
  if (node.node.tag === "img") {
    const rendered = renderImageForLayout(node, options, warnings);
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

function renderBlock(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[], stretch = node.style.display === "block"): BoxNode {
  const children = renderBlockChildren(node, options, warnings);
  const style = {
    width: cssBoxWidth(node),
    height: cssBoxHeight(node),
    minHeight: node.style.minHeight,
    maxHeight: node.style.maxHeight,
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
    zIndex: node.style.zIndex,
    opacity: node.style.opacity,
    ...paintTransform(node.style),
    alignSelf: node.style.alignSelf,
    align: stretch ? "stretch" as const : "start" as const
  };
  const rendered = vstack(style, ...children);
  if (node.node.streamContinuation && rendered.kind === "vstack") {
    (
      rendered as unknown as {
        fragmentation?: { kind: "continuation"; id: string; final: boolean };
      }
    ).fragmentation = {
      kind: "continuation",
      ...node.node.streamContinuation
    };
  }
  return rendered;
}

function renderBlockChildren(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode[] {
  const out: BoxNode[] = [];
  let inlineBuffer: StyledNode[] = [];
  let floats: ParagraphFloat[] = [];

  const flushInline = (): void => {
    const runs = collectInlineRuns(inlineBuffer, options, warnings);
    if (runs.length > 0 || floats.length > 0) {
      out.push(paragraph({ width: contentWidth(node), align: node.style.textAlign, wrap: shouldWrap(node.style), floats, textIndent: node.style.textIndent }, ...runs));
      floats = [];
    }
    inlineBuffer = [];
  };

  for (const child of flattenDisplayContents(node.children)) {
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

function flattenDisplayContents(nodes: StyledNode[]): StyledNode[] {
  return nodes.flatMap((node) => {
    if ("text" in node || node.style.display !== "contents") return [node];
    return flattenDisplayContents(node.children);
  });
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
  const ordered = orderedChildren(node.children);
  const sourceChildren = node.style.flexDirection.endsWith("-reverse") ? [...ordered].reverse() : ordered;
  const width = cssBoxWidth(node);
  const justifyWidth = contentWidth(node);
  const children = flexChildrenWithJustification(
    sourceChildren.flatMap((child) => renderFlexChild(child, options, warnings)).map(defaultFlexItem),
    node.style.justifyContent,
    node.style.flexDirection,
    justifyWidth,
    node.style.gap ?? 0
  );
  const style = {
    width,
    height: cssBoxHeight(node),
    minHeight: node.style.minHeight,
    maxHeight: node.style.maxHeight,
    margin: node.style.margin,
    padding: layoutPadding(node),
    gap: node.style.gap ?? 0,
    align: node.style.alignItems,
    justify: children.justify,
    wrap: node.style.flexWrap === "wrap",
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
    zIndex: node.style.zIndex,
    opacity: node.style.opacity,
    ...paintTransform(node.style),
    alignSelf: node.style.alignSelf
  };
  return node.style.flexDirection.startsWith("row") ? hstack(style, ...children.nodes) : vstack(style, ...children.nodes);
}

function flexChildrenWithJustification(
  children: BoxNode[],
  justify: StyledElement["style"]["justifyContent"],
  direction: StyledElement["style"]["flexDirection"],
  width: number | undefined,
  gap: number
): { nodes: BoxNode[]; justify: StyledElement["style"]["justifyContent"] } {
  if (!direction.startsWith("row") || justify !== "between" || children.length < 2) return { nodes: children, justify };
  const available = width ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(available)) return { nodes: children, justify };
  const measuredWidths = children.map((child) => measure(child, Number.POSITIVE_INFINITY).width);
  const childWidth = measuredWidths.reduce((sum, width) => sum + width, 0);
  const spacerWidth = Math.max(0, (available - childWidth - gap * (children.length - 1)) / (children.length - 1));
  const nodes = children.map((child, index) => setFlexItemWidth(child, measuredWidths[index]! + (index === children.length - 1 ? 0 : spacerWidth)));
  return { nodes, justify: "start" };
}

function setFlexItemWidth(node: BoxNode, width: number): BoxNode {
  if (node.kind === "vstack" || node.kind === "hstack") {
    return { ...node, style: { ...node.style, width, shrink: 0 } };
  }
  if (node.kind === "text") {
    return { ...node, props: { ...node.props, width, shrink: 0 } };
  }
  return node;
}

function renderFlexChild(node: StyledNode, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode[] {
  if (!("text" in node) && node.node.tag === "img") {
    const rendered = renderImageForLayout(node, options, warnings);
    return rendered ? [rendered] : [];
  }
  if (!("text" in node) && isInlineContainer(node)) return [renderBlock(node, options, warnings)];
  if (!("text" in node) && node.style.display === "block") return [renderBlock(node, options, warnings, false)];
  return renderNode(node, options, warnings);
}

function renderGrid(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode {
  const gridGap = node.style.columnGap ?? node.style.gap ?? 0;
  const gridWidth =
    contentWidth(node) ??
    (node.style.display === "inline-grid"
      ? inlineGridIntrinsicWidth(node.children.filter(hasRenderedContent).flatMap((child) => renderNode(child, options, warnings)), node.style.gridTemplateColumns, gridGap, options.width)
      : options.width);
  const tracks = resolveGridTracks(node.style.gridTemplateColumns, gridWidth, gridGap);
  if (tracks.length === 0) return renderBlock(node, options, warnings);
  const rows = gridRows(node, tracks, options, warnings);
  const style = {
    width: cssBoxWidth(node),
    height: cssBoxHeight(node),
    minHeight: node.style.minHeight,
    maxHeight: node.style.maxHeight,
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
    zIndex: node.style.zIndex,
    opacity: node.style.opacity,
    ...paintTransform(node.style),
    alignSelf: node.style.alignSelf
  };
  return vstack(style, ...rows);
}

interface GridCell {
  column: number;
  span: number;
  node: BoxNode;
}

function gridRows(node: StyledElement, tracks: number[], options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode[] {
  const rows: GridCell[][] = [];
  let row: GridCell[] = [];
  let cursor = 0;
  const gap = node.style.columnGap ?? node.style.gap ?? 0;
  for (const child of orderedChildren(node.children).filter(hasRenderedContent)) {
    const rendered = renderNode(child, options, warnings);
    if (rendered.length === 0) continue;
    const requestedStart = !("text" in child) ? child.style.gridColumnStart : undefined;
    let column = requestedStart !== undefined ? Math.max(0, requestedStart - 1) : cursor;
    let span = gridColumnSpan(child, tracks.length, column);
    if (column >= tracks.length) column = tracks.length - 1;
    span = Math.max(1, Math.min(span, tracks.length - column));
    if (column < cursor || column + span > tracks.length) {
      rows.push(row);
      row = [];
      cursor = 0;
      column = requestedStart !== undefined ? Math.max(0, Math.min(requestedStart - 1, tracks.length - 1)) : 0;
      span = Math.max(1, Math.min(gridColumnSpan(child, tracks.length, column), tracks.length - column));
    }
    row.push({ column, span, node: gridCellNode(rendered, gridSpanWidth(tracks, column, span, gap)) });
    cursor = column + span;
    if (cursor >= tracks.length) {
      rows.push(row);
      row = [];
      cursor = 0;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows.map((cells) => renderGridRow(cells, tracks, gap, node.style.alignItems));
}

function gridColumnSpan(child: StyledNode, trackCount: number, column: number): number {
  if ("text" in child) return 1;
  if (child.style.gridColumnSpan !== undefined) return child.style.gridColumnSpan;
  if (child.style.gridColumnStart !== undefined && child.style.gridColumnEnd !== undefined) {
    return Math.max(1, child.style.gridColumnEnd - child.style.gridColumnStart);
  }
  return Math.max(1, Math.min(1, trackCount - column));
}

function gridSpanWidth(tracks: number[], column: number, span: number, gap: number): number {
  return tracks.slice(column, column + span).reduce((sum, width) => sum + width, 0) + gap * Math.max(0, span - 1);
}

function gridCellNode(nodes: BoxNode[], width: number): BoxNode {
  const node = nodes.length === 1 ? nodes[0]! : vstack({}, ...nodes);
  return constrainGridItem(node, width);
}

function renderGridRow(cells: GridCell[], tracks: number[], gap: number, align: StyledElement["style"]["alignItems"]): BoxNode {
  const rowChildren: BoxNode[] = [];
  let cursor = 0;
  for (const cell of cells.sort((a, b) => a.column - b.column)) {
    while (cursor < cell.column) {
      rowChildren.push(vstack({ width: tracks[cursor] ?? 0 }));
      cursor += 1;
    }
    rowChildren.push(cell.node);
    cursor = cell.column + cell.span;
  }
  while (cursor < tracks.length) {
    rowChildren.push(vstack({ width: tracks[cursor] ?? 0 }));
    cursor += 1;
  }
  return hstack({ gap, align }, ...stretchGridRow(rowChildren, tracksForCells(cells, tracks, gap, rowChildren.length)));
}

function tracksForCells(cells: GridCell[], tracks: number[], gap: number, childCount: number): number[] {
  if (cells.every((cell) => cell.span === 1) && childCount === tracks.length) return tracks;
  const out: number[] = [];
  let cursor = 0;
  for (const cell of cells.sort((a, b) => a.column - b.column)) {
    while (cursor < cell.column) {
      out.push(tracks[cursor] ?? 0);
      cursor += 1;
    }
    out.push(gridSpanWidth(tracks, cell.column, cell.span, gap));
    cursor = cell.column + cell.span;
  }
  while (cursor < tracks.length) {
    out.push(tracks[cursor] ?? 0);
    cursor += 1;
  }
  return out;
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

function orderedChildren(nodes: StyledNode[]): StyledNode[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => orderFor(a.node) - orderFor(b.node) || a.index - b.index)
    .map(({ node }) => node);
}

function orderFor(node: StyledNode): number {
  return "text" in node ? 0 : node.style.order ?? 0;
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
    return constrainBlockDescendants({ ...node, style: { ...node.style, width: node.style.width ?? width, shrink: node.style.shrink ?? 1 } }, width);
  }
  if (node.kind === "paragraph") {
    return { ...node, props: { ...node.props, width: node.props.width ?? width } };
  }
  if (node.kind === "text") {
    return { ...node, props: { ...node.props, width: node.props.width ?? width, shrink: node.props.shrink ?? 1 } };
  }
  return vstack({ width, shrink: 1 }, node);
}

function constrainBlockDescendants<T extends Extract<BoxNode, { kind: "vstack" | "hstack" }>>(node: T, width: number): T {
  const innerWidth = boxNodeContentWidth(node, width);
  const children = node.children.map((child) => constrainFlowChild(child, innerWidth));
  return { ...node, children };
}

function constrainFlowChild(child: BoxNode, width: number): BoxNode {
  if (child.kind === "paragraph") {
    return { ...child, props: { ...child.props, width: child.props.width === undefined ? width : Math.min(child.props.width, width) } };
  }
  if (child.kind === "text") {
    return { ...child, props: { ...child.props, width: child.props.width === undefined ? width : Math.min(child.props.width, width) } };
  }
  if (child.kind === "vstack" || child.kind === "hstack") {
    const nextWidth = child.style.width === undefined ? width : Math.min(child.style.width, width);
    return constrainBlockDescendants({ ...child, style: { ...child.style, width: nextWidth } }, nextWidth);
  }
  return child;
}

function boxNodeContentWidth(node: Extract<BoxNode, { kind: "vstack" | "hstack" }>, width: number): number {
  const padding = edges(node.style.padding);
  const borderWidth = node.style.border?.width ?? 0;
  const leftBorder = node.style.borderSides?.left?.width ?? borderWidth;
  const rightBorder = node.style.borderSides?.right?.width ?? borderWidth;
  return Math.max(0, width - padding.left - padding.right - leftBorder - rightBorder);
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
      gap: node.style.gap ?? 0,
      ...paintTransform(node.style)
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
      const rendered = renderImageForLayout(node, options, warnings);
      if (rendered) {
        const measured = measure(rendered, contentWidth(node) ?? options.width ?? Number.POSITIVE_INFINITY);
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
    if (node.style.display === "inline" || node.style.display === "contents") {
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
  return renderImageContent(node, options, warnings, node.style.margin, true);
}

function renderImageForLayout(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode | undefined {
  if (!hasImageBoxStyling(node)) return renderImageNode(node, options, warnings);
  const content = renderImageContent(node, options, warnings, undefined, false);
  if (!content) return undefined;
  const style = {
    width: cssBoxWidth(node),
    height: cssBoxHeight(node),
    margin: node.style.margin,
    padding: layoutPadding(node),
    background: node.style.background,
    border: border(node),
    borderSides: node.style.borderSides,
    borderRadius: node.style.borderRadius,
    overflow: node.style.overflow,
    ...paintTransform(node.style),
    shrink: 0
  };
  return vstack(style, content);
}

function renderImageContent(
  node: StyledElement,
  options: HtmlToBoxpdfOptions,
  warnings: string[],
  margin: EdgesInput | undefined,
  decoratedFallback: boolean
): BoxNode | undefined {
  const src = imageUrl(node);
  if (!src) {
    warnings.push("img without a resolvable src was skipped");
    return undefined;
  }
  const pdfImage = options.resolveImage?.({ url: src, baseUrl: options.baseUrl });
  if (!pdfImage) {
    const size = imageSize(node, options);
    if (hasExplicitImageSize(node)) {
      warnings.push(`img src "${src}" did not resolve; preserved its layout box`);
      return vstack({
        width: size.width,
        height: size.height,
        margin,
        border: decoratedFallback ? border(node) : undefined,
        borderSides: decoratedFallback ? node.style.borderSides : undefined,
        borderRadius: decoratedFallback ? node.style.borderRadius : undefined,
        background: decoratedFallback ? node.style.background : undefined
      });
    }
    warnings.push(`img src "${src}" did not resolve`);
    return undefined;
  }
  const size = imageSize(node, options, pdfImage);
  if (node.style.objectFit === "contain" || node.style.objectFit === "cover") {
    return imageFit(pdfImage, { width: size.width, height: size.height, fit: node.style.objectFit, margin });
  }
  return boxImage(pdfImage, { width: size.width, height: size.height, margin });
}

function hasExplicitImageSize(node: StyledElement): boolean {
  return node.style.width !== undefined || node.style.height !== undefined || node.node.attrs.width !== undefined || node.node.attrs.height !== undefined;
}

function hasImageBoxStyling(node: StyledElement): boolean {
  return Boolean(
    node.style.background ||
      node.style.borderWidth ||
      node.style.borderSides ||
      node.style.borderRadius ||
      hasPaintTransform(node.style) ||
      node.style.padding ||
      node.style.overflow
  );
}

function imageSize(node: StyledElement, options: HtmlToBoxpdfOptions, resolvedImage?: ReturnType<NonNullable<HtmlToBoxpdfOptions["resolveImage"]>>): { width: number; height: number } {
  const src = imageUrl(node);
  const pdfImage = resolvedImage ?? (src ? options.resolveImage?.({ url: src, baseUrl: options.baseUrl }) : undefined);
  const naturalWidth = Math.max(1, (pdfImage?.width ?? 1) * 0.75);
  const naturalHeight = Math.max(1, (pdfImage?.height ?? 1) * 0.75);
  const naturalRatio = node.style.aspectRatio ?? (naturalWidth / naturalHeight);
  const width = node.style.width;
  const height = node.style.height;
  if (width !== undefined && height !== undefined) return { width, height };
  if (width !== undefined) return { width, height: width / naturalRatio };
  if (height !== undefined) return { width: height * naturalRatio, height };
  return { width: naturalWidth, height: naturalHeight };
}

function imageUrl(node: StyledElement): string | undefined {
  if (node.node.parent?.tag === "picture") {
    for (const child of node.node.parent.children) {
      if (child.kind !== "element") continue;
      if (child === node.node) break;
      if (child.tag !== "source") continue;
      const selected = srcsetUrl(child.attrs.srcset, targetImageCssWidth(node));
      if (selected) return selected;
    }
  }
  return srcsetUrl(node.node.attrs.srcset, targetImageCssWidth(node)) ?? node.node.attrs.src;
}

function srcsetUrl(value: string | undefined, targetCssPx?: number): string | undefined {
  const candidates = srcsetCandidates(value);
  if (candidates.length === 0) return undefined;
  const widthCandidates = candidates.filter((candidate) => candidate.width !== undefined);
  if (widthCandidates.length > 0) {
    const sorted = widthCandidates.sort((a, b) => a.width! - b.width!);
    if (targetCssPx !== undefined) return sorted.find((candidate) => candidate.width! >= targetCssPx)?.url ?? sorted[sorted.length - 1]?.url;
    return sorted[sorted.length - 1]?.url;
  }
  const densityCandidates = candidates.filter((candidate) => candidate.density !== undefined).sort((a, b) => a.density! - b.density!);
  if (densityCandidates.length > 0) return densityCandidates.find((candidate) => candidate.density! >= 1)?.url ?? densityCandidates[densityCandidates.length - 1]?.url;
  return candidates[0]?.url;
}

function srcsetCandidates(value: string | undefined): Array<{ url: string; width?: number; density?: number }> {
  if (!value) return [];
  return value
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((candidate): { url: string; width?: number; density?: number } | undefined => {
      const [url, descriptor] = candidate.split(/\s+/, 2);
      if (!url) return undefined;
      if (descriptor?.endsWith("w")) {
        const width = Number.parseFloat(descriptor.slice(0, -1));
        return Number.isFinite(width) && width > 0 ? { url, width } : { url };
      }
      if (descriptor?.endsWith("x")) {
        const density = Number.parseFloat(descriptor.slice(0, -1));
        return Number.isFinite(density) && density > 0 ? { url, density } : { url };
      }
      return { url };
    })
    .filter((candidate): candidate is { url: string; width?: number; density?: number } => candidate !== undefined);
}

function targetImageCssWidth(node: StyledElement): number | undefined {
  return node.style.width === undefined ? undefined : node.style.width / 0.75;
}

function renderTable(node: StyledElement, options: HtmlToBoxpdfOptions, warnings: string[]): BoxNode[] {
  const rows = tableRows(node);
  if (rows.length === 0) {
    warnings.push("table without direct tr children was flattened as a block");
    return [renderBlock(node, options, warnings)];
  }
  const transformed = hasPaintTransform(node.style);
  const rendered = table({
    width: cssBoxWidth(node) ?? options.width,
    columns: inferColumns(rows),
    columnGap: 0,
    borderCollapse: node.style.borderCollapse,
    margin: transformed ? undefined : node.style.margin,
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
  });
  if (!transformed) return [rendered];
  const style = {
    width: cssBoxWidth(node) ?? options.width,
    margin: node.style.margin,
    ...paintTransform(node.style)
  };
  return [vstack(style, rendered)];
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
    margin: node.style.margin,
    opacity: node.style.opacity
  };
}

function runStyle(node: StyledText, options: HtmlToBoxpdfOptions): TextRunStyle {
  return {
    size: node.style.fontSize,
    font: fontFor(node, options),
    color: node.style.color ?? options.defaultColor,
    lineHeight: node.style.lineHeight,
    underline: node.style.textDecorationLine === "underline",
    strikethrough: node.style.textDecorationLine === "line-through",
    letterSpacing: node.style.letterSpacing
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

function paintTransform(style: StyledElement["style"]) {
  const transform = [
    ...(style.translate ? [{ kind: "translate" as const, ...style.translate }] : []),
    ...(style.rotate !== undefined ? [{ kind: "rotate" as const, degrees: style.rotate }] : []),
    ...(style.scale ? [{ kind: "scale" as const, ...style.scale }] : []),
    ...(style.transform ?? [])
  ];
  return {
    transform: transform.length > 0 ? transform : undefined,
    transformOrigin: style.transformOrigin
  };
}

function hasPaintTransform(style: StyledElement["style"]): boolean {
  return Boolean(
    style.translate ||
      style.rotate !== undefined ||
      style.scale ||
      (style.transform && style.transform.length > 0)
  );
}

function hasBoxStyling(node: StyledElement): boolean {
  return Boolean(
    node.style.background ||
      node.style.backgroundImageUrl ||
      node.style.borderWidth ||
      node.style.borderSides ||
      node.style.borderRadius ||
      hasPaintTransform(node.style) ||
      node.style.padding ||
      node.style.width !== undefined ||
      node.style.height !== undefined
  );
}
