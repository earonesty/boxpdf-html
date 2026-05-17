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
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(resolved);
  if (hex) {
    const body = hex[1]!;
    const rgb = body.length === 4 ? body.slice(0, 3) : body.length === 8 ? body.slice(0, 6) : body;
    const full = rgb.length === 3 ? rgb.split("").map((c) => c + c).join("") : rgb;
    return {
      r: Number.parseInt(full.slice(0, 2), 16) / 255,
      g: Number.parseInt(full.slice(2, 4), 16) / 255,
      b: Number.parseInt(full.slice(4, 6), 16) / 255
    };
  }
  const rgb = parseRgbFunction(resolved);
  if (rgb) return rgb;
  const hsl = parseHslFunction(resolved);
  if (hsl) return hsl;
  const oklch = parseOklchFunction(resolved);
  if (oklch) return oklch;
  return undefined;
}

function parseRgbFunction(value: string): RGB | undefined {
  const match = /^rgba?\(\s*(.+)\s*\)$/.exec(value);
  if (!match) return undefined;
  const body = match[1]!.split("/")[0]!.trim();
  const parts = body.includes(",") ? body.split(",") : body.split(/\s+/);
  if (parts.length < 3) return undefined;
  const channels = parts.slice(0, 3).map((part) => parseRgbChannel(part.trim()));
  if (channels.some((channel) => channel === undefined)) return undefined;
  return {
    r: channels[0]!,
    g: channels[1]!,
    b: channels[2]!
  };
}

function parseRgbChannel(value: string): number | undefined {
  const percent = /^(-?[0-9.]+)%$/.exec(value);
  if (percent) {
    const amount = Number(percent[1]);
    return Number.isFinite(amount) ? clamp01(amount / 100) : undefined;
  }
  const amount = Number(value);
  return Number.isFinite(amount) ? clamp255(amount) : undefined;
}

function parseHslFunction(value: string): RGB | undefined {
  const match = /^hsla?\(\s*(.+)\s*\)$/.exec(value);
  if (!match) return undefined;
  const body = match[1]!.split("/")[0]!.trim();
  const parts = body.includes(",") ? body.split(",") : body.split(/\s+/);
  if (parts.length < 3) return undefined;
  const hue = parseHue(parts[0]!.trim());
  const saturation = parsePercentChannel(parts[1]!.trim());
  const lightness = parsePercentChannel(parts[2]!.trim());
  if (hue === undefined || saturation === undefined || lightness === undefined) return undefined;
  return hslToRgb(hue, saturation, lightness);
}

function parseHue(value: string): number | undefined {
  const match = /^(-?[0-9.]+)(deg|turn|rad)?$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2] ?? "deg";
  if (unit === "turn") return amount * 360;
  if (unit === "rad") return amount * (180 / Math.PI);
  return amount;
}

function parseOklchFunction(value: string): RGB | undefined {
  const match = /^oklch\(\s*(.+)\s*\)$/.exec(value);
  if (!match) return undefined;
  const body = match[1]!.split("/")[0]!.trim();
  const parts = body.split(/\s+/);
  if (parts.length < 3) return undefined;
  const lightness = parseOklchLightness(parts[0]!);
  const chroma = Number(parts[1]);
  const hue = parseHue(parts[2]!);
  if (lightness === undefined || !Number.isFinite(chroma) || hue === undefined) return undefined;
  return oklchToRgb(lightness, chroma, hue);
}

function parseOklchLightness(value: string): number | undefined {
  const percent = /^(-?[0-9.]+)%$/.exec(value);
  if (percent) {
    const amount = Number(percent[1]);
    return Number.isFinite(amount) ? clamp01(amount / 100) : undefined;
  }
  const amount = Number(value);
  return Number.isFinite(amount) ? clamp01(amount) : undefined;
}

function oklchToRgb(lightness: number, chroma: number, hue: number): RGB {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  return {
    r: linearSrgbToRgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearSrgbToRgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearSrgbToRgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  };
}

function linearSrgbToRgb(value: number): number {
  const converted = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return clamp01(converted);
}

function parsePercentChannel(value: string): number | undefined {
  const match = /^(-?[0-9.]+)%$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? clamp01(amount / 100) : undefined;
}

function hslToRgb(hue: number, saturation: number, lightness: number): RGB {
  const normalizedHue = ((((hue % 360) + 360) % 360) / 360);
  if (saturation === 0) return { r: lightness, g: lightness, b: lightness };
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return {
    r: hueToRgb(p, q, normalizedHue + 1 / 3),
    g: hueToRgb(p, q, normalizedHue),
    b: hueToRgb(p, q, normalizedHue - 1 / 3)
  };
}

function hueToRgb(p: number, q: number, t: number): number {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp255(value: number): number {
  return clamp01(value / 255);
}
