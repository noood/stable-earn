import type { Product } from "./domain";
import { productTypeIsResolved } from "./product-overrides";

function productGroup(product: Product) {
  if (!productTypeIsResolved(product)) return 2;
  return (product.manualKind ?? product.productType) === "fixed" ? 1 : 0;
}

function firstTierApr(product: Product) {
  if (product.aprStatus === "unavailable" || product.rateCoverage === "unavailable" || product.rateCoverage === "max_only") return null;
  const apr = product.tiers[0]?.apr;
  return apr !== undefined && Number.isFinite(apr) ? Number(apr.toFixed(2)) : null;
}

/** Preserve platform order; make the order within a platform understandable. */
export function compareTableProducts(left: Product, right: Product) {
  const platform = left.exchange.localeCompare(right.exchange, "en", { sensitivity: "base" })
    || left.region.localeCompare(right.region, "en", { sensitivity: "base" });
  if (platform) return platform;
  const group = productGroup(left) - productGroup(right);
  if (group) return group;
  const leftApr = firstTierApr(left);
  const rightApr = firstTierApr(right);
  if (leftApr === null && rightApr !== null) return 1;
  if (leftApr !== null && rightApr === null) return -1;
  if (leftApr !== null && rightApr !== null && leftApr !== rightApr) return rightApr - leftApr;
  return left.id.localeCompare(right.id, "en");
}
