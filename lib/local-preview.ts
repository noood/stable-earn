import type { HoldingMap } from "./domain";
import type { ProductOverrideMap } from "./product-overrides";

export function localPrivateProductsPreview(now = new Date()) {
  const freshAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const cachedAt = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const rates = [
    previewRate("bn-bh-usdt", [[0, 500, 6.2], [500, null, 2.5]], freshAt, "Binance Bahrain 本地 API 测试数据"),
    previewRate("bn-bh-usdc", [[0, 200, 5.8], [200, null, 2.2]], freshAt, "Binance Bahrain 本地 API 测试数据"),
    previewRate("bn-g-usdt", [[0, 500, 6.2], [500, null, 2.5]], cachedAt, "Binance.com 本地缓存测试数据"),
    previewRate("by-g-usdc", [[0, null, 3.8]], freshAt, "Bybit.com 本地 API 测试数据"),
    previewRate("by-eu-usdt", [[0, null, 3.5]], freshAt, "Bybit EU 本地 API 测试数据"),
    previewRate("by-g-usdt-short-fixed", [[0, 1000, 4.5]], freshAt, "Bybit.com 本地 API 测试数据", { productType: "fixed", termDays: 7 }),
    previewRate("bg-usdc", [[0, 300, 5.8], [300, null, 1.75]], cachedAt, "Bitget 本地缓存测试数据"),
  ];
  const holdingUpdates: HoldingMap = {
    "bn-bh-usdt": 180,
    "bn-g-usdt": 650,
    "by-g-usdt": 420,
    "by-g-usdc": 300,
    "by-g-usdt-short-fixed": 100,
    "bg-usdt-simple": 300,
    "bg-usdc": 200,
    "okx-usdt": 500,
    "okx-usdc": 500,
    "okx-btc": 0,
  };
  return {
    rates,
    rateFallbacks: { "bn-g-usdt": cachedAt, "bg-usdc": cachedAt },
    holdingUpdates,
    holdingSourceIds: Object.keys(holdingUpdates),
    holdingFallbacks: { "bn-g-usdt": cachedAt, "bg-usdc": cachedAt },
    fetchedAt: freshAt,
    partial: true,
    note: "本地测试数据：包含最新 API、缓存、无缓存和手动维护场景。",
    failures: ["Binance.com", "Bitget USDC"],
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
    "by-g-usdt": { apr: 6.85, firstTierLimit: 200, termDays: null, purchaseDate: null, updatedAt },
    "by-eu-usdc": { apr: 10, firstTierLimit: 100, termDays: null, purchaseDate: null, updatedAt },
    "bg-usdgo": manualOverride(5.5, 1000, updatedAt),
    "mexc-ph-usdt": manualOverride(5.2, 2000, updatedAt),
    "okx-usdt": { apr: 10, firstTierLimit: 500, termDays: 180, purchaseDate: "2026-08-01", updatedAt },
    "okx-usdc": { apr: 10, firstTierLimit: 500, termDays: 180, purchaseDate: "2026-08-01", updatedAt },
    "okx-btc": { apr: 5, firstTierLimit: 0.01, termDays: 180, purchaseDate: null, updatedAt },
  };
  return { holdings, overrides, manualProducts: [], hiddenSeedProductIds: [], found: true };
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
  facts: { productType?: "flexible" | "fixed"; termDays?: number } = {},
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

function manualOverride(apr: number, firstTierLimit: number, updatedAt: string) {
  return { apr, firstTierLimit, termDays: null, purchaseDate: null, updatedAt };
}
