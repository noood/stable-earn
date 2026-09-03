import { exchangeFetch } from "@/lib/exchange-fetch";
import { buildProductIdentity } from "@/lib/product-identity";
import type { LiveRate } from "@/lib/live-rates";

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
    const body = await response.json().catch(() => null) as (ResponseBody & { code?: number }) | null;
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
