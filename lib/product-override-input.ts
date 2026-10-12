import type { Product, ProductKind } from "./domain";
import { parseExchangeNumber } from "./exchange-number";
import { applyProductOverride, productNeedsManualApr, productNeedsManualLimit, productNeedsManualTerm, productNeedsManualType, productNeedsManualPurchaseDate, type ProductOverride } from "./product-overrides";
import { productTypeCanHaveTerm, resolveProductKind } from "./product-kind";

type RawProductOverride = {
  apr?: unknown;
  firstTierLimit?: unknown;
  termDays?: unknown;
  purchaseDate?: unknown;
  manualKind?: unknown;
};

export function parseProductOverride(product: Product, input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const raw = input as RawProductOverride;
  const apr = productNeedsManualApr(product) ? optionalApr(raw.apr) : null;
  const firstTierLimit = productNeedsManualLimit(product) ? optionalLimit(raw.firstTierLimit) : null;
  const manualKind = productNeedsManualType(product) ? optionalManualKind(raw.manualKind) : null;
  if (manualKind === undefined) return null;
  const selected = applyProductOverride(product, { apr: null, firstTierLimit: null, termDays: null, purchaseDate: null, updatedAt: null, manualKind });
  const termDays = !productTypeCanHaveTerm(selected) ? null
    : productNeedsManualTerm(selected) ? optionalTerm(raw.termDays) : product.termDays ?? null;
  const purchaseDate = productNeedsManualPurchaseDate({ ...selected, termDays: termDays ?? undefined })
    ? optionalDate(raw.purchaseDate)
    : null;
  if (apr === undefined || firstTierLimit === undefined || manualKind === undefined || termDays === undefined || purchaseDate === undefined) return null;
  return { productId: product.id, apr, firstTierLimit, termDays, purchaseDate, manualKind } satisfies Pick<ProductOverride, "apr" | "firstTierLimit" | "termDays" | "purchaseDate" | "manualKind"> & { productId: string };
}

function optionalManualKind(value: unknown): ProductKind | null | undefined {
  if (value === null || value === undefined || value === "unknown") return null;
  const parsed = resolveProductKind(value);
  return parsed.status === "known" ? parsed.kind : undefined;
}

function optionalApr(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const apr = parseExchangeNumber(value);
  return apr !== undefined && apr >= 0 && apr <= 10000 ? apr : undefined;
}

function optionalLimit(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const limit = parseExchangeNumber(value);
  return limit !== undefined && limit > 0 && limit <= 1e15 ? limit : undefined;
}

function optionalTerm(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const termDays = parseExchangeNumber(value);
  return termDays !== undefined && termDays > 0 && termDays <= 3650 ? termDays : undefined;
}

function optionalDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? value : undefined;
}
