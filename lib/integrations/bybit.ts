import { exchangeFetch, readExchangeJson } from "@/lib/exchange-fetch";
import { buildPlatformProductIdentity } from "@/lib/product-identity";
import type { Product } from "@/lib/domain";
import { apiAssetsFor } from "@/lib/platform-capabilities";
import { syncDiagnostic } from "@/lib/sync-diagnostics";

type BybitCredentials = {
  apiKey: string;
  apiSecret: string;
  baseUrls: readonly string[];
};

export const bybitGlobalApiBases = ["https://api.bybit.com", "https://api.bytick.com"] as const;

type BybitPositionRow = {
  coin?: string;
  amount?: string;
  productId?: string;
};

type BybitFixedProductRow = {
  productId?: string;
  category?: string;
  coin?: string;
  duration?: string;
  status?: string;
  tieredApyList?: Array<{ min?: string; max?: string; apy?: string }>;
  minStakeAmount?: string;
  maxStakeAmount?: string;
  subscribeStartAt?: string;
  subscribeEndAt?: string;
  interestCoinApyList?: Array<{ apy?: string }>;
  isVip?: boolean;
  specialUserGroupRequired?: boolean;
  specialUserGroupInfo?: string;
};

type BybitFixedPositionRow = {
  productId?: string;
  coin?: string;
  duration?: string;
  amount?: string;
  status?: string;
};

type BybitResponse<Row> = {
  retCode?: number;
  retMsg?: string;
  result?: { list?: Row[] };
};

type SupportedAsset = Product["asset"];

type BybitFlexibleProductRow = {
  productId?: string;
  coin?: string;
  status?: string;
  tierAprDetails?: unknown[];
};

const supportedFixedAssets = new Set<Product["asset"]>(apiAssetsFor("bybit-global", "fixed", "productApi"));

export async function fetchBybitFlexibleHoldings(
  credentials: BybitCredentials,
  account: "global" | "eu",
  assets: readonly SupportedAsset[] = apiAssetsFor(
    account === "global" ? "bybit-global" : "bybit-eu",
    "flexible",
    "holdingApi",
  ),
) {
  const holdings: Record<string, number> = {};
  const results = await Promise.allSettled(assets.map(async (asset) => {
    const query = new URLSearchParams({ category: "FlexibleSaving", coin: asset });
    const response = await signedGet<BybitPositionRow>("/v5/earn/position", query, credentials);
    const accountId = account === "eu" ? "bybit-eu" : "bybit-global";
    const rows = (response.result?.list ?? []).filter((row) => row.coin === asset);
    const amounts = new Map<string, number>();
    for (const row of rows) {
      const externalProductId = row.productId?.trim() || `flexible-${asset.toLowerCase()}`;
      const identity = buildPlatformProductIdentity({
        accountId,
        asset,
        productType: "flexible",
        externalProductId,
      });
      amounts.set(identity.identityKey, (amounts.get(identity.identityKey) ?? 0) + finiteNumber(row.amount));
    }
    // The public product list is traced in live-rates.ts. Pair it with this
    // sanitized position trace so product IDs can be compared without logging
    // signed request details or the raw exchange response.
    syncDiagnostic("bybit_flexible_position_rows", {
      account: account === "eu" ? "bybit-eu" : "bybit-global",
      asset,
      rowCount: rows.length,
      rows: rows.map((row) => ({
        productId: row.productId?.trim() || null,
        coin: row.coin ?? null,
        amount: finiteNumber(row.amount),
      })),
      productTotals: [...amounts.entries()].map(([identityKey, amount]) => ({ identityKey, amount })),
    });
    // A successful empty position response is intentionally represented by no
    // update. The catalog's complete-account rule records zero for the known
    // product without borrowing an old holding from another product.
    return [...amounts.entries()] as Array<readonly [string, number]>;
  }));

  results.forEach((result) => {
    if (result.status === "fulfilled") {
      for (const [productId, amount] of result.value) holdings[productId] = amount;
    }
  });
  return {
    holdings,
    sync: {
      successfulAssets: assets.filter((_, index) => results[index].status === "fulfilled"),
      failedAssets: assets.filter((_, index) => results[index].status === "rejected"),
    },
  };
}

