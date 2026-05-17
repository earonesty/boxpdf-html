export interface LengthPercentage {
  length: number;
  percent: number;
}

const ROOT_FONT_SIZE = 12;
const VIEWPORT_WIDTH = 612;
const VIEWPORT_HEIGHT = 792;

export function parseLength(value: string | undefined, fontSize: number): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized.endsWith("%")) return undefined;
  if (isCalc(normalized)) {
    const parsed = parseLengthPercentage(normalized, fontSize);
    return parsed && parsed.percent === 0 ? parsed.length : undefined;
  }
  return parseSimpleLength(normalized, fontSize);
}

export function parsePercentage(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (isCalc(normalized)) {
    const parsed = parseLengthPercentage(normalized, 12);
    return parsed && parsed.length === 0 ? parsed.percent : undefined;
  }
  const match = /^(-?[0-9.]+)%$/.exec(normalized);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount / 100 : undefined;
}

export function parseLengthPercentage(value: string | undefined, fontSize: number): LengthPercentage | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!isCalc(normalized)) {
    const percent = parseSimplePercentage(normalized);
    if (percent !== undefined) return { length: 0, percent };
    const length = parseSimpleLength(normalized, fontSize);
    return length === undefined ? undefined : { length, percent: 0 };
  }
  const body = normalized.slice(5, -1).trim();
  const tokens = body.replace(/([+-])/g, " $1 ").trim().split(/\s+/);
  let sign = 1;
  let length = 0;
  let percent = 0;
  for (const token of tokens) {
    if (token === "+") {
      sign = 1;
      continue;
    }
    if (token === "-") {
      sign = -1;
      continue;
    }
    const tokenPercent = parseSimplePercentage(token);
    if (tokenPercent !== undefined) {
      percent += sign * tokenPercent;
      sign = 1;
      continue;
    }
    const tokenLength = parseSimpleLength(token, fontSize);
    if (tokenLength === undefined) return undefined;
    length += sign * tokenLength;
    sign = 1;
  }
  return { length, percent };
}

export function parseLineHeight(value: string | undefined, fontSize: number): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "normal") return undefined;
  const unitless = /^([0-9.]+)$/.exec(normalized);
  if (unitless) return Number(unitless[1]) * fontSize;
  return parseLength(normalized, fontSize);
}

function isCalc(value: string): boolean {
  return /^calc\(.+\)$/.test(value);
}

function parseSimplePercentage(value: string): number | undefined {
  const match = /^(-?[0-9.]+)%$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount / 100 : undefined;
}

function parseSimpleLength(value: string, fontSize: number): number | undefined {
  const match = /^(-?[0-9.]+)(px|pt|em|rem|vw|vh)?$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2] ?? "px";
  if (unit === "pt") return amount;
  if (unit === "em") return amount * fontSize;
  if (unit === "rem") return amount * ROOT_FONT_SIZE;
  if (unit === "vw") return (amount / 100) * VIEWPORT_WIDTH;
  if (unit === "vh") return (amount / 100) * VIEWPORT_HEIGHT;
  return amount * 0.75;
}
