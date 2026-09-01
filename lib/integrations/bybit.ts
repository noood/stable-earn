import { exchangeFetch } from "@/lib/exchange-fetch";
import { buildProductIdentity } from "@/lib/product-identity";

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

const shortFixedTargets = [
  { coin: "BTC", productId: "by-g-btc-3d" },
  { coin: "USDT", productId: "by-g-usdt-short-fixed" },
] as const;

const minimumShortFixedApr = 4;
const maximumShortFixedDays = 7;

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
  const snapshots = await Promise.all(shortFixedTargets.map((target) => fetchBybitShortFixedSnapshot(target, credentials)));
  return {
    rates: snapshots.flatMap((snapshot) => snapshot.rate ? [snapshot.rate] : []),
    holdings: Object.fromEntries(snapshots.map((snapshot) => [snapshot.productId, snapshot.holding])),
  };
}

async function fetchBybitShortFixedSnapshot(
  target: typeof shortFixedTargets[number],
  credentials: BybitCredentials,
) {
  const productResponse = await publicGet<BybitFixedProductRow>(
    "/v5/earn/fixed-term/product",
    new URLSearchParams({ coin: target.coin }),
    credentials.baseUrls,
  );
  const now = Date.now();
  const products = (productResponse.result?.list ?? [])
    .filter((row) => row.coin === target.coin && row.status === "Available" && !row.isVip)
    .filter((row) => {
      const end = finiteNumber(row.subscribeEndAt);
      const durationDays = parseDurationDays(row.duration);
      return durationDays > 0 && durationDays <= maximumShortFixedDays && (end <= 0 || end > now);
    })
    .map((row) => ({ row, tiers: fixedProductTiers(row) }))
    .filter((item) => item.row.productId && item.tiers.length > 0 && highestApr(item.tiers) >= minimumShortFixedApr)
    .sort((left, right) => Math.max(...right.tiers.map((tier) => tier.apr)) - Math.max(...left.tiers.map((tier) => tier.apr)));

  const selected = products[0];
  if (!selected?.row.productId) {
    return { productId: target.productId, rate: null, holding: 0 };
  }

  const positionResponse = await signedGet<BybitFixedPositionRow>(
    "/v5/earn/fixed-term/position",
    new URLSearchParams({ coin: target.coin, productId: selected.row.productId }),
    credentials,
  );
  const holding = (positionResponse.result?.list ?? [])
    .filter((row) => row.productId === selected.row.productId && row.coin === target.coin)
    .reduce((sum, row) => sum + finiteNumber(row.amount), 0);
  const subscriptionEnd = finiteNumber(selected.row.subscribeEndAt);
  const termDays = parseDurationDays(selected.row.duration);
  const termLabel = formatDuration(selected.row.duration);
  const restriction = selected.row.specialUserGroupRequired && selected.row.specialUserGroupInfo
    ? ` · ${selected.row.specialUserGroupInfo}`
    : "";

  return {
    productId: target.productId,
    rate: {
      productId: target.productId,
      ...buildProductIdentity(target.productId, {
        productType: "fixed",
        termDays,
        eligibilityRequired: selected.row.specialUserGroupRequired ?? false,
        eligibilityLabel: selected.row.specialUserGroupInfo || undefined,
        minimumAmount: finiteNumber(selected.row.minStakeAmount),
        tiers: selected.tiers,
      }, { externalProductId: selected.row.productId, includeExternalProductId: true }),
      name: `Fixed Saving · ${termLabel}${restriction}`,
      apr: selected.tiers[0]?.apr ?? 0,
      tiers: selected.tiers,
      fetchedAt: new Date().toISOString(),
      sourceLabel: "Bybit 官方固定期限产品与账户持仓 API",
      productType: "fixed" as const,
      termDays,
      minimumAmount: finiteNumber(selected.row.minStakeAmount),
      subscriptionEndsAt: subscriptionEnd > 0 ? new Date(subscriptionEnd).toISOString() : undefined,
      eligibilityRequired: selected.row.specialUserGroupRequired ?? false,
      eligibilityLabel: selected.row.specialUserGroupInfo || undefined,
    },
    holding,
  };
}

function highestApr(tiers: Array<{ apr: number }>) {
  return Math.max(...tiers.map((tier) => tier.apr));
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
  return apr > 0 && max > 0 ? [{ min: 0, max, apr }] : [];
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