/** Public, read-only check for one Bybit flexible-earn asset outside routine sync. */
export async function probeBybitFlexibleProducts(accountId: "bybit-global" | "bybit-eu", asset: Product["asset"]) {
  const baseUrls = accountId === "bybit-eu" ? ["https://api.bybit.eu"] : bybitGlobalApiBases;
  const query = new URLSearchParams({ category: "FlexibleSaving", coin: asset });
  const response = await publicGet<BybitFlexibleProductRow>("/v5/earn/product", query, baseUrls);
  return (response.result?.list ?? [])
    .filter((row) => !row.coin || row.coin.toUpperCase() === asset)
    .map((row) => ({
      productId: row.productId?.trim() || null,
      coin: row.coin?.toUpperCase() || asset,
      status: row.status ?? null,
      tierCount: row.tierAprDetails?.length,
    }));
}

/** Public, read-only check for Bybit fixed-term product/APR rows by account region. */
export async function probeBybitFixedProducts(accountId: "bybit-global" | "bybit-eu") {
  const baseUrls = accountId === "bybit-eu" ? ["https://api.bybit.eu"] : bybitGlobalApiBases;
  const response = await publicGet<BybitFixedProductRow>(
    "/v5/earn/fixed-term/product",
    new URLSearchParams(),
    baseUrls,
  );
  return (response.result?.list ?? [])
    .filter((row) => supportedFixedAssets.has(row.coin?.toUpperCase() as Product["asset"]))
    .flatMap((row) => {
      const productId = row.productId?.trim();
      const duration = normalizeBybitDuration(row.duration);
      const coin = row.coin?.toUpperCase() as Product["asset"];
      if (!productId || !duration || !supportedFixedAssets.has(coin)) return [];
      return [{
        externalProductId: `${productId}@${duration}`,
        coin,
        duration,
        status: row.status ?? null,
        tierCount: fixedProductTiers(row).length,
        isVip: Boolean(row.isVip),
        specialUserGroupRequired: Boolean(row.specialUserGroupRequired),
      }];
    });
}

