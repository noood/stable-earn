import type { HoldingMap, Product } from "./domain";
import type { ProductOverrideMap } from "./product-overrides";
import { seedProducts } from "./seed-data";

export function localPrivateProductsPreview(now = new Date()) {
  const freshAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const cachedAt = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const rates = [
    // API product states: complete, cached, base-only, max-only and fresh
    // fixed-term data. The product catalogue also includes an unavailable API
    // row below so edit mode can show the no-rate state.
    previewRate("bn-bh-usdt", [[0, 500, 6.2], [500, null, 2.5]], freshAt, "Binance Bahrain 官方账户 API"),
    previewRate("bn-g-usdt", [[0, 500, 6.2], [500, null, 2.5]], cachedAt, "Binance.com 官方账户 API"),
    previewRate("bn-g-usdc", [[0, 200, 5.8], [200, null, 2.2]], freshAt, "Binance.com 官方账户 API"),
    previewRate("by-g-usdc", [[0, 300, 4.2]], freshAt, "Bybit.com 官方公开 API", { rateCoverage: "base_only" }),
    previewRate("by-eu-usdt", [[0, null, 5.2]], freshAt, "Bybit EU 官方公开 API"),
    previewRate("by-g-usdt-short-fixed", [[0, null, 8.8]], freshAt, "Bybit.com 官方固定期限 API", { productType: "fixed", termDays: 7, rateCoverage: "max_only" }),
    previewRate("by-g-btc-3d", [[0, 1, 6.4]], freshAt, "Bybit.com 官方固定期限 API", { productType: "fixed", termDays: 3 }),
    previewRate("bg-usdc", [[0, 300, 5.8], [300, null, 1.75]], cachedAt, "Bitget 官方账户 API"),
  ];
  // Two identical Bybit products exercise the same missing purchase-date rule
  // with different holding sources: one is read-only from API and one is
  // editable by the user.
  const bybitEligibilityApi = previewBybitEligibilityProduct("preview-bybit-fixed-api", "api", freshAt, now);
  const bybitEligibilityManual = previewBybitEligibilityProduct("preview-bybit-fixed-manual", "manual", freshAt, now);
  const boundaryOpportunity = previewBybitFixedProduct("preview-apr-six", "api", freshAt, {
    name: "Fixed Saving · 7 天 · APR 边界",
    termDays: 7,
    tiers: [{ id: "preview-apr-six-tier-0", min: 0, max: 200, apr: 6 }],
  });
  const heldBelowThreshold = previewBybitFixedProduct("preview-below-threshold-held", "api", freshAt, {
    name: "Fixed Saving · 7 天 · 低于门槛但有持仓",
    termDays: 7,
    tiers: [{ id: "preview-below-threshold-held-tier-0", min: 0, max: 200, apr: 5.9 }],
  });
  const heldLongTerm = previewBybitFixedProduct("preview-long-term-held", "api", freshAt, {
    name: "Fixed Saving · 30 天 · 有持仓",
    termDays: 30,
    tiers: [{ id: "preview-long-term-held-tier-0", min: 0, max: 500, apr: 8 }],
  });
  const heldUnavailable = previewBybitFixedProduct("preview-unavailable-held", "api", freshAt, {
    name: "Fixed Saving · 已停止申购但有持仓",
    availability: "unavailable",
    termDays: 7,
    tiers: [{ id: "preview-unavailable-held-tier-0", min: 0, max: 100, apr: 7.2 }],
  });
  const heldIneligible = previewBybitFixedProduct("preview-ineligible-held", "api", freshAt, {
    name: "Fixed Saving · 不合资格但有持仓",
    eligibilityRequired: true,
    eligibilityLabel: "新用户",
    eligibilityStatus: "ineligible",
    termDays: 7,
    tiers: [{ id: "preview-ineligible-held-tier-0", min: 0, max: 100, apr: 7.1 }],
  });
  const previousCycle = previewBybitFixedProduct("preview-cycle-old", "api", freshAt, {
    name: "Fixed Saving · 上一期仍有持仓",
    availability: "unavailable",
    externalProductId: "preview-reused-product-id",
    subscriptionStartsAt: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    subscriptionEndsAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    termDays: 7,
    tiers: [{ id: "preview-cycle-old-tier-0", min: 0, max: 100, apr: 6.8 }],
  });
  const currentCycle = previewBybitFixedProduct("preview-cycle-new", "api", freshAt, {
    name: "Fixed Saving · 新一期零持仓",
    availability: "available",
    externalProductId: "preview-reused-product-id",
    subscriptionStartsAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    subscriptionEndsAt: new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString(),
    termDays: 7,
    tiers: [{ id: "preview-cycle-new-tier-0", min: 0, max: 100, apr: 6.9 }],
  });
  const products = [
    ...rates.map((rate) => previewProduct(rate.productId, rate)),
    bybitEligibilityApi,
    bybitEligibilityManual,
    boundaryOpportunity,
    heldBelowThreshold,
    heldLongTerm,
    heldUnavailable,
    heldIneligible,
    previousCycle,
    currentCycle,
    previewProduct("bn-bh-usdc", undefined, { rateCoverage: "unavailable" }),
    previewProduct("bg-usdgo"),
    previewProduct("mexc-ph-usdt"),
    previewProduct("mexc-ph-usdc"),
    previewProduct("okx-usdt"),
    previewProduct("okx-usdc"),
    previewProduct("okx-btc"),
  ];
  const holdingUpdates: HoldingMap = {
    "bn-bh-usdt": 180,
    "bn-g-usdt": 650,
    "by-g-usdc": 0,
    "by-eu-usdt": 250,
    // The current Bybit BTC request fails, but the account has a previous
    // holding snapshot. This exercises the "holding cache" state separately
    // from the product-rate cache above.
    "by-g-btc-3d": 0.2,
    "bg-usdc": 200,
    "preview-bybit-fixed-api": 0,
    "preview-bybit-fixed-manual": 80,
    "preview-apr-six": 0,
    "preview-below-threshold-held": 25,
    "preview-long-term-held": 40,
    "preview-unavailable-held": 30,
    "preview-ineligible-held": 20,
    "preview-cycle-old": 10,
    "preview-cycle-new": 0,
    "okx-usdt": 500,
    "okx-usdc": 500,
    "okx-btc": 0,
  };
  return {
    products,
    rates,
    rateFallbacks: { "bn-g-usdt": cachedAt, "bg-usdc": cachedAt },
    holdingUpdates,
    holdingSourceIds: Object.keys(holdingUpdates).filter((productId) => productId !== "preview-bybit-fixed-manual"),
    holdingFallbacks: { "bn-g-usdt": cachedAt, "bg-usdc": cachedAt, "by-g-btc-3d": cachedAt },
    fetchedAt: freshAt,
    partial: true,
    holdingSyncStates: {
      "bn-bh-usdc": "not_configured",
      "bn-g-usdc": "synced",
      "by-g-btc-3d": "error",
      "by-g-usdt-short-fixed": "partial",
      "preview-bybit-fixed-api": "synced",
      "preview-apr-six": "synced",
      "preview-below-threshold-held": "synced",
      "preview-long-term-held": "synced",
      "preview-unavailable-held": "synced",
      "preview-ineligible-held": "synced",
      "preview-cycle-old": "synced",
      "preview-cycle-new": "synced",
    },
    note: "本地测试数据：包含完整、缓存、字段缺失、资格待确认、未获取、同步失败、部分同步和两种 Bybit 持仓来源。",
    failures: ["Bybit.com 定期产品"],
    fallbackUpdatedAt: cachedAt,
    cache: {
      state: "fresh" as const,
      updatedAt: freshAt,
      expiresAt: null,
      cooldownUntil: null,
      lastAttemptAt: freshAt,
      lastError: null,
    },
  };
}

