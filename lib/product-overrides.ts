import type { Product } from "./domain";

export type ProductOverride = {
  apr: number | null;
  firstTierLimit: number | null;
  termDays: number | null;
  purchaseDate: string | null;
  updatedAt: string | null;
};

export type ProductOverrideMap = Record<string, ProductOverride>;

const dayMs = 24 * 60 * 60 * 1000;
const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function applyProductOverride(product: Product, override?: ProductOverride) {
  const hasApr = override?.apr !== null && override?.apr !== undefined && Number.isFinite(override.apr);
  const hasLimit = override?.firstTierLimit !== null && override?.firstTierLimit !== undefined && Number.isFinite(override.firstTierLimit) && override.firstTierLimit > 0;
  const hasTerm = override?.termDays !== null && override?.termDays !== undefined && Number.isFinite(override.termDays) && override.termDays > 0;
  const needsManualApr = productNeedsManualApr(product);
  const needsManualLimit = productNeedsManualLimit(product);
  const needsManualTerm = productNeedsManualTerm(product);
  const useManualApr = hasApr && needsManualApr;
  const useManualLimit = hasLimit && needsManualLimit;
  const useManualTerm = hasTerm && needsManualTerm;
  if (!useManualApr && !useManualLimit && !useManualTerm && !needsManualApr && !needsManualLimit && !needsManualTerm) return product;

  return {
    ...product,
    termDays: useManualTerm ? override!.termDays! : needsManualTerm ? undefined : product.termDays,
    rateCoverage: needsManualApr
      ? !useManualApr ? "unavailable" as const : !useManualLimit ? "base_only" as const : "complete" as const
      : product.rateCoverage,
    tiers: product.tiers.map((tier, index) => index === 0 ? {
      ...tier,
      apr: useManualApr ? override!.apr! : tier.apr,
      max: useManualLimit ? tier.min + override!.firstTierLimit! : tier.max,
    } : tier),
  };
}

export function productNeedsManualApr(product: Product) {
  return product.productDataMode === "manual" && product.source.kind !== "demo";
}

export function productNeedsManualLimit(product: Product) {
  return product.productDataMode === "manual" && product.source.kind !== "demo";
}

export function productNeedsManualTerm(product: Product) {
  return Boolean(product.manualFields?.termDays);
}

export function productTermDays(product: Product) {
  return product.productType === "fixed" || product.manualKind === "limited" || productNeedsManualTerm(product)
    ? product.termDays ?? null
    : null;
}

export function productNeedsPurchaseDate(product: Product) {
  return productTermDays(product) !== null;
}

export function productTermStatus(product: Product, purchaseDate: string | null | undefined, today = new Date()) {
  const durationDays = productTermDays(product);
  const start = parseDateOnly(purchaseDate);
  if (durationDays === null || !start) return null;

  const todayDay = calendarDayTimestamp(today);
  const elapsedDays = Math.max(0, Math.floor((todayDay - start) / dayMs));
  const remainingDays = durationDays - elapsedDays;
  const maturity = new Date(start + durationDays * dayMs);
  return {
    durationDays,
    elapsedDays,
    remainingDays,
    maturityDate: formatDateOnly(maturity),
    urgent: remainingDays <= 7,
  };
}

export function formatShortDate(value: string | null | undefined) {
  const timestamp = parseDateOnly(value) ?? (value ? Date.parse(value) : Number.NaN);
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
}

function parseDateOnly(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? timestamp
    : null;
}

function calendarDayTimestamp(value: Date) {
  const parts = Object.fromEntries(shanghaiDateFormatter.formatToParts(value).map(({ type, value: part }) => [type, part]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}

function formatDateOnly(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
