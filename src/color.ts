import type { RGB } from "boxpdf";

const namedColors: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  transparent: "transparent"
};

export function parseColor(value: string | undefined): RGB | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  const resolved = namedColors[normalized] ?? normalized;
  if (resolved === "transparent") return undefined;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(resolved);
  if (hex) {
    const body = hex[1]!;
    const full = body.length === 3 ? body.split("").map((c) => c + c).join("") : body;
    return {
      r: Number.parseInt(full.slice(0, 2), 16) / 255,
      g: Number.parseInt(full.slice(2, 4), 16) / 255,
      b: Number.parseInt(full.slice(4, 6), 16) / 255
    };
  }
  const rgb = /^rgb\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)$/.exec(resolved);
  if (rgb) {
    return {
      r: clamp255(Number(rgb[1])),
      g: clamp255(Number(rgb[2])),
      b: clamp255(Number(rgb[3]))
    };
  }
  return undefined;
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, value)) / 255;
}
