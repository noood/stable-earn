import type { Product } from "./domain";
import {
  productNeedsManualLimit,
  productNeedsManualTerm,
  productNeedsPurchaseDate,
  productTermDays,
  productTermStatus,
  type ProductOverride,
} from "./product-overrides";

export type ProductInformationIssue =
  | "产品数据待获取"
  | "APR 待填写"
  | "阶梯结构待确认"
  | "首档额度待填写"
  | "首档额度待确认"
  | "活动期限待填写"
  | "活动期限待获取"
  | "锁定期限待填写"
  | "锁定期限待获取"
  | "买入日待填写";

export function productInformationIssues(
  product: Product,
  holding: number,
  override?: ProductOverride,
): ProductInformationIssue[] {
  const issues: ProductInformationIssue[] = [];
  const apiManaged = product.productDataMode === "api";

  if (product.rateCoverage === "unavailable" && apiManaged) return ["产品数据待获取"];
  if (product.rateCoverage === "unavailable") issues.push("APR 待填写");
  if (product.rateCoverage === "max_only") issues.push("阶梯结构待确认");
  if (apiManaged && product.rateCoverage === "base_only") issues.push("首档额度待确认");
  if (productNeedsManualLimit(product) && (override?.firstTierLimit === null || override?.firstTierLimit === undefined)) issues.push("首档额度待填写");

  const durationRequired = product.productType === "fixed" || product.manualKind === "limited" || productNeedsManualTerm(product);
  const durationDays = productTermDays(product);
  if (durationRequired && durationDays === null) {
    const activity = product.manualKind === "limited" || productNeedsManualTerm(product);
    issues.push(activity
      ? apiManaged ? "活动期限待获取" : "活动期限待填写"
      : apiManaged ? "锁定期限待获取" : "锁定期限待填写");
  } else if (holding > 0 && productNeedsPurchaseDate(product) && !productTermStatus(product, override?.purchaseDate)) {
    issues.push("买入日待填写");
  }

  return issues;
}

export function productParticipatesInInterest(
  product: Product,
  holding: number,
  override?: ProductOverride,
) {
  return productInformationIssues(product, holding, override).length === 0;
}

/**
 * Whether a product can be removed from the current account's dashboard.
 *
 * Public, flexible API products are part of the shared catalogue and stay
 * visible. Products that depend on account-specific eligibility or a finite
 * campaign/lock period can be dismissed because they are not universally
 * available forever.
 */
export function productCanBeRemoved(product: Product) {
  return product.productDataMode === "manual"
    || product.eligibilityRequired === true
    || product.productType === "fixed"
    || product.manualKind === "limited"
    || Boolean(product.manualFields?.termDays);
}

export function resolveProductWithoutApiData(product: Product): Product {
  if (product.productDataMode === "manual" || product.source.kind === "live") return product;
  return { ...product, rateCoverage: "unavailable" };
}
