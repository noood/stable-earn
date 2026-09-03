import { exchangeFetch } from "@/lib/exchange-fetch";
import { buildProductIdentity } from "@/lib/product-identity";
import type { Product } from "@/lib/domain";

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
  amount?: string;
  status?: string;
};

type BybitResponse<Row> = {
  retCode?: number;
  retMsg?: string;
  result?: { list?: Row[] };
};

const productIds = {
  USDT: "by-g-usdt",
  USDC: "by-g-usdc",
} as const;

type SupportedAsset = keyof typeof productIds;

const supportedFixedAssets = new Set<Product["asset"]>(["USDT", "USDC", "USDGO", "BTC"]);

export async function fetchBybitFlexibleHoldings(
  credentials: BybitCredentials,
  account: "global" | "eu",
  assets: readonly SupportedAsset[] = ["USDT", "USDC"],
) {
  const holdings: Record<string, number> = {};
  const rows = await Promise.all(assets.map(async (asset) => {
    const query = new URLSearchParams({ category: "FlexibleSaving", coin: asset });
    const response = await signedGet<BybitPositionRow>("/v5/earn/position", query, credentials);
    const amount = (response.result?.list ?? [])
      .filter((row) => row.coin === asset)
      .reduce((sum, row) => sum + finiteNumber(row.amount), 0);
    const baseProductId = productIds[asset];
    const productId = account === "eu" ? baseProductId.replace("by-g-", "by-eu-") : baseProductId;
    return [productId, amount] as const;
  }));

  for (const [productId, amount] of rows) holdings[productId] = amount;
  return { holdings };
}

export async function fetchBybitShortFixedSnapshots(credentials: BybitCredentials) {
  const [productResponse, positionResponse] = await Promise.all([
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
  const positions = (positionResponse.result?.list ?? []).filter((row) => (
    Boolean(row.productId)
    && supportedFixedAssets.has(row.coin as Product["asset"])
  ));
  const rates = (productResponse.result?.list ?? []).flatMap((row) => {
    const rate = fixedProductRate(row);
    return rate ? [rate] : [];
  });
  const holdings: Record<string, number> = {};

  for (const rate of rates) {
    holdings[rate.productId] = positions
      .filter((row) => row.productId === rate.externalProductId && row.coin === rate.catalog?.asset)
      .reduce((sum, row) => sum + finiteNumber(row.amount), 0);
  }
  for (const position of positions) {
    if (!position.productId) continue;
    const matched = rates.some((rate) => rate.externalProductId === position.productId && rate.catalog?.asset === position.coin);
    if (!matched) holdings[position.productId] = (holdings[position.productId] ?? 0) + finiteNumber(position.amount);
  }

  return {
    rates,
    holdings,
  };
}

function fixedProductRate(row: BybitFixedProductRow) {
  const asset = row.coin as Product["asset"];
  if (!row.productId || !supportedFixedAssets.has(asset)) return null;
  const tiers = fixedProductTiers(row);
  const subscriptionStart = timestampIso(row.subscribeStartAt);
  const subscriptionEnd = timestampIso(row.subscribeEndAt);
  const termDays = parseDurationDays(row.duration);
  const canonicalProductId = `by-g-${asset.toLowerCase()}-fixed`;
  const identity = buildProductIdentity(canonicalProductId, {
    productType: "fixed",
    termDays: termDays > 0 ? termDays : undefined,
    subscriptionStartsAt: subscriptionStart,
    subscriptionEndsAt: subscriptionEnd,
  }, { externalProductId: row.productId, includeExternalProductId: true });
  const adapterProductId = `${identity.identityKey}:${row.subscribeStartAt || row.subscribeEndAt || "open"}`;
  const eligibilityRequired = Boolean(row.specialUserGroupRequired || row.isVip);
  const eligibilityLabel = row.specialUserGroupInfo || (row.isVip ? "VIP 用户" : undefined);

  return {
    productId: adapterProductId,
    canonicalProductId,
    ...identity,
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
      const body = await response.json() as BybitResponse<Row>;
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
      const body = await response.json() as BybitResponse<Row>;
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
