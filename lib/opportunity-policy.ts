import { productHasUnknownTierCapacity, remainingHighYield, type Product } from "./domain";
import { productTermDays } from "./product-overrides";

export const minimumOpportunityApr = 6;
export const maximumShortTermDays = 7;
export const minimumStablecoinCatalogHolding = 0.01;

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

/** Unknown status remains eligible; only confirmed restrictions close the offer. */
export function productKnownNotSubscribable(product: Product, now = Date.now()) {
  if (product.availability === "unavailable" || product.eligibilityStatus === "ineligible") return true;
  const startsAt = product.subscriptionStartsAt ? Date.parse(product.subscriptionStartsAt) : Number.NaN;
  const endsAt = product.subscriptionEndsAt ? Date.parse(product.subscriptionEndsAt) : Number.NaN;
  return (Number.isFinite(startsAt) && startsAt > now)
    || (Number.isFinite(endsAt) && endsAt <= now);
}

/** Find the highest first-tier APR whose quota is not known to be exhausted. */
export function bestAvailableFirstTierProduct(
  products: readonly Product[],
  holdings: Readonly<Record<string, number>>,
  isHoldingKnown: (product: Product) => boolean,
  now = Date.now(),
) {
  let best: Product | null = null;
  for (const product of products) {
    if (product.rateCoverage !== "complete" || productHasUnknownTierCapacity(product) || productKnownNotSubscribable(product, now)) continue;
    const firstTier = product.tiers[0];
    if (!firstTier || !Number.isFinite(firstTier.apr)) continue;

    if (firstTier.max === null && firstTier.maxStatus !== "unlimited") continue;
    if (firstTier.max !== null) {
      if (!isHoldingKnown(product)) continue;
      const capacity = Math.max(0, firstTier.max - firstTier.min);
      if (capacity <= 0) continue;
      const used = Math.max(0, Math.min(capacity, (holdings[product.id] ?? 0) - firstTier.min));
      if (used >= capacity) continue;
    }

    if (!best || firstTier.apr > best.tiers[0]!.apr) best = product;
  }
  return best;
}

export function totalHighYieldRemaining(
  products: readonly Product[],
  holdings: Readonly<Record<string, number>>,
  isHoldingKnown: (product: Product) => boolean,
  now = Date.now(),
) {
  return products.reduce((sum, product) => {
    if (product.rateCoverage !== "complete" || productHasUnknownTierCapacity(product) || productKnownNotSubscribable(product, now)) return sum;
    const hasKnownUnlimitedHighYield = product.tiers.some((tier) => meetsOpportunityApr(tier.apr)
      && tier.max === null && tier.maxStatus === "unlimited");
    if (!isHoldingKnown(product) && !hasKnownUnlimitedHighYield) return sum;
    return sum + remainingHighYield(product, holdings[product.id] ?? 0, minimumOpportunityApr);
  }, 0);
}

export function productQualifiesAsOpportunity(product: Product) {
  if (!productHasComparableApr(product) || !meetsOpportunityApr(highestProductApr(product))) return false;
  const termDays = productTermDays(product);
  return product.productType !== "fixed"
    || (termDays !== null && termDays <= maximumShortTermDays);
}

export function productHoldingQualifiesForCatalog(product: Product, amount: number) {
  const minimum = product.asset === "BTC" ? 0 : minimumStablecoinCatalogHolding;
  return Number.isFinite(amount) && amount > minimum;
}

export function productShouldBeActive(
  product: Product,
  holding: { known: boolean; amount: number },
  alreadyActive = false,
) {
  if (product.productDataMode === "manual") return true;
  // A partial/failed holding response is not evidence that an existing
  // product is below its holding threshold. Keep the row until sufficient
  // evidence is available; otherwise an APR change during a partial sync could archive
  // a product whose holding is merely unknown.
  if (!holding.known && alreadyActive) return true;
  if (holding.known && productHoldingQualifiesForCatalog(product, holding.amount)) return true;
  if (product.availability === "unavailable" || product.eligibilityStatus === "ineligible") {
    return false;
  }
  // Preserve an active row while its APR/term data is too incomplete to decide
  // whether it meets the opportunity threshold. This must happen before the
  // eligibility gate, which otherwise hides the missing-data state.
  if (alreadyActive && productRateDecisionIsIncomplete(product)) return true;
  // A required account qualification is not proof that the account can
  // subscribe. Keep unknown/ineligible products out of the ordinary
  // opportunity list; a positive holding or an existing row with unknown
  // holdings was handled above and remains visible.
  if (product.eligibilityRequired && product.eligibilityStatus !== "eligible") return false;
  if (productQualifiesAsOpportunity(product)) return true;
  return false;
}

function productRateDecisionIsIncomplete(product: Product) {
  if (!productHasComparableApr(product) || product.rateCoverage !== "complete") return true;
  if (product.productType === "fixed" && highestProductApr(product) >= minimumOpportunityApr
    && productTermDays(product) === null) return true;
  return false;
}
