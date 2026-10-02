import type { D1Database } from "@cloudflare/workers-types";
import type { HoldingMap, HoldingPosition, Product, ProductChangeEvent } from "./domain";
import { formatAmount } from "./domain";
import type { LiveRate } from "./live-rates";
import { formatShortDate, type ProductOverrideMap } from "./product-overrides";

export type ProductChangeSource = ProductChangeEvent["source"];

export type ProductSnapshotForChanges = {
  fetchedAt?: string;
  products?: Product[];
  rates?: LiveRate[];
  rateFallbacks?: Record<string, string>;
  holdingUpdates?: HoldingMap;
  holdingFallbacks?: Record<string, string>;
  holdingPositions?: HoldingPosition[];
};

type ProductChangeEventInput = Omit<ProductChangeEvent, "id">;
type PortfolioChangeIds = {
  holdingProductIds: string[];
  overrideProductIds: string[];
  manualProductIds: string[];
  deletedManualProductIds: string[];
};

export function buildSyncChangeEvents(
  previous: ProductSnapshotForChanges | null | undefined,
  current: ProductSnapshotForChanges,
  source: ProductChangeSource,
  observedAt = new Date().toISOString(),
) {
  if (!previous) return [];
  const events: ProductChangeEvent[] = [];
  let sequence = 0;
  const add = (productId: string, event: Omit<ProductChangeEventInput, "productId" | "observedAt" | "source">) => {
    events.push({
      id: eventId(observedAt, productId, sequence++),
      productId,
      observedAt,
      source,
      ...event,
    });
  };

  const previousRates = new Map((previous.rates ?? []).map((rate) => [rate.productId, rate]));
  const currentRates = (current.rates ?? []).filter((rate) => !current.rateFallbacks?.[rate.productId]);
  for (const rate of currentRates) {
    const before = previousRates.get(rate.productId);
    if (!before) continue;
    const beforeApr = primaryApr(before);
    const afterApr = primaryApr(rate);
    if (beforeApr !== null && afterApr !== null && beforeApr !== afterApr) {
      add(rate.productId, {
        type: "rate",
        title: afterApr < beforeApr ? "首档 APR 下调" : "首档 APR 上调",
        before: formatApr(beforeApr),
        after: formatApr(afterApr),
        attention: afterApr < beforeApr,
      });
    } else if (tierSummary(before) !== tierSummary(rate)) {
      add(rate.productId, {
        type: "rate",
        title: "阶梯 APR 调整",
        before: tierSummary(before),
        after: tierSummary(rate),
      });
    }

    const beforeCapacity = firstTierCapacity(before);
    const afterCapacity = firstTierCapacity(rate);
    // Some APIs omit quota fields entirely. Keep that unknown state separate
    // from an explicit `null` upper bound, which means “unlimited”. Only
    // compare when both snapshots provide a meaningful capacity value.
    if (rate.capacitySource !== "cache"
      && beforeCapacity !== undefined
      && afterCapacity !== undefined
      && beforeCapacity !== afterCapacity) {
      add(rate.productId, {
        type: "capacity",
        title: (
          (beforeCapacity !== null && afterCapacity !== null && afterCapacity < beforeCapacity)
          || (beforeCapacity === null && afterCapacity !== null)
        ) ? "首档额度减少" : "首档额度增加",
        before: formatCapacity(beforeCapacity, rate.catalog?.asset),
        after: formatCapacity(afterCapacity, rate.catalog?.asset),
        attention: (beforeCapacity !== null && afterCapacity !== null && afterCapacity < beforeCapacity)
          || (beforeCapacity === null && afterCapacity !== null),
      });
    }

    if (before.termDays !== rate.termDays) {
      add(rate.productId, {
        type: "maturity",
        title: "锁定期限变化",
        before: formatTerm(before.termDays),
        after: formatTerm(rate.termDays),
      });
    }
    if (before.subscriptionEndsAt !== rate.subscriptionEndsAt && (before.subscriptionEndsAt || rate.subscriptionEndsAt)) {
      add(rate.productId, {
        type: "maturity",
        title: "认购截止变化",
        before: formatShortDate(before.subscriptionEndsAt) || "待确认",
        after: formatShortDate(rate.subscriptionEndsAt) || "待确认",
      });
    }

    const beforeAvailability = availabilitySummary(before);
    const afterAvailability = availabilitySummary(rate);
    if (beforeAvailability !== afterAvailability) {
      add(rate.productId, {
        type: "availability",
        title: "申购状态变化",
        before: beforeAvailability,
        after: afterAvailability,
        attention: afterAvailability.includes("不可") || afterAvailability.includes("不符合"),
      });
    }
  }

  const previousHoldings = previous.holdingUpdates ?? {};
  for (const [productId, rawAmount] of Object.entries(current.holdingUpdates ?? {})) {
    if (current.holdingFallbacks?.[productId] !== undefined) continue;
    const amount = Number(rawAmount);
    const before = Number(previousHoldings[productId]);
    if (!Number.isFinite(amount) || !Number.isFinite(before) || amount === before) continue;
    add(productId, {
      type: "holding",
      title: "持仓变化",
      before: formatAmount(before),
      after: formatAmount(amount),
    });
  }

  const previousPositions = new Map((previous.holdingPositions ?? []).map((position) => [positionKey(position), position]));
  const previousObservedAt = previous.fetchedAt ? Date.parse(previous.fetchedAt) : Number.NaN;
  const observedTimestamp = Date.parse(observedAt);
  for (const position of current.holdingPositions ?? []) {
    if (!position.redeemAt) continue;
    const before = previousPositions.get(positionKey(position));
    const redeemTimestamp = Date.parse(position.redeemAt);
    const maturityChanged = before?.redeemAt !== position.redeemAt;
    const becameDue = before?.redeemAt === position.redeemAt
      && Number.isFinite(previousObservedAt)
      && Number.isFinite(observedTimestamp)
      && Number.isFinite(redeemTimestamp)
      && previousObservedAt < redeemTimestamp
      && redeemTimestamp <= observedTimestamp;
    if (!maturityChanged && !becameDue) continue;
    const maturity = formatShortDate(position.redeemAt);
    if (!maturity) continue;
    add(position.productId, {
      type: "maturity",
      title: `定期于 ${maturity} 到期`,
      attention: Date.parse(position.redeemAt) <= Date.parse(observedAt),
    });
  }

  return events;
}

