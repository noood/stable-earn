type ExchangeNumberOptions = {
  /** Accept one trailing percent sign, without converting the value's unit. */
  allowPercentSuffix?: boolean;
  /** Accept conventional thousands grouping such as 1,234.56. */
  allowThousandsSeparators?: boolean;
};

const plainNumberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const groupedNumberPattern = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Parse an exchange number only when the entire value has an expected shape. */
export function parseExchangeNumber(value: unknown, options: ExchangeNumberOptions = {}) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;

  let normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.endsWith("%")) {
    if (!options.allowPercentSuffix) return undefined;
    normalized = normalized.slice(0, -1).trim();
  }

  if (normalized.includes(",")) {
    if (!options.allowThousandsSeparators || !groupedNumberPattern.test(normalized)) return undefined;
    normalized = normalized.replaceAll(",", "");
  } else if (!plainNumberPattern.test(normalized)) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}
