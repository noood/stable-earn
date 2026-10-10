import type { Product } from "./domain";
import { parseExchangeNumber } from "./exchange-number";
import { productNeedsManualApr, productNeedsManualLimit, productNeedsManualTerm, type ProductOverride } from "./product-overrides";

type RawProductOverride = {
  apr?: unknown;
  firstTierLimit?: unknown;
  termDays?: unknown;
  purchaseDate?: unknown;
};

export function parseProductOverride(product: Product, input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const raw = input as RawProductOverride;
  const apr = productNeedsManualApr(product) ? optionalApr(raw.apr) : null;
  const firstTierLimit = productNeedsManualLimit(product) ? optionalLimit(raw.firstTierLimit) : null;
  // A product may declare that its term is manual while the saved catalogue
  // row has no term yet. In that case the submitted term determines whether a
  // purchase date is applicable and must be persisted with it.
  const termDays = productNeedsManualTerm(product) ? optionalTerm(raw.termDays) : product.termDays ?? null;
  const purchaseDate = termDays !== null && termDays !== undefined ? optionalDate(raw.purchaseDate) : null;
  if (apr === undefined || firstTierLimit === undefined || termDays === undefined || purchaseDate === undefined) return null;
  return { productId: product.id, apr, firstTierLimit, termDays, purchaseDate } satisfies Pick<ProductOverride, "apr" | "firstTierLimit" | "termDays" | "purchaseDate"> & { productId: string };
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