export async function fetchBybitShortFixedSnapshots(credentials: BybitCredentials) {
  const [productResult, positionResult] = await Promise.allSettled([
    publicGet<BybitFixedProductRow>(
      "/v5/earn/fixed-term/product",
      new URLSearchParams(),
      credentials.baseUrls,
    ),
    signedGet<BybitFixedPositionRow>(
      "/v5/earn/fixed-term/position",
      new URLSearchParams(),
      credentials,
    ),
  ]);
  const productRows = productResult.status === "fulfilled" ? productResult.value.result?.list ?? [] : [];
  const rawPositionRows = positionResult.status === "fulfilled" ? positionResult.value.result?.list ?? [] : [];
  const positions = rawPositionRows.filter((row) => (
    Boolean(row.productId)
    && supportedFixedAssets.has(row.coin as Product["asset"])
  ));
  const productIdentityIncomplete = productRows.some((row) => (
    supportedFixedAssets.has(row.coin as Product["asset"])
    && (!row.productId?.trim() || !normalizeBybitDuration(row.duration))
  ));
  const rates = productRows.flatMap((row) => {
    const rate = fixedProductRate(row);
    return rate ? [rate] : [];
  });
  const resolvedPositions = positions.flatMap((row) => {
    const externalProductId = resolveBybitFixedPositionId(row, rates);
    return externalProductId ? [{ row, externalProductId }] : [];
  });
  const unresolvedPositionCount = rawPositionRows.filter((row) => (
    supportedFixedAssets.has(row.coin as Product["asset"])
  )).length - resolvedPositions.length;
  syncDiagnostic("bybit_fixed_rows", {
    productApiStatus: productResult.status === "rejected" ? "error" : productIdentityIncomplete ? "partial" : "success",
    productRowCount: productRows.length,
    productRows: productRows.flatMap((row) => {
      const coin = String(row.coin ?? "").toUpperCase();
      if (!supportedFixedAssets.has(coin as Product["asset"])) return [];
      return [{
        productId: row.productId?.trim() || null,
        coin,
        duration: row.duration ?? null,
        status: row.status ?? null,
        isVip: Boolean(row.isVip),
        specialUserGroupRequired: Boolean(row.specialUserGroupRequired),
        tiers: fixedProductTiers(row),
      }];
    }),
    holdingsApiStatus: positionResult.status === "rejected" ? "error" : unresolvedPositionCount > 0 ? "partial" : "success",
    positionRowCount: rawPositionRows.length,
    unresolvedPositionCount,
    positionRows: positions.map((row) => ({
      productId: row.productId?.trim() || null,
      coin: row.coin ?? null,
      duration: row.duration ?? null,
      status: row.status ?? null,
      hasPositiveHolding: finiteNumber(row.amount) > 0,
    })),
  });
  const holdings: Record<string, number> = {};

  if (positionResult.status === "fulfilled") {
    for (const rate of rates) {
      const amount = resolvedPositions
        .filter(({ row, externalProductId }) => externalProductId === rate.externalProductId && row.coin === rate.catalog?.asset)
        .reduce((sum, { row }) => sum + finiteNumber(row.amount), 0);
      holdings[rate.productId] = amount;
      if (rate.externalProductId) holdings[rate.externalProductId] = amount;
    }
    for (const { row, externalProductId } of resolvedPositions) {
      const matched = rates.some((rate) => rate.externalProductId === externalProductId && rate.catalog?.asset === row.coin);
      if (!matched) holdings[externalProductId] = (holdings[externalProductId] ?? 0) + finiteNumber(row.amount);
    }
  }

  return {
    rates,
    holdings,
    sync: {
      products: productResult.status === "fulfilled" && !productIdentityIncomplete,
      holdings: positionResult.status === "fulfilled" && unresolvedPositionCount === 0,
    },
  };
}

function fixedProductRate(row: BybitFixedProductRow) {
  const asset = row.coin as Product["asset"];
  const sourceProductId = row.productId?.trim();
  const duration = normalizeBybitDuration(row.duration);
  if (!sourceProductId || !duration || !supportedFixedAssets.has(asset)) return null;
  const tiers = fixedProductTiers(row);
  const subscriptionStart = timestampIso(row.subscribeStartAt);
  const subscriptionEnd = timestampIso(row.subscribeEndAt);
  const termDays = parseDurationDays(row.duration);
  const externalProductId = `${sourceProductId}@${duration}`;
  const identity = buildPlatformProductIdentity({
    accountId: "bybit-global",
    asset,
    productType: "fixed",
    externalProductId,
  });
  const eligibilityRequired = Boolean(row.specialUserGroupRequired || row.isVip);
  const eligibilityLabel = row.specialUserGroupInfo || (row.isVip ? "VIP 用户" : undefined);

  return {
    productId: identity.identityKey,
    ...identity,
    sourceProductId,
    legacyIdentityKey: `bybit-global:${asset}:fixed:${sourceProductId}`,
    name: `Fixed Saving · ${formatDuration(row.duration)}`,
    apr: tiers[0]?.apr ?? 0,
    tiers,
    fetchedAt: new Date().toISOString(),
    sourceLabel: "Bybit 官方固定期限产品与账户持仓 API",
    productType: "fixed" as const,
    termDays: termDays > 0 ? termDays : undefined,
    minimumAmount: finiteNumber(row.minStakeAmount),
    subscriptionStartsAt: subscriptionStart,
    subscriptionEndsAt: subscriptionEnd,
    availability: row.status === "Available" ? "available" as const : "unavailable" as const,
    eligibilityRequired,
    eligibilityLabel,
    eligibilityStatus: eligibilityRequired ? "unknown" as const : undefined,
    rateCoverage: tiers.length > 0 ? "complete" as const : "unavailable" as const,
    catalog: {
      accountId: "bybit-global",
      exchange: "bybit" as const,
      region: "global" as const,
      asset,
      holdingDataMode: "api" as const,
      apiAccess: "authenticated" as const,
    },
  };
}