export function localPrivateHoldingsPreview(now = new Date()) {
  const updatedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const holdings: HoldingMap = {
    "by-eu-usdt": 250,
    "by-eu-usdc": 500,
    "bg-usdgo": 200,
    "mexc-ph-usdt": 100,
    "preview-bybit-fixed-manual": 80,
  };
  const overrides: ProductOverrideMap = {
    "bg-usdgo": manualOverride(5.5, 1000, updatedAt),
    "mexc-ph-usdt": manualOverride(5.2, 2000, updatedAt),
    "mexc-ph-usdc": { apr: 4.8, firstTierLimit: null, termDays: null, purchaseDate: null, updatedAt },
    "okx-usdt": { apr: 10, firstTierLimit: 500, termDays: null, purchaseDate: null, updatedAt },
    "okx-usdc": { apr: 10, firstTierLimit: 500, termDays: 180, purchaseDate: dateOnlyOffset(now, -190), updatedAt },
    "okx-btc": { apr: 5, firstTierLimit: 0.01, termDays: 180, purchaseDate: dateOnlyOffset(now, -3), updatedAt },
    "preview-apr-six": { apr: null, firstTierLimit: null, termDays: null, purchaseDate: dateOnlyOffset(now, -1), updatedAt },
    "preview-below-threshold-held": { apr: null, firstTierLimit: null, termDays: null, purchaseDate: dateOnlyOffset(now, -2), updatedAt },
    "preview-long-term-held": { apr: null, firstTierLimit: null, termDays: null, purchaseDate: dateOnlyOffset(now, -4), updatedAt },
    "preview-unavailable-held": { apr: null, firstTierLimit: null, termDays: null, purchaseDate: dateOnlyOffset(now, -10), updatedAt },
    "preview-ineligible-held": { apr: null, firstTierLimit: null, termDays: null, purchaseDate: dateOnlyOffset(now, -2), updatedAt },
    "preview-cycle-old": { apr: null, firstTierLimit: null, termDays: null, purchaseDate: dateOnlyOffset(now, -14), updatedAt },
  };
  const manualProducts = [
    previewManualProduct("manual-preview-limited", "USDT", "limited", 7),
    previewManualProduct("manual-preview-fixed", "USDT", "fixed", 7),
    previewManualProduct("manual-preview-fixed-missing-term", "USDT", "fixed"),
    previewManualProduct("manual-preview-fixed-missing-date", "USDT", "fixed", 7),
    previewManualProduct("manual-preview-apr-missing", "USDT", "flexible"),
  ];
  holdings["manual-preview-limited"] = 80;
  holdings["manual-preview-fixed"] = 40;
  holdings["manual-preview-fixed-missing-term"] = 30;
  holdings["manual-preview-fixed-missing-date"] = 25;
  overrides["manual-preview-limited"] = { apr: 7.5, firstTierLimit: 200, termDays: 7, purchaseDate: dateOnlyOffset(now, -3), updatedAt };
  overrides["manual-preview-fixed"] = { apr: 6.2, firstTierLimit: 100, termDays: 7, purchaseDate: dateOnlyOffset(now, -12), updatedAt };
  overrides["manual-preview-fixed-missing-term"] = { apr: 6.2, firstTierLimit: 100, termDays: null, purchaseDate: null, updatedAt };
  overrides["manual-preview-fixed-missing-date"] = { apr: 6.0, firstTierLimit: 100, termDays: null, purchaseDate: null, updatedAt };
  return { holdings, overrides, manualProducts, hiddenProductIds: [], found: true };
}

