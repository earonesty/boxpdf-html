import type { EdgesInput, Node as BoxNode, RGB } from "boxpdf";
import type { PDFFont } from "pdf-lib";

export interface HtmlToBoxpdfOptions {
  font: PDFFont;
  boldFont?: PDFFont;
  italicFont?: PDFFont;
  baseUrl?: string;
  width?: number;
  defaultFontSize?: number;
  defaultLineHeight?: number;
  defaultColor?: RGB;
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

export type Display = "block" | "inline" | "inline-block" | "flex" | "none";

export interface CssStyle {
  display: Display;
  flexDirection: "row" | "column";
  alignItems: "start" | "center" | "end" | "stretch" | "baseline";
  justifyContent: "start" | "center" | "end" | "between" | "around" | "evenly";
  color?: RGB;
  background?: RGB;
  fontSize: number;
  fontWeight: "normal" | "bold";
  fontStyle: "normal" | "italic";
  lineHeight?: number;
  textAlign: "left" | "center" | "right";
  verticalAlign: "baseline" | "middle";
  width?: number;
  height?: number;
  margin?: EdgesInput;
  padding?: EdgesInput;
  borderWidth?: number;
  borderColor?: RGB;
  gap?: number;
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
  specificity: number;
  order: number;
}

export interface RenderResult {
  nodes: BoxNode[];
  warnings: string[];
}
