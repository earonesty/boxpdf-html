declare module "css-tree" {
  export function parse(source: string, options?: Record<string, unknown>): unknown;
  export function walk(ast: unknown, callback: (node: { type: string; [key: string]: unknown }) => void): void;
  export function generate(ast: unknown): string;
}
