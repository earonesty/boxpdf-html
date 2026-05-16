export function parseLength(value: string | undefined, fontSize: number): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized.endsWith("%")) return undefined;
  const match = /^(-?[0-9.]+)(px|pt|em|rem)?$/.exec(normalized);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2] ?? "px";
  if (unit === "pt") return amount;
  if (unit === "em" || unit === "rem") return amount * fontSize;
  return amount * 0.75;
}

export function parseLineHeight(value: string | undefined, fontSize: number): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "normal") return undefined;
  const unitless = /^([0-9.]+)$/.exec(normalized);
  if (unitless) return Number(unitless[1]) * fontSize;
  return parseLength(normalized, fontSize);
}