function previewBybitEligibilityProduct(id: string, holdingDataMode: "api" | "manual", fetchedAt: string, now: Date): Product {
  return previewBybitFixedProduct(id, holdingDataMode, fetchedAt, {
    name: "Fixed Saving · 3 天",
    termDays: 3,
    minimumAmount: 100,
    subscriptionEndsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    eligibilityRequired: true,
    eligibilityLabel: "Crazy Thursday: New User",
    eligibilityStatus: "unknown",
    tiers: [{ id: `${id}-tier-0`, min: 0, max: 200, apr: 555 }],
  });
}

function previewBybitFixedProduct(
  id: string,
  holdingDataMode: "api" | "manual",
  fetchedAt: string,
  patch: Partial<Product> = {},
): Product {
  const base = seedProducts.find((product) => product.id === "by-g-usdt-short-fixed")!;
  return {
    ...base,
    id,
    name: "Fixed Saving · 7 天",
    productType: "fixed",
    termDays: 7,
    tiers: [{ id: `${id}-tier-0`, min: 0, max: 200, apr: 6.5 }],
    source: { kind: "live", label: "Bybit.com 官方固定期限 API", fetchedAt },
    rateCoverage: "complete",
    availability: "available",
    identityKey: id,
    ...patch,
    productDataMode: "api",
    apiAccess: "authenticated",
    holdingDataMode,
  };
}

export function isLocalPreviewRequest(request: Request) {
  return process.env.NODE_ENV === "development"
    && new URL(request.url).searchParams.get("preview") === "1";
}

function previewRate(
  productId: string,
  tiers: Array<[number, number | null, number]>,
  fetchedAt: string,
  sourceLabel: string,
  facts: { productType?: "flexible" | "fixed"; termDays?: number; rateCoverage?: Product["rateCoverage"] } = {},
) {
  return {
    productId,
    apr: tiers[0]?.[2] ?? 0,
    tiers: tiers.map(([min, max, apr]) => ({ min, max, apr })),
    fetchedAt,
    sourceLabel,
    ...facts,
  };
}

function previewProduct(id: string, rate?: ReturnType<typeof previewRate>, patch: Partial<Product> = {}) {
  const base = seedProducts.find((product) => product.id === id);
  if (!base) throw new Error(`Missing seed product: ${id}`);
  return {
    ...base,
    ...patch,
    ...(rate ? {
      tiers: rate.tiers?.map((tier, index) => ({ ...tier, id: `${id}-tier-${index}` })),
      rateCoverage: rate.rateCoverage ?? (rate.tiers ? "complete" as const : base.rateCoverage),
      source: { kind: "live" as const, label: rate.sourceLabel, fetchedAt: rate.fetchedAt },
      productType: rate.productType ?? base.productType,
      termDays: rate.termDays ?? base.termDays,
    } : {}),
  };
}

function previewManualProduct(id: string, asset: Product["asset"], kind: "flexible" | "limited" | "fixed", termDays?: number): Product {
  const account = seedProducts.find((product) => product.accountId === "binance-global" && product.asset === asset)!;
  const { apiAccess, ...manualBase } = account;
  void apiAccess;
  return {
    ...manualBase,
    id,
    name: kind === "fixed" ? "手动定期理财" : kind === "limited" ? "手动限时活期" : "手动活期理财",
    productDataMode: "manual",
    holdingDataMode: "manual",
    productType: kind === "fixed" ? "fixed" : "flexible",
    manualKind: kind,
    termDays,
    tiers: [{ id: `${id}-tier-0`, min: 0, max: 200, apr: 0 }],
    source: { kind: "manual", label: "手动添加" },
    rateCoverage: "unavailable",
    identityKey: id,
  };
}

function dateOnlyOffset(now: Date, days: number) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function manualOverride(apr: number, firstTierLimit: number, updatedAt: string) {
  return { apr, firstTierLimit, termDays: null, purchaseDate: null, updatedAt };
}