function resolveBybitFixedPositionId(position: BybitFixedPositionRow, rates: ReturnType<typeof fixedProductRate>[]) {
  const sourceProductId = position.productId?.trim();
  if (!sourceProductId) return undefined;
  const duration = normalizeBybitDuration(position.duration);
  if (duration) return `${sourceProductId}@${duration}`;
  const candidates = new Set(rates
    .filter((rate) => rate?.sourceProductId === sourceProductId && rate.catalog?.asset === position.coin)
    .map((rate) => rate?.externalProductId)
    .filter((id): id is string => Boolean(id)));
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function normalizeBybitDuration(value: string | undefined) {
  const duration = value?.trim().toLowerCase();
  return duration && /^\d+(?:\.\d+)?[dhm]$/.test(duration) ? duration : undefined;
}

function parseDurationDays(value: string | undefined) {
  const match = value?.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([dhm])$/);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return 0;
  if (match[2] === "d") return amount;
  if (match[2] === "h") return amount / 24;
  return amount / 1440;
}

function formatDuration(value: string | undefined) {
  const durationDays = parseDurationDays(value);
  if (durationDays >= 1) return `${formatCompact(durationDays)} 天`;
  if (durationDays > 0) return `${formatCompact(durationDays * 24)} 小时`;
  return value || "短期";
}

function formatCompact(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.0+$|(?<=\.[0-9])0+$/, "");
}

function timestampIso(value: string | undefined) {
  const timestamp = finiteNumber(value);
  return timestamp > 0 ? new Date(timestamp).toISOString() : undefined;
}

function fixedProductTiers(row: BybitFixedProductRow) {
  const tiered = (row.tieredApyList ?? []).flatMap((tier) => {
    const min = finiteNumber(tier.min);
    const rawMax = finiteNumber(tier.max);
    const apr = parsePercent(tier.apy);
    const max = tier.max === "-1" ? null : rawMax > min ? rawMax : null;
    return Number.isFinite(apr) ? [{ min, max, apr }] : [];
  }).sort((left, right) => left.min - right.min);
  if (tiered.length > 0) return tiered;

  const apr = (row.interestCoinApyList ?? []).reduce((sum, item) => {
    const value = parsePercent(item.apy);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  const max = finiteNumber(row.maxStakeAmount);
  if (apr <= 0) return [];
  return [{ min: 0, max: row.maxStakeAmount === "-1" ? null : max > 0 ? max : null, apr }];
}

async function publicGet<Row>(path: string, query: URLSearchParams, baseUrls: readonly string[]) {
  let lastError: unknown;
  for (const baseUrl of baseUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await exchangeFetch(`${baseUrl}${path}?${query.toString()}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      const body = await readExchangeJson<BybitResponse<Row>>(response);
      if (!response.ok || body.retCode !== 0) {
        throw new Error(`Bybit public API failed (${response.status}/${body.retCode ?? "unknown"})`);
      }
      return body;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("Bybit public API unavailable");
}

async function signedGet<Row>(path: string, query: URLSearchParams, credentials: BybitCredentials) {
  const queryString = query.toString();
  let lastError: unknown;

  for (const baseUrl of credentials.baseUrls) {
    const timestamp = String(Date.now());
    const recvWindow = "5000";
    const signature = await hmacHex(
      `${timestamp}${credentials.apiKey}${recvWindow}${queryString}`,
      credentials.apiSecret,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await exchangeFetch(`${baseUrl}${path}?${queryString}`, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-BAPI-API-KEY": credentials.apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      });
      const body = await readExchangeJson<BybitResponse<Row>>(response);
      if (!response.ok || body.retCode !== 0) {
        throw new Error(`Bybit read-only API failed (${response.status}/${body.retCode ?? "unknown"})`);
      }
      return body;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("Bybit read-only API unavailable");
}

function parsePercent(value: string | undefined) {
  const parsed = Number.parseFloat(value?.replace("%", "") ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

async function hmacHex(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function finiteNumber(value: string | number | undefined) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}
