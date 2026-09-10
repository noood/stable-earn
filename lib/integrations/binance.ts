import { exchangeFetch, readExchangeJson } from "@/lib/exchange-fetch";
import { buildProductIdentity } from "@/lib/product-identity";
import type { LiveRate } from "@/lib/live-rates";
import type { Product } from "@/lib/domain";

type Credentials = {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
};

type FlexibleProductRow = {
  asset?: string;
  latestAnnualPercentageRate?: string;
  tierAnnualPercentageRate?: Record<string, number | string>;
  productId?: string;
};

type FlexiblePositionRow = FlexibleProductRow & {
  totalAmount?: string;
};

type LockedProductDetail = {
  asset?: string;
  apr?: string | number;
  apy?: string | number;
  annualPercentageRate?: string | number;
  interestRate?: string | number;
  duration?: string | number;
  status?: string;
  isSoldOut?: boolean;
  subscriptionStartTime?: string | number;
};

type LockedProductRow = {
  projectId?: string;
  detail?: LockedProductDetail;
  quota?: {
    minimum?: string | number;
    totalPersonalQuota?: string | number;
  };
};

type LockedPositionRow = {
  positionId?: string | number;
  projectId?: string;
  asset?: string;
  amount?: string | number;
  principal?: string | number;
  apy?: string | number;
  apr?: string | number;
  annualPercentageRate?: string | number;
  interestRate?: string | number;
  duration?: string | number;
  purchaseTime?: string | number;
  redeemDate?: string | number;
  status?: string;
};

type PageResponse<Row> = {
  rows?: Row[];
  total?: number | string;
};

type BinanceTier = {
  min: number;
  max: number | null;
  apr: number;
};

export type BinanceFlexibleSnapshot = {
  rates: LiveRate[];
  holdings: Record<string, number>;
};

export type BinanceLockedSnapshot = BinanceFlexibleSnapshot;

const accounts = {
  global: {
    productIds: { USDT: "bn-g-usdt", USDC: "bn-g-usdc" },
    sourceLabel: "Binance.com 官方账户 API",
  },
  bahrain: {
    productIds: { USDT: "bn-bh-usdt", USDC: "bn-bh-usdc" },
    sourceLabel: "Binance Bahrain 官方账户 API",
  },
} as const;

type BinanceAccount = keyof typeof accounts;
type SupportedAsset = keyof typeof accounts.global.productIds;

export async function fetchBinanceFlexibleSnapshot(
  credentials: Credentials,
  account: BinanceAccount = "global",
  assets: readonly SupportedAsset[] = ["USDT", "USDC"],
): Promise<BinanceFlexibleSnapshot> {
  const accountConfig = accounts[account];
  const fetchedAt = new Date().toISOString();
  const results = await Promise.all(assets.map(async (asset) => {
    const [products, positions] = await Promise.all([
      signedGet<PageResponse<FlexibleProductRow>>(
        "/sapi/v1/simple-earn/flexible/list",
        { asset, current: 1, size: 100 },
        credentials,
      ),
      signedGet<PageResponse<FlexiblePositionRow>>(
        "/sapi/v1/simple-earn/flexible/position",
        { asset, current: 1, size: 100 },
        credentials,
      ),
    ]);

    const product = products.rows?.find((row) => row.asset === asset) ?? products.rows?.[0];
    const positionRows = positions.rows?.filter((row) => row.asset === asset) ?? [];
    const position = positionRows[0];
    const rateSource = product ?? position;
    if (!rateSource) throw new Error(`Binance returned no ${asset} flexible product`);
    if (!Number.isFinite(Number.parseFloat(rateSource.latestAnnualPercentageRate ?? ""))) {
      throw new Error(`Binance returned no ${asset} APR`);
    }

    const tiers = parseBinanceTiers(
      asset,
      rateSource.latestAnnualPercentageRate,
      rateSource.tierAnnualPercentageRate,
    );
    const holding = positionRows.reduce((sum, row) => sum + finiteNumber(row.totalAmount), 0);

    return {
      rate: {
        productId: accountConfig.productIds[asset],
        ...buildProductIdentity(accountConfig.productIds[asset], { productType: "flexible", tiers }, { externalProductId: rateSource.productId, includeExternalProductId: true }),
        apr: tiers[0]?.apr ?? 0,
        tiers,
        fetchedAt,
        sourceLabel: accountConfig.sourceLabel,
        catalog: {
          accountId: account === "global" ? "binance-global" : "binance-bahrain",
          exchange: "binance" as const,
          region: account,
          asset,
          holdingDataMode: "api" as const,
          apiAccess: "authenticated" as const,
        },
      },
      productId: accountConfig.productIds[asset],
      holding,
    };
  }));

  return {
    rates: results.map((result) => result.rate),
    holdings: Object.fromEntries(results.map((result) => [result.productId, result.holding])),
  };
}