export function buildManualChangeEvents(
  previousHoldings: HoldingMap,
  nextHoldings: HoldingMap,
  previousOverrides: ProductOverrideMap,
  nextOverrides: ProductOverrideMap,
  previousManualProducts: Product[],
  nextManualProducts: Product[],
  products: Product[],
  changes: PortfolioChangeIds,
  observedAt = new Date().toISOString(),
) {
  const events: ProductChangeEvent[] = [];
  const productById = new Map<string, Product>();
  [...products, ...previousManualProducts, ...nextManualProducts].forEach((product) => productById.set(product.id, product));
  let sequence = 0;
  const add = (productId: string, event: Omit<ProductChangeEventInput, "productId" | "observedAt" | "source">) => {
    events.push({
      id: eventId(observedAt, productId, sequence++),
      productId,
      observedAt,
      source: "手动编辑",
      ...event,
    });
  };

  for (const productId of changes.holdingProductIds) {
    const product = productById.get(productId);
    const before = previousHoldings[productId] ?? 0;
    const after = nextHoldings[productId] ?? 0;
    if (before !== after) add(productId, {
      type: "holding",
      title: "持仓变化",
      before: `${formatAmount(before)} ${product?.asset ?? "USDT"}`,
      after: `${formatAmount(after)} ${product?.asset ?? "USDT"}`,
    });
  }

  for (const productId of changes.overrideProductIds) {
    const product = productById.get(productId);
    const before = previousOverrides[productId];
    const after = nextOverrides[productId];
    if ((before?.apr ?? null) !== (after?.apr ?? null)) add(productId, {
      type: "rate",
      title: "APR 修改",
      before: formatManualApr(before?.apr),
      after: formatManualApr(after?.apr),
      attention: before?.apr !== null && before?.apr !== undefined && after?.apr !== null && after?.apr !== undefined && after.apr < before.apr,
    });
    if ((before?.firstTierLimit ?? null) !== (after?.firstTierLimit ?? null)) add(productId, {
      type: "capacity",
      title: "首档额度修改",
      before: formatManualLimit(before?.firstTierLimit, product?.asset ?? "USDT"),
      after: formatManualLimit(after?.firstTierLimit, product?.asset ?? "USDT"),
      attention: before?.firstTierLimit !== null && before?.firstTierLimit !== undefined && after?.firstTierLimit !== null && after?.firstTierLimit !== undefined && after.firstTierLimit < before.firstTierLimit,
    });
    if ((before?.termDays ?? null) !== (after?.termDays ?? null)) add(productId, {
      type: "maturity",
      title: "期限修改",
      before: formatTerm(before?.termDays),
      after: formatTerm(after?.termDays),
    });
    if ((before?.purchaseDate ?? null) !== (after?.purchaseDate ?? null)) add(productId, {
      type: "maturity",
      title: "买入日期修改",
      before: formatShortDate(before?.purchaseDate) || "待填写",
      after: formatShortDate(after?.purchaseDate) || "待填写",
    });
  }

  for (const productId of changes.manualProductIds) {
    const before = previousManualProducts.find((product) => product.id === productId);
    const after = nextManualProducts.find((product) => product.id === productId);
    if (!after) continue;
    if (!before) add(productId, { type: "availability", title: "手动产品录入" });
    else if (!sameManualProduct(before, after)) add(productId, {
      type: "availability",
      title: "产品信息修改",
      before: manualProductTypeLabel(before),
      after: manualProductTypeLabel(after),
    });
  }
  return events;
}

