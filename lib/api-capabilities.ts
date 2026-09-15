import type { Product } from "./domain";

export type ApiField = "purchaseAt" | "redeemAt" | "quota" | "termDays" | "eligibility";
export type ApiFieldCapability = "supported" | "unsupported";

/**
 * Capabilities are declared per integration/product family, not inferred from
 * one response. A supported field that is missing is temporary and remains
 * read-only; an unsupported field uses the existing manual fallback.
 */
const capabilities: Record<string, Partial<Record<ApiField, ApiFieldCapability>>> = {
  "binance:fixed": {
    purchaseAt: "supported",
    redeemAt: "supported",
    quota: "supported",
    termDays: "supported",
    eligibility: "supported",
  },
  "binance:flexible": {
    quota: "supported",
    termDays: "unsupported",
    purchaseAt: "unsupported",
    redeemAt: "unsupported",
    eligibility: "supported",
  },
  "bybit:fixed": {
    // The current Bybit position endpoint returns amount/status only.
    purchaseAt: "unsupported",
    redeemAt: "unsupported",
    quota: "supported",
    termDays: "supported",
    eligibility: "supported",
  },
  "bybit:flexible": {
    purchaseAt: "unsupported",
    redeemAt: "unsupported",
    quota: "unsupported",
    termDays: "unsupported",
    eligibility: "unsupported",
  },
  "bitget:flexible": {
    purchaseAt: "unsupported",
    redeemAt: "unsupported",
    quota: "supported",
    termDays: "unsupported",
    eligibility: "unsupported",
  },
  "okx:flexible": {
    purchaseAt: "unsupported",
    redeemAt: "unsupported",
    quota: "unsupported",
    termDays: "unsupported",
    eligibility: "unsupported",
  },
  "okx:fixed": {
    purchaseAt: "unsupported",
    redeemAt: "unsupported",
    quota: "unsupported",
    termDays: "unsupported",
    eligibility: "unsupported",
  },
};

export function apiFieldCapability(product: Product, field: ApiField): ApiFieldCapability {
  if (product.productDataMode !== "api") return "unsupported";
  return capabilities[`${product.exchange}:${product.productType}`]?.[field] ?? "unsupported";
}
