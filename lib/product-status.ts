import type { HoldingSyncState, Product } from "./domain";
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

export function productInformationNote(issues: ProductInformationIssue[]) {
  return `${issues.join("、")}，不参与收益计算`;
}

export function productInformationIssues(
  product: Product,
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
  } else if (productNeedsPurchaseDate(product) && !productTermStatus(product, override?.purchaseDate)) {
    issues.push("买入日待填写");
  }

  return issues;
}

export function productParticipatesInInterest(
  product: Product,
  holding: number,
  override?: ProductOverride,
) {
  return holding > 0 && productInformationIssues(product, override).length === 0;
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