/**
 * Fetches Binance Simple Earn Locked products and the user's locked positions.
 * The list endpoint describes currently available products; positions are
 * also converted to rates so an existing subscription remains visible after
 * its product is no longer offered for new subscriptions.
 */
export async function fetchBinanceLockedSnapshot(
  credentials: Credentials,
  account: BinanceAccount = "global",
  assets: readonly string[] = ["USDT", "USDC", "USDGO", "BTC"],
): Promise<BinanceLockedSnapshot> {
  const accountConfig = accounts[account];
  const supported = new Set(assets.map((asset) => asset.toUpperCase()));
  const [products, positions] = await Promise.all([
    signedGet<PageResponse<LockedProductRow>>(
      "/sapi/v1/simple-earn/locked/list",
      { current: 1, size: 100 },
      credentials,
    ),
    signedGet<PageResponse<LockedPositionRow>>(
      "/sapi/v1/simple-earn/locked/position",
      { current: 1, size: 100 },
      credentials,
    ),
  ]);

  const productRows = products.rows ?? [];
  const positionRows = positions.rows ?? [];
  const fetchedAt = new Date().toISOString();
  const rates: LiveRate[] = [];
  const rateByProject = new Map<string, LiveRate>();

  for (const row of productRows) {
    const projectId = String(row.projectId ?? "").trim();
    const detail = row.detail;
    const asset = String(detail?.asset ?? "").toUpperCase();
    const duration = positiveNumber(detail?.duration);
    const apr = parseBinanceApr(detail?.apr ?? detail?.apy ?? detail?.annualPercentageRate ?? detail?.interestRate);
    if (!projectId || !supported.has(asset) || !duration || !Number.isFinite(apr)) continue;
    const rate = lockedRate(accountConfig, account, asset, projectId, duration, apr, detail, row.quota, fetchedAt);
    rates.push(rate);
    rateByProject.set(`${asset}:${projectId}`, rate);
  }

  // A held project may disappear from the available-product list. Prefer the
  // position's own APR/term in that case, when Binance supplies them.
  for (const row of positionRows) {
    const projectId = String(row.projectId ?? "").trim();
    const asset = String(row.asset ?? "").toUpperCase();
    const duration = positiveNumber(row.duration);
    const apr = parseBinanceApr(row.apr ?? row.apy ?? row.annualPercentageRate ?? row.interestRate);
    if (!projectId || !supported.has(asset) || rateByProject.has(`${asset}:${projectId}`) || !duration || !Number.isFinite(apr)) continue;
    const rate = lockedRate(accountConfig, account, asset, projectId, duration, apr, undefined, undefined, fetchedAt);
    rates.push(rate);
    rateByProject.set(`${asset}:${projectId}`, rate);
  }

  const holdings: Record<string, number> = {};
  for (const rate of rates) {
    const projectId = rate.externalProductId;
    const asset = rate.catalog?.asset;
    if (!projectId || !asset) continue;
    const amount = positionRows
      .filter((row) => String(row.projectId ?? "") === projectId && String(row.asset ?? "").toUpperCase() === asset)
      .reduce((sum, row) => sum + finiteNumber(row.amount ?? row.principal), 0);
    holdings[rate.productId] = amount;
    holdings[projectId] = amount;
  }

  // Preserve a position key even if its APR is currently unavailable. The
  // catalogue can match it to an existing row, while new products remain
  // blocked until a comparable APR is returned.
  for (const row of positionRows) {
    const projectId = String(row.projectId ?? "").trim();
    const asset = String(row.asset ?? "").toUpperCase();
    if (!projectId || !supported.has(asset)) continue;
    const key = `${asset}:${projectId}`;
    if (rateByProject.has(key)) continue;
    holdings[projectId] = (holdings[projectId] ?? 0) + finiteNumber(row.amount ?? row.principal);
  }

  return { rates, holdings };
}

