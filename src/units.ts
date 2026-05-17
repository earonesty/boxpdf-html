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
  const product = parseCalcProduct(body, fontSize);
  if (product) return product;
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
  if (isCalc(normalized)) {
    const number = parseCalcNumber(normalized.slice(5, -1).trim());
    if (number !== undefined) return number * fontSize;
  }
  return parseLength(normalized, fontSize);
}

export function parseLineHeightScale(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  const unitless = /^([0-9.]+)$/.exec(normalized);
  if (unitless) return Number(unitless[1]);
  if (!isCalc(normalized)) return undefined;
  return parseCalcNumber(normalized.slice(5, -1).trim());
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

function parseCalcProduct(value: string, fontSize: number): LengthPercentage | undefined {
  const multiplied = /^(.+?)\s*\*\s*(-?[0-9.]+)$/.exec(value) ?? /^(-?[0-9.]+)\s*\*\s*(.+)$/.exec(value);
  if (multiplied) {
    const firstNumber = Number(multiplied[1]);
    const factor = Number.isFinite(firstNumber) ? firstNumber : Number(multiplied[2]);
    const valueToken = Number.isFinite(firstNumber) ? multiplied[2]!.trim() : multiplied[1]!.trim();
    const parsed = parseLengthPercentage(valueToken, fontSize);
    return parsed && Number.isFinite(factor) ? { length: parsed.length * factor, percent: parsed.percent * factor } : undefined;
  }
  const divided = /^(.+?)\s*\/\s*(-?[0-9.]+)$/.exec(value);
  if (divided) {
    const divisor = Number(divided[2]);
    if (!Number.isFinite(divisor) || divisor === 0) return undefined;
    const parsed = parseLengthPercentage(divided[1]!.trim(), fontSize);
    return parsed ? { length: parsed.length / divisor, percent: parsed.percent / divisor } : undefined;
  }
  return undefined;
}

function parseCalcNumber(value: string): number | undefined {
  const divided = /^(-?[0-9.]+)\s*\/\s*(-?[0-9.]+)$/.exec(value);
  if (divided) {
    const left = Number(divided[1]);
    const right = Number(divided[2]);
    return Number.isFinite(left) && Number.isFinite(right) && right !== 0 ? left / right : undefined;
  }
  const multiplied = /^(-?[0-9.]+)\s*\*\s*(-?[0-9.]+)$/.exec(value);
  if (multiplied) {
    const left = Number(multiplied[1]);
    const right = Number(multiplied[2]);
    return Number.isFinite(left) && Number.isFinite(right) ? left * right : undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
