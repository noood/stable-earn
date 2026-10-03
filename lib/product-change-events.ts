import type { D1Database } from "@cloudflare/workers-types";
import type { HoldingMap, HoldingPosition, Product, ProductChangeEvent } from "./domain";
import { formatAmount } from "./domain";
import type { LiveRate } from "./live-rates";
import { minimumOpportunityApr } from "./opportunity-policy";
import { formatShortDate, productTermStatus, type ProductOverride, type ProductOverrideMap } from "./product-overrides";

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
    const beforeApr = before ? primaryApr(before) : null;
    const afterApr = primaryApr(rate);

    const previousHolding = knownSnapshotHolding(previous, rate.productId);
    const currentHolding = knownSnapshotHolding(current, rate.productId);
    const beforeCapacity = before ? firstTierCapacity(before) : undefined;
    const afterCapacity = rate.capacitySource === "cache" ? undefined : firstTierCapacity(rate);
    const enteredOverCapacity = overCapacityState(currentHolding, afterCapacity) === true
      && overCapacityState(previousHolding, beforeCapacity) !== true;
    if (enteredOverCapacity) {
      add(rate.productId, {
        type: "capacity",
        title: "持仓超过首档额度",
        before: beforeCapacity === undefined || previousHolding === undefined
          ? "额度或持仓待确认"
          : `${formatAmount(previousHolding)} / ${formatCapacity(beforeCapacity, rate.catalog?.asset)}`,
        after: `${formatAmount(currentHolding!)} / ${formatCapacity(afterCapacity, rate.catalog?.asset)}`,
        attention: true,
      });
    }
    if (!before) continue;

    if (beforeApr !== null && afterApr !== null && beforeApr !== afterApr) {
      add(rate.productId, {
        type: "rate",
        title: afterApr < beforeApr ? "首档 APR 下调" : "首档 APR 上调",
        before: formatApr(beforeApr),
        after: formatApr(afterApr),
        attention: beforeApr >= minimumOpportunityApr && afterApr < minimumOpportunityApr,
      });
    } else if (tierSummary(before) !== tierSummary(rate)) {
      add(rate.productId, {
        type: "rate",
        title: "阶梯 APR 调整",
        before: tierSummary(before),
        after: tierSummary(rate),
      });
    }

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
        attention: false,
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
  const currentPositions = new Map((current.holdingPositions ?? []).map((position) => [positionKey(position), position]));
  const previousObservedAt = previous.fetchedAt ? Date.parse(previous.fetchedAt) : Number.NaN;
  const observedTimestamp = Date.parse(observedAt);
  for (const key of new Set([...previousPositions.keys(), ...currentPositions.keys()])) {
    const position = currentPositions.get(key) ?? previousPositions.get(key)!;
    if (!position.redeemAt) continue;
    const before = previousPositions.get(key);
    const redeemTimestamp = Date.parse(position.redeemAt);
    const maturityChanged = Boolean(before) && before!.redeemAt !== position.redeemAt;
    const becameDue = before?.redeemAt === position.redeemAt
      && Number.isFinite(previousObservedAt)
      && Number.isFinite(observedTimestamp)
      && Number.isFinite(redeemTimestamp)
      && previousObservedAt < redeemTimestamp
      && redeemTimestamp <= observedTimestamp;
    const discoveredDue = !before && Number.isFinite(redeemTimestamp) && redeemTimestamp <= observedTimestamp;
    if (!maturityChanged && !becameDue && !discoveredDue) continue;
    const maturity = formatShortDate(position.redeemAt);
    if (!maturity) continue;
    const wasAlreadyDue = Boolean(before?.redeemAt)
      && Number.isFinite(previousObservedAt)
      && Date.parse(before!.redeemAt!) <= previousObservedAt;
    add(position.productId, {
      type: "maturity",
      title: Date.parse(position.redeemAt) <= observedTimestamp ? "定期已到期" : "定期到期日调整",
      after: maturity,
      attention: !wasAlreadyDue && Date.parse(position.redeemAt) <= observedTimestamp,
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
    const beforeApr = manualApr(product, before);
    const afterApr = manualApr(product, after);
    if (beforeApr !== afterApr) add(productId, {
      type: "rate",
      title: "APR 修改",
      before: formatManualApr(beforeApr),
      after: formatManualApr(afterApr),
      attention: beforeApr !== null && afterApr !== null
        && beforeApr >= minimumOpportunityApr && afterApr < minimumOpportunityApr,
    });
    if ((before?.firstTierLimit ?? null) !== (after?.firstTierLimit ?? null)) add(productId, {
      type: "capacity",
      title: "首档额度修改",
      before: formatManualLimit(before?.firstTierLimit, product?.asset ?? "USDT"),
      after: formatManualLimit(after?.firstTierLimit, product?.asset ?? "USDT"),
      attention: false,
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

  const capacityCandidates = new Set([...changes.holdingProductIds, ...changes.overrideProductIds]);
  for (const productId of capacityCandidates) {
    const product = productById.get(productId);
    if (!product) continue;
    const beforeHolding = previousHoldings[productId];
    const afterHolding = nextHoldings[productId];
    if (!Number.isFinite(beforeHolding) || !Number.isFinite(afterHolding)) continue;
    const beforeCapacity = manualCapacity(product, previousOverrides[productId]);
    const afterCapacity = manualCapacity(product, nextOverrides[productId]);
    if (overCapacityState(afterHolding, afterCapacity) !== true
      || overCapacityState(beforeHolding, beforeCapacity) === true) continue;
    add(productId, {
      type: "capacity",
      title: "持仓超过首档额度",
      before: `${formatAmount(beforeHolding)} / ${formatCapacity(beforeCapacity, product.asset)}`,
      after: `${formatAmount(afterHolding)} / ${formatCapacity(afterCapacity, product.asset)}`,
      attention: true,
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

/** Build an idempotent alert when a manually tracked fixed-term position matures. */
export function buildManualMaturityEvents(
  products: Product[],
  holdings: HoldingMap,
  overrides: ProductOverrideMap,
  today = new Date(),
) {
  const events: ProductChangeEvent[] = [];
  for (const product of products) {
    if (!(holdings[product.id] > 0)) continue;
    const maturity = productTermStatus(product, overrides[product.id]?.purchaseDate, today);
    if (!maturity || maturity.remainingDays > 0) continue;
    const observedAt = new Date(`${maturity.maturityDate}T00:00:00+08:00`).toISOString();
    events.push({
      id: `manual-maturity-${encodeURIComponent(`${product.id}:${maturity.maturityDate}`)}`,
      productId: product.id,
      type: "maturity",
      title: "定期已到期",
      after: formatShortDate(maturity.maturityDate),
      observedAt,
      source: "每日首次打开",
      attention: true,
    });
  }
  return events;
}

export function prepareProductChangeEventStatements(db: D1Database, ownerId: string, events: ProductChangeEvent[]) {
  return events.map((event) => db.prepare(`INSERT OR IGNORE INTO product_change_events
      (owner_id, event_id, product_id, change_type, title, before_value, after_value, observed_at, source, attention)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(ownerId, event.id, event.productId, event.type, event.title, event.before ?? null, event.after ?? null,
      event.observedAt, event.source, event.attention ? 1 : 0));
}

export async function loadProductChangeEvents(db: D1Database, ownerId: string, limit = 2000) {
  const [recent, unread] = await Promise.all([
    db.prepare(`SELECT event_id, product_id, change_type, title, before_value, after_value,
      observed_at, source, attention, read_at
      FROM product_change_events
      WHERE owner_id = ?
      ORDER BY observed_at DESC, event_id DESC
      LIMIT ?`).bind(ownerId, limit).all<ProductChangeEventRow>(),
    db.prepare(`SELECT event_id, product_id, change_type, title, before_value, after_value,
      observed_at, source, attention, read_at
      FROM product_change_events
      WHERE owner_id = ? AND attention = 1 AND read_at IS NULL
      ORDER BY observed_at DESC, event_id DESC`).bind(ownerId).all<ProductChangeEventRow>(),
  ]);
  const rows = new Map<string, ProductChangeEventRow>();
  for (const row of recent.results) rows.set(row.event_id, row);
  for (const row of unread.results) rows.set(row.event_id, row);
  return [...rows.values()]
    .sort((left, right) => right.observed_at.localeCompare(left.observed_at) || right.event_id.localeCompare(left.event_id))
    .map(mapProductChangeEvent);
}

export async function markProductChangeEventsRead(db: D1Database, ownerId: string, productId: string, readAt = new Date().toISOString()) {
  await db.prepare(`UPDATE product_change_events
      SET read_at = ?
      WHERE owner_id = ? AND product_id = ? AND attention = 1 AND read_at IS NULL`)
    .bind(readAt, ownerId, productId)
    .run();
  return readAt;
}

type ProductChangeEventRow = {
    event_id: string;
    product_id: string;
    change_type: ProductChangeEvent["type"];
    title: string;
    before_value: string | null;
    after_value: string | null;
    observed_at: string;
    source: ProductChangeSource;
    attention: number;
    read_at: string | null;
};

const PRODUCT_HISTORY_PAGE_SIZE = 50;

export async function loadProductChangeEventPage(
  db: D1Database,
  ownerId: string,
  productId: string,
  cursor?: string | null,
  pageSize = PRODUCT_HISTORY_PAGE_SIZE,
) {
  const decoded = cursor ? decodeProductChangeCursor(cursor) : null;
  if (cursor && !decoded) throw new Error("Invalid product history cursor");
  const size = Math.max(1, Math.min(100, Math.floor(pageSize)));
  const cursorClause = decoded
    ? " AND (observed_at < ? OR (observed_at = ? AND event_id < ?))"
    : "";
  const params: unknown[] = [ownerId, productId];
  if (decoded) params.push(decoded.observedAt, decoded.observedAt, decoded.eventId);
  params.push(size + 1);
  const result = await db.prepare(`SELECT event_id, product_id, change_type, title, before_value, after_value,
      observed_at, source, attention, read_at
      FROM product_change_events
      WHERE owner_id = ? AND product_id = ?${cursorClause}
      ORDER BY observed_at DESC, event_id DESC
      LIMIT ?`).bind(...params).all<ProductChangeEventRow>();
  const hasMore = result.results.length > size;
  const rows = result.results.slice(0, size);
  const last = rows.at(-1);
  return {
    events: rows.map(mapProductChangeEvent),
    nextCursor: hasMore && last ? encodeProductChangeCursor(last.observed_at, last.event_id) : null,
  };
}

function mapProductChangeEvent(row: ProductChangeEventRow) {
  return {
    id: row.event_id,
    productId: row.product_id,
    type: row.change_type,
    title: row.title,
    ...(row.before_value === null ? {} : { before: row.before_value }),
    ...(row.after_value === null ? {} : { after: row.after_value }),
    observedAt: row.observed_at,
    source: row.source,
    ...(row.attention ? { attention: true } : {}),
    ...(row.read_at ? { readAt: row.read_at } : {}),
  } satisfies ProductChangeEvent;
}

function encodeProductChangeCursor(observedAt: string, eventId: string) {
  const bytes = new TextEncoder().encode(JSON.stringify({ observedAt, eventId }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeProductChangeCursor(cursor: string) {
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { observedAt?: unknown; eventId?: unknown };
    return typeof value.observedAt === "string"
      && Number.isFinite(Date.parse(value.observedAt))
      && typeof value.eventId === "string"
      && value.eventId.length > 0
      && value.eventId.length <= 512
      ? { observedAt: value.observedAt, eventId: value.eventId }
      : null;
  } catch {
    return null;
  }
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
  const firstTier = rate.tiers?.[0];
  if (!firstTier || !Object.prototype.hasOwnProperty.call(firstTier, "max")) return undefined;
  const max = firstTier.max;
  if (max === null) return null;
  return typeof max === "number" && Number.isFinite(max) ? max : undefined;
}

function knownSnapshotHolding(snapshot: ProductSnapshotForChanges, productId: string) {
  if (snapshot.holdingFallbacks?.[productId] !== undefined) return undefined;
  const value = snapshot.holdingUpdates?.[productId];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function overCapacityState(holding: number | undefined, capacity: number | null | undefined) {
  if (holding === undefined || capacity === undefined || capacity === null) return undefined;
  return holding > capacity;
}

function manualCapacity(product: Product, override?: ProductOverride) {
  const limit = override?.firstTierLimit;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) return limit;
  const firstTier = product.tiers[0];
  if (!firstTier || !Object.prototype.hasOwnProperty.call(firstTier, "max")) return undefined;
  const max = firstTier.max;
  if (max === null) return null;
  return typeof max === "number" && Number.isFinite(max) ? max : undefined;
}

function manualApr(product: Product | undefined, override?: ProductOverride) {
  const value = override?.apr ?? product?.tiers[0]?.apr;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