export function prepareProductChangeEventStatements(db: D1Database, ownerId: string, events: ProductChangeEvent[]) {
  return events.map((event) => db.prepare(`INSERT INTO product_change_events
      (owner_id, event_id, product_id, change_type, title, before_value, after_value, observed_at, source, attention)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(ownerId, event.id, event.productId, event.type, event.title, event.before ?? null, event.after ?? null,
      event.observedAt, event.source, event.attention ? 1 : 0));
}

export async function loadProductChangeEvents(db: D1Database, ownerId: string, limit = 2000) {
  const result = await db.prepare(`SELECT event_id, product_id, change_type, title, before_value, after_value,
      observed_at, source, attention
      FROM product_change_events
      WHERE owner_id = ?
      ORDER BY observed_at DESC, event_id DESC
      LIMIT ?`).bind(ownerId, limit).all<{
    event_id: string;
    product_id: string;
    change_type: ProductChangeEvent["type"];
    title: string;
    before_value: string | null;
    after_value: string | null;
    observed_at: string;
    source: ProductChangeSource;
    attention: number;
  }>();
  return result.results.map((row) => ({
    id: row.event_id,
    productId: row.product_id,
    type: row.change_type,
    title: row.title,
    ...(row.before_value === null ? {} : { before: row.before_value }),
    ...(row.after_value === null ? {} : { after: row.after_value }),
    observedAt: row.observed_at,
    source: row.source,
    ...(row.attention ? { attention: true } : {}),
  } satisfies ProductChangeEvent));
}

function eventId(observedAt: string, productId: string, sequence: number) {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `change-${observedAt.replace(/[^0-9]/g, "").slice(0, 17)}-${sequence}-${productId}-${random}`;
}

function primaryApr(rate: LiveRate) {
  const value = rate.tiers?.[0]?.apr ?? rate.apr;
  return Number.isFinite(value) ? value : null;
}

function tierSummary(rate: LiveRate) {
  const tiers = rate.tiers ?? [];
  if (tiers.length === 0) return formatApr(primaryApr(rate));
  return tiers.map((tier) => formatApr(tier.apr)).join(" / ");
}

function firstTierCapacity(rate: LiveRate): number | null | undefined {
  if (!rate.tiers?.[0]) return undefined;
  const max = rate.tiers?.[0]?.max;
  return typeof max === "number" && Number.isFinite(max) ? max : null;
}

function formatApr(value: number | null | undefined) {
  return value === null || value === undefined ? "待确认" : `${value.toFixed(2)}%`;
}

function formatCapacity(value: number | null | undefined, asset?: string) {
  if (value === undefined) return "待确认";
  return value === null ? "不限额" : `${formatAmount(value)} ${asset ?? ""}`.trim();
}

function formatTerm(value: number | null | undefined) {
  return value === null || value === undefined ? "待填写" : `${value} 天`;
}

function formatManualApr(value: number | null | undefined) { return value === null || value === undefined ? "待填写" : formatApr(value); }
function formatManualLimit(value: number | null | undefined, asset: string) { return value === null || value === undefined ? "待填写" : `${formatAmount(value)} ${asset}`; }

function availabilitySummary(rate: LiveRate) {
  if (rate.eligibilityStatus === "ineligible") return "账号不符合资格";
  if (rate.availability === "unavailable") return "不可申购";
  if (rate.availability === "available") return "可申购";
  if (rate.eligibilityStatus === "eligible") return "账号符合资格";
  return "待确认";
}

function positionKey(position: HoldingPosition) {
  return `${position.productId}:${position.positionId ?? `${position.purchaseAt ?? ""}|${position.redeemAt ?? ""}`}`;
}

export function sameManualProduct(left: Product, right?: Product) {
  return Boolean(right)
    && left.accountId === right!.accountId
    && left.asset === right!.asset
    && (left.manualKind ?? left.productType) === (right!.manualKind ?? right!.productType)
    && (left.termDays ?? null) === (right!.termDays ?? null);
}

function manualProductTypeLabel(product: Product) {
  if (product.manualKind === "limited") return "限时活期";
  if (product.productType === "fixed") return "定期理财";
  return "活期理财";
}
