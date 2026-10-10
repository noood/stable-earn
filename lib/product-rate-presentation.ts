import { formatAmount, type Product } from "./domain";

/** A null bound is open-ended only when its explicit status confirms it. */
export function productTierLabel(tier: Product["tiers"][number]) {
  if (tier.max === null) return tier.maxStatus === "unlimited" ? `${formatAmount(tier.min)} 以上` : "上限未获取";
  return Number.isFinite(tier.min) && Number.isFinite(tier.max)
    ? `${formatAmount(tier.min)}–${formatAmount(tier.max)}`
    : "上限未获取";
}

export function rateHeadlineFor(product: Product, apiManaged = product.productDataMode === "api") {
  const firstTier = product.tiers[0];
  const capacityName = product.productType === "fixed" ? "申购额度" : "首档";
  const hasCapacity = firstTier && Number.isFinite(firstTier.min)
    && !(product.productDataMode === "manual" && product.rateCoverage === "base_only")
    && (firstTier.max !== null
      ? Number.isFinite(firstTier.max) && firstTier.max >= firstTier.min
      : firstTier.maxStatus === "unlimited" && product.tierStructureStatus !== "incomplete"
        && (apiManaged || product.source.kind === "demo"));
  const capacityLabel = hasCapacity
    ? `${capacityName} · ${productTierLabel(firstTier)}`
    : apiManaged ? `${capacityName} · 上限未获取` : `${capacityName}额度待填写`;

  if (product.rateCoverage === "unavailable") {
    return { label: capacityLabel, value: apiManaged ? "APR 未获取" : "APR 待填写", muted: true };
  }
  if (product.rateCoverage === "max_only") {
    return { label: "官网最高", value: `最高 ${firstTier?.apr.toFixed(2) ?? "0.00"}%` };
  }
  return {
    label: capacityLabel,
    value: firstTier && Number.isFinite(firstTier.apr) ? `${firstTier.apr.toFixed(2)}%` : apiManaged ? "APR 未获取" : "APR 待填写",
    ...(product.rateCoverage === "partial" ? { muted: true } : {}),
  };
}
