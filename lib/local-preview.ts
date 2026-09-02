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
  const products = [
    ...rates.map((rate) => previewProduct(rate.productId, rate)),
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
    "okx-usdt": 500,
    "okx-usdc": 500,
    "okx-btc": 0,
  };
  return {
    products,
    rates,
    rateFallbacks: { "bn-g-usdt": cachedAt, "bg-usdc": cachedAt },
    holdingUpdates,
    holdingSourceIds: Object.keys(holdingUpdates),
    holdingFallbacks: { "bn-g-usdt": cachedAt, "bg-usdc": cachedAt, "by-g-btc-3d": cachedAt },
    fetchedAt: freshAt,
    partial: true,
    holdingSyncStates: {
      "bn-bh-usdc": "not_configured",
      "bn-g-usdc": "synced",
      "by-g-btc-3d": "error",
      "by-g-usdt-short-fixed": "partial",
    },
    note: "本地测试数据：包含完整、缓存、待确认、未获取、同步失败、部分同步和手动维护场景。",
    failures: ["Bybit.com BTC"],
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
  };
  const overrides: ProductOverrideMap = {
    "bg-usdgo": manualOverride(5.5, 1000, updatedAt),
    "mexc-ph-usdt": manualOverride(5.2, 2000, updatedAt),
    "mexc-ph-usdc": { apr: 4.8, firstTierLimit: null, termDays: null, purchaseDate: null, updatedAt },
    "okx-usdt": { apr: 10, firstTierLimit: 500, termDays: null, purchaseDate: null, updatedAt },
    "okx-usdc": { apr: 10, firstTierLimit: 500, termDays: 180, purchaseDate: dateOnlyOffset(now, -190), updatedAt },
    "okx-btc": { apr: 5, firstTierLimit: 0.01, termDays: 180, purchaseDate: dateOnlyOffset(now, -3), updatedAt },
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
  return { holdings, overrides, manualProducts, hiddenSeedProductIds: [], found: true };
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
