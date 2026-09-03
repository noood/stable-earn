import type { Product } from "./domain";
import { productTermDays } from "./product-overrides";

export const minimumOpportunityApr = 6;
export const maximumShortTermDays = 7;

export function meetsOpportunityApr(apr: number) {
  return Number.isFinite(apr) && apr >= minimumOpportunityApr;
}

export function highestProductApr(product: Product) {
  return Math.max(0, ...product.tiers.map((tier) => tier.apr));
}

export function productHasComparableApr(product: Product) {
  return product.rateCoverage !== "unavailable"
    && Number.isFinite(product.tiers[0]?.apr);
}

export function productHasKnownCapacity(product: Product) {
  const tier = product.tiers[0];
  return product.rateCoverage === "complete"
    && Boolean(tier)
    && tier.max !== null
    && Number.isFinite(tier.max)
    && tier.max > tier.min;
}

export function productQualifiesAsOpportunity(product: Product) {
  if (!productHasComparableApr(product) || !meetsOpportunityApr(highestProductApr(product))) return false;
  const termDays = productTermDays(product);
  return product.productType !== "fixed"
    || (termDays !== null && termDays <= maximumShortTermDays);
}

export function productShouldBeActive(
  product: Product,
  holding: { known: boolean; amount: number },
  alreadyActive = false,
) {
  if (product.productDataMode === "manual") return true;
  if (holding.known && holding.amount > 0) return true;
  if (product.availability === "unavailable" || product.eligibilityStatus === "ineligible") {
    return alreadyActive && !holding.known;
  }
  if (productQualifiesAsOpportunity(product)) return true;
  return false;
}
