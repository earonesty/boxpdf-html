import type { BorderSides, EdgesInput, Node as BoxNode, Position, RGB } from "boxpdf";
import type { PDFImage, PDFFont } from "pdf-lib";

export interface HtmlToBoxpdfOptions {
  font: PDFFont;
  boldFont?: PDFFont;
  italicFont?: PDFFont;
  resolveFont?: HtmlFontResolver;
  resolveImage?: HtmlImageResolver;
  baseUrl?: string;
  width?: number;
  defaultFontSize?: number;
  defaultLineHeight?: number;
  defaultColor?: RGB;
}

export type FontWeight = "normal" | "bold" | number;
export type FontStyle = "normal" | "italic";

export interface HtmlFontRequest {
  families: string[];
  weight: FontWeight;
  style: FontStyle;
}

export type HtmlFontResolver = (request: HtmlFontRequest) => PDFFont | undefined;
export type HtmlImageResolver = (request: HtmlImageRequest) => PDFImage | undefined;

export interface HtmlImageRequest {
  url: string;
  baseUrl?: string;
}

export interface HtmlTextNode {
  kind: "text";
  value: string;
  parent?: HtmlElementNode;
}

export interface HtmlElementNode {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  parent?: HtmlElementNode;
}

export type HtmlNode = HtmlTextNode | HtmlElementNode;

export interface ParsedHtml {
  root: HtmlElementNode;
  stylesheets: string[];
}

export type Display = "block" | "inline" | "inline-block" | "flex" | "grid" | "none";
export type GridTrack = { kind: "length"; value: number } | { kind: "percent"; value: number } | { kind: "fr"; value: number };
export type CssLengthPercentage = { length: number; percent: number };

export interface CssStyle {
  display: Display;
  float?: "none" | "left" | "right";
  flexDirection: "row" | "column";
  alignItems: "start" | "center" | "end" | "stretch" | "baseline";
  justifyContent: "start" | "center" | "end" | "between" | "around" | "evenly";
  color?: RGB;
  background?: RGB;
  backgroundImageUrl?: string;
  backgroundSize?: "auto" | "cover" | "contain";
  backgroundRepeat?: "repeat" | "repeat-x" | "repeat-y" | "no-repeat";
  backgroundPositionX?: number;
  backgroundPositionY?: number;
  objectFit?: "fill" | "contain" | "cover";
  fontFamily?: string[];
  fontSize: number;
  fontWeight: FontWeight;
  fontStyle: FontStyle;
  lineHeight?: number;
  lineHeightScale?: number;
  whiteSpace?: "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line";
  textAlign: "left" | "center" | "right";
  verticalAlign: "baseline" | "middle";
  boxSizing: "content-box" | "border-box";
  width?: number;
  widthPercent?: number;
  widthCalc?: CssLengthPercentage;
  minWidth?: number;
  minWidthPercent?: number;
  minWidthCalc?: CssLengthPercentage;
  maxWidth?: number;
  maxWidthPercent?: number;
  maxWidthCalc?: CssLengthPercentage;
  height?: number;
  margin?: EdgesInput;
  padding?: EdgesInput;
  borderWidth?: number;
  borderColor?: RGB;
  borderSides?: BorderSides;
  borderRadius?: number;
  textDecorationLine?: "none" | "underline" | "line-through";
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  listStyleType?: "disc" | "decimal" | "none";
  borderCollapse?: "separate" | "collapse";
  gap?: number;
  columnGap?: number;
  rowGap?: number;
  gridTemplateColumns?: GridTrack[];
  position?: Position;
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
  zIndex?: number;
}

export interface StyledElement {
  node: HtmlElementNode;
  style: CssStyle;
  children: StyledNode[];
}

export interface StyledText {
  node: HtmlTextNode;
  style: CssStyle;
  text: string;
}

export type StyledNode = StyledElement | StyledText;

export interface CssRule {
  selector: string;
  declarations: Partial<CssStyle>;
  importantDeclarations: Partial<CssStyle>;
  specificity: number;
  order: number;
}

export interface RenderResult {
  nodes: BoxNode[];
  warnings: string[];
}
