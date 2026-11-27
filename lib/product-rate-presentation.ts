import { formatAmount, type Product } from "./domain";
import { productTypeIsResolved } from "./product-overrides";
import { minimumOpportunityApr } from "./opportunity-policy";

/** Color the displayed, rounded APR; missing values have their own state. */
export function rateAprTone(apr: number | undefined) {
  if (apr === undefined || !Number.isFinite(apr)) return "missing";
  const displayedApr = Number(apr.toFixed(2));
  if (displayedApr < minimumOpportunityApr) return "low";
  if (displayedApr < 9) return "base";
  if (displayedApr < 12) return "medium";
  return "high";
}

/** A null bound is open-ended only when its explicit status confirms it. */
export function productTierLabel(tier: Product["tiers"][number]) {
  if (tier.max === null) return tier.maxStatus === "unlimited" ? `${formatAmount(tier.min)} 以上` : "上限未获取";
  return Number.isFinite(tier.min) && Number.isFinite(tier.max)
    ? `${formatAmount(tier.min)}–${formatAmount(tier.max)}`
    : "上限未获取";
}

export function rateHeadlineFor(product: Product, apiManaged = product.productDataMode === "api") {
  const firstTier = product.tiers[0];
  const capacityName = productTypeIsResolved(product) && product.productType === "fixed" ? "申购额度" : "首档";
  const hasCapacity = firstTier && Number.isFinite(firstTier.min)
    && !(product.productDataMode === "manual" && product.rateCoverage === "base_only")
    && (firstTier.max !== null
      ? Number.isFinite(firstTier.max) && firstTier.max >= firstTier.min
      : firstTier.maxStatus === "unlimited" && product.tierStructureStatus !== "incomplete"
        && (apiManaged || product.source.kind === "demo" || product.capacityStatus === "available"));
  const capacityLabel = hasCapacity
    ? `${capacityName} ${product.tiers.length === 1 && firstTier.min === 0 && firstTier.max === null ? "不限额" : productTierLabel(firstTier)}`
    : apiManaged ? `${capacityName} 上限未获取` : `${capacityName}额度待填写`;

  const maximumOnly = product.rateCoverage === "max_only";
  const label = maximumOnly ? "官网最高" : capacityLabel;
  const apr = firstTier?.apr;
  if (product.rateCoverage === "unavailable" || product.aprStatus === "unavailable" || !Number.isFinite(apr)) {
    return { label, value: apiManaged ? "APR 未获取" : "APR 待填写" };
  }
  const value = `${apr.toFixed(2)}%`;
  return maximumOnly ? { label, apr, value, valuePrefix: "最高" } : { label, apr, value };
}