function lockedRate(
  accountConfig: typeof accounts[BinanceAccount],
  account: BinanceAccount,
  asset: string,
  projectId: string,
  duration: number,
  apr: number,
  detail: LockedProductDetail | undefined,
  quota: LockedProductRow["quota"],
  fetchedAt: string,
): LiveRate {
  const canonical = `${account === "global" ? "bn-g" : "bn-bh"}-${asset.toLowerCase()}-locked`;
  const identity = buildProductIdentity(canonical, { productType: "fixed", termDays: duration, subscriptionStartsAt: timestampIso(detail?.subscriptionStartTime) }, { externalProductId: projectId, includeExternalProductId: true });
  const maximum = finiteOptional(quota?.totalPersonalQuota);
  const minimum = finiteOptional(quota?.minimum);
  return {
    productId: identity.identityKey,
    canonicalProductId: canonical,
    ...identity,
    name: `Simple Earn Locked · ${formatLockedDuration(duration)}`,
    apr,
    tiers: [{ min: 0, max: maximum && maximum > 0 ? maximum : null, apr }],
    fetchedAt,
    sourceLabel: accountConfig.sourceLabel.replace("账户 API", "定期账户 API"),
    productType: "fixed",
    termDays: duration,
    minimumAmount: minimum && minimum > 0 ? minimum : undefined,
    subscriptionStartsAt: timestampIso(detail?.subscriptionStartTime),
    availability: detail?.isSoldOut || /sold.?out|unavailable|off.?line/i.test(detail?.status ?? "") ? "unavailable" : "available",
    rateCoverage: "complete",
    catalog: {
      accountId: account === "global" ? "binance-global" : "binance-bahrain",
      exchange: "binance",
      region: account === "global" ? "global" : "bahrain",
      asset: asset as Product["asset"],
      holdingDataMode: "api",
      apiAccess: "authenticated",
    },
  };
}

function parseBinanceTiers(
  asset: string,
  rawBaseApr: string | undefined,
  rawBonusTiers: Record<string, number | string> | undefined,
): BinanceTier[] {
  const baseApr = finiteNumber(rawBaseApr) * 100;
  const bonusTiers = Object.entries(rawBonusTiers ?? {}).flatMap(([label, rawApr]) => {
    const bounds = parseTierBounds(label, asset);
    const bonusApr = finiteNumber(rawApr) * 100;
    return bounds && Number.isFinite(bonusApr)
      ? [{ ...bounds, apr: baseApr + bonusApr }]
      : [];
  }).sort((left, right) => left.min - right.min);

  if (bonusTiers.length === 0) return [{ min: 0, max: null, apr: baseApr }];

  const tiers: BinanceTier[] = [];
  let cursor = 0;
  for (const tier of bonusTiers) {
    if (tier.min > cursor) tiers.push({ min: cursor, max: tier.min, apr: baseApr });
    tiers.push(tier);
    cursor = Math.max(cursor, tier.max ?? cursor);
  }
  tiers.push({ min: cursor, max: null, apr: baseApr });
  return tiers;
}

function parseTierBounds(label: string, asset: string) {
  const normalized = label
    .toUpperCase()
    .replaceAll(asset.toUpperCase(), "")
    .replaceAll(",", "")
    .replaceAll(" ", "")
    .replaceAll("–", "-")
    .replaceAll("—", "-");
  const match = normalized.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2]);
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null;
}

async function signedGet<ResponseBody>(
  path: string,
  params: Record<string, string | number>,
  credentials: Credentials,
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, String(value));
  search.set("recvWindow", "5000");
  search.set("timestamp", String(Date.now()));

  const signature = await hmacHex(search.toString(), credentials.apiSecret);
  search.set("signature", signature);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await exchangeFetch(
      `${credentials.baseUrl ?? "https://api-gcp.binance.com"}${path}?${search.toString()}`,
      {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-MBX-APIKEY": credentials.apiKey,
        },
      },
    );
    const body = await readExchangeJson<ResponseBody & { code?: number }>(response).catch(() => null);
    if (!response.ok || (typeof body?.code === "number" && body.code < 0)) {
      throw new Error(`Binance read-only API failed (${response.status}/${body?.code ?? "unknown"})`);
    }
    if (!body) throw new Error(`Binance read-only API failed (${response.status}/invalid_json)`);
    return body;
  } finally {
    clearTimeout(timer);
  }
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

function finiteOptional(value: string | number | undefined) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumber(value: string | number | undefined) {
  const parsed = finiteOptional(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function parseBinanceApr(value: string | number | undefined) {
  const parsed = finiteOptional(value);
  if (parsed === undefined || parsed < 0) return Number.NaN;
  // Binance normally returns a decimal fraction (for example 0.0673), but
  // tolerate percentage-form responses as well.
  return parsed <= 1 ? parsed * 100 : parsed;
}

function timestampIso(value: string | number | undefined) {
  const timestamp = finiteOptional(value);
  return timestamp !== undefined && timestamp > 0 ? new Date(timestamp).toISOString() : undefined;
}

function formatLockedDuration(duration: number) {
  return Number.isInteger(duration) ? `${duration} 天` : `${duration.toFixed(2).replace(/\.0+$|(?<=\.[0-9])0+$/, "")} 天`;
}
