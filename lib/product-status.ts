import { productHasUnknownTierCapacity, type HoldingSyncState, type Product } from "./domain";
import { apiFieldCapability } from "./api-capabilities";
import {
  productNeedsManualLimit,
  productNeedsManualTerm,
  productNeedsPurchaseDate,
  productTermDays,
  productTermStatus,
  type ProductOverride,
} from "./product-overrides";

export type ProductInformationIssue =
  | "APR 未获取"
  | "APR 待填写"
  | "阶梯 APR 未获取"
  | "阶梯结构未获取"
  | "首档额度待填写"
  | "首档额度未获取"
  | "阶梯额度未获取"
  | "活动期限待填写"
  | "活动期限未获取"
  | "锁定期限待填写"
  | "锁定期限未获取"
  | "买入日未获取"
  | "买入日待填写";

export function productInformationNote(issues: ProductInformationIssue[]) {
  return `${issues.join("、")}，不参与收益计算`;
}

const firstTierCapacityIssues = new Set<ProductInformationIssue>([
  "阶梯 APR 未获取",
  "首档额度待填写",
  "首档额度未获取",
]);

export function productCapacityIsIncomplete(product: Product, issues: ProductInformationIssue[]) {
  const firstTier = product.tiers[0];
  if (!firstTier || !Number.isFinite(firstTier.min) || firstTier.min < 0) return true;
  if (firstTier.max === null
    ? firstTier.maxStatus !== "unlimited"
    : !Number.isFinite(firstTier.max) || firstTier.max < firstTier.min) return true;
  return issues.some((issue) => firstTierCapacityIssues.has(issue));
}

export function productInformationIssues(
  product: Product,
  override?: ProductOverride,
  hasExternalPurchaseTiming = false,
  hasHolding = true,
): ProductInformationIssue[] {
  const issues: ProductInformationIssue[] = [];
  const apiManaged = product.productDataMode === "api";

  if (product.rateCoverage === "unavailable") issues.push(apiManaged ? "APR 未获取" : "APR 待填写");
  if (product.rateCoverage === "max_only") issues.push("阶梯 APR 未获取");
  if (product.rateCoverage === "partial") issues.push("阶梯结构未获取");
  if (apiManaged && product.rateCoverage === "base_only") issues.push("首档额度未获取");
  if (apiManaged && product.rateCoverage === "complete" && productHasUnknownTierCapacity(product)) {
    issues.push(product.tiers[0]?.max == null && product.tiers[0].maxStatus !== "unlimited" ? "首档额度未获取" : "阶梯额度未获取");
  }
  if (productNeedsManualLimit(product) && (override?.firstTierLimit === null || override?.firstTierLimit === undefined)) issues.push("首档额度待填写");

  const durationRequired = product.productType === "fixed" || product.manualKind === "limited" || productNeedsManualTerm(product);
  const durationDays = productTermDays(product);
  if (durationRequired && durationDays === null) {
    const activity = product.manualKind === "limited" || productNeedsManualTerm(product);
    issues.push(activity
      ? apiManaged ? "活动期限未获取" : "活动期限待填写"
      : apiManaged ? "锁定期限未获取" : "锁定期限待填写");
  } else if (hasHolding && productNeedsPurchaseDate(product) && !hasExternalPurchaseTiming && !productTermStatus(product, override?.purchaseDate)) {
    issues.push(apiManaged && apiFieldCapability(product, "purchaseAt") === "supported" ? "买入日未获取" : "买入日待填写");
  }

  return issues;
}

export function productParticipatesInInterest(
  product: Product,
  holding: number,
  override?: ProductOverride,
  hasExternalPurchaseTiming = false,
) {
  return holding > 0 && productInformationIssues(product, override, hasExternalPurchaseTiming).length === 0;
}

/**
 * One shared explanation for an unavailable API holding. The same note is
 * used in view and edit mode; edit mode only omits the redundant amount label
 * because its input already says “未获取”.
 */
export function holdingSyncNote(state?: HoldingSyncState) {
  switch (state) {
    case "not_configured":
      return "未配置 API；配置后可同步持仓";
    case "partial":
      return "持仓接口未完整返回";
    case "error":
      return "API 同步失败";
    case "synced":
      return "接口未返回该产品持仓";
    default:
      return undefined;
  }
}

export function resolveProductWithoutApiData(product: Product): Product {
  if (product.productDataMode === "manual" || product.source.kind === "live") return product;
  return { ...product, rateCoverage: "unavailable" };
}
