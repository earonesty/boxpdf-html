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
  return parseCalcLengthPercentage(normalized, fontSize);
}

export function parseLineHeight(value: string | undefined, fontSize: number): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "normal") return undefined;
  const unitless = /^([0-9.]+)$/.exec(normalized);
  if (unitless) return Number(unitless[1]) * fontSize;
  if (isCalc(normalized)) {
    const number = parseCalcNumber(normalized);
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
  return parseCalcNumber(normalized);
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

function parseCalcLengthPercentage(value: string, fontSize: number): LengthPercentage | undefined {
  const stripped = stripCalc(value.trim());
  const simplePercent = parseSimplePercentage(stripped);
  if (simplePercent !== undefined) return { length: 0, percent: simplePercent };
  const simpleLength = parseSimpleLength(stripped, fontSize);
  if (simpleLength !== undefined) return { length: simpleLength, percent: 0 };

  const sum = topLevelOperator(stripped, ["+", "-"]);
  if (sum) {
    const left = parseCalcLengthPercentage(stripped.slice(0, sum.index), fontSize);
    const right = parseCalcLengthPercentage(stripped.slice(sum.index + 1), fontSize);
    if (!left || !right) return undefined;
    const sign = sum.operator === "-" ? -1 : 1;
    return { length: left.length + sign * right.length, percent: left.percent + sign * right.percent };
  }

  const product = topLevelOperator(stripped, ["*", "/"]);
  if (product) {
    const leftRaw = stripped.slice(0, product.index);
    const rightRaw = stripped.slice(product.index + 1);
    const leftLength = parseCalcLengthPercentage(leftRaw, fontSize);
    const rightLength = parseCalcLengthPercentage(rightRaw, fontSize);
    const leftNumber = parseCalcNumber(leftRaw);
    const rightNumber = parseCalcNumber(rightRaw);
    if (product.operator === "*" && leftLength && rightNumber !== undefined) {
      return { length: leftLength.length * rightNumber, percent: leftLength.percent * rightNumber };
    }
    if (product.operator === "*" && rightLength && leftNumber !== undefined) {
      return { length: rightLength.length * leftNumber, percent: rightLength.percent * leftNumber };
    }
    if (product.operator === "/" && leftLength && rightNumber !== undefined && rightNumber !== 0) {
      return { length: leftLength.length / rightNumber, percent: leftLength.percent / rightNumber };
    }
  }
  return undefined;
}

function parseCalcNumber(value: string): number | undefined {
  const stripped = stripCalc(value.trim());
  const sum = topLevelOperator(stripped, ["+", "-"]);
  if (sum) {
    const left = parseCalcNumber(stripped.slice(0, sum.index));
    const right = parseCalcNumber(stripped.slice(sum.index + 1));
    if (left === undefined || right === undefined) return undefined;
    return sum.operator === "-" ? left - right : left + right;
  }
  const product = topLevelOperator(stripped, ["*", "/"]);
  if (product) {
    const left = parseCalcNumber(stripped.slice(0, product.index));
    const right = parseCalcNumber(stripped.slice(product.index + 1));
    if (left === undefined || right === undefined) return undefined;
    return product.operator === "/" ? (right === 0 ? undefined : left / right) : left * right;
  }
  const number = Number(stripped);
  return Number.isFinite(number) ? number : undefined;
}

function stripCalc(value: string): string {
  let out = value.trim();
  while (isCalc(out)) out = out.slice(5, -1).trim();
  return out;
}

function topLevelOperator(value: string, operators: string[]): { operator: string; index: number } | undefined {
  let depth = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const char = value[index]!;
    if (char === ")") depth += 1;
    else if (char === "(") depth = Math.max(0, depth - 1);
    else if (depth === 0 && operators.includes(char)) {
      const prev = value[index - 1];
      if ((char === "+" || char === "-") && (index === 0 || prev === undefined || /[+\-*/(]/.test(prev))) continue;
      return { operator: char, index };
    }
  }
  return undefined;
}
