import { exchangeFetch } from "@/lib/exchange-fetch";
import { buildProductIdentity } from "@/lib/product-identity";
import type { LiveRate } from "@/lib/live-rates";

type BitgetCredentials = {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  baseUrl?: string;
};

type BitgetApyRow = {
  minStepVal?: string;
  maxStepVal?: string;
  currentApy?: string;
};

type BitgetProductRow = {
  productId?: string;
  coin?: string;
  periodType?: string;
  apyType?: string;
  apyList?: BitgetApyRow[];
  status?: string;
  productLevel?: string;
};

type BitgetAssetRow = {
  productId?: string;
  productCoin?: string;
  periodType?: string;
  holdAmount?: string;
  productLevel?: string;
  apy?: Array<{
    minApy?: string;
    maxApy?: string;
    currentApy?: string;
  }>;
};

type BitgetResponse<Data> = {
  code?: string;
  msg?: string;
  data?: Data;
};

export type BitgetSavingsSnapshot = {
  rates: LiveRate[];
  holdings: Record<string, number>;
  sync: {
    products: boolean;
    holdings: boolean;
    productDiagnostic?: string;
    holdingsDiagnostic?: string;
  };
};

const slots = {
  USDT: ["bg-usdt-simple"],
  USDC: ["bg-usdc"],
  USDGO: ["bg-usdgo"],
} as const;

type SupportedAsset = keyof typeof slots;

export async function fetchBitgetSavingsSnapshot(
  credentials: BitgetCredentials,
  assets: readonly SupportedAsset[] = ["USDT", "USDC", "USDGO"],
): Promise<BitgetSavingsSnapshot> {
  // Bitget documents `coin` as required for the product-list endpoint. Fetch
  // each monitored coin separately so an empty or unavailable coin cannot
  // prevent the other products from updating.
  const [productResults, assetResults] = await Promise.all([
    Promise.allSettled(assets.map((asset) => signedGet<BitgetProductRow[]>(
      "/api/v2/earn/savings/product",
      new URLSearchParams({ coin: asset, filter: "available_and_held" }),
      credentials,
    ))),
    Promise.allSettled([signedGet<{ resultList?: BitgetAssetRow[] }>(
      "/api/v2/earn/savings/assets",
      new URLSearchParams({ periodType: "flexible", limit: "100" }),
      credentials,
    )]),
  ]);
  const assetsResult = assetResults[0];
  const failedProduct = productResults.find((result) => result.status === "rejected");
  if (productResults.every((result) => result.status === "rejected") && assetsResult.status === "rejected") {
    const publicApiReachable = await canReachBitgetPublicApi(credentials.baseUrl);
    throw new Error(`Bitget read-only API failed (${endpointDiagnostic(failedProduct?.reason)};public_${publicApiReachable ? "ok" : "blocked"})`);
  }

  const fetchedAt = new Date().toISOString();
  const rates: BitgetSavingsSnapshot["rates"] = [];
  const productRows = productResults.flatMap((result) => result.status === "fulfilled" ? result.value.data ?? [] : []);
  const assetRows = assetsResult.status === "fulfilled" ? assetsResult.value.data?.resultList ?? [] : [];

  for (const asset of assets) {
    const availableRows = productRows
      .filter((row) => row.coin === asset && row.periodType === "flexible" && row.status !== "off_line")
      .map((row) => ({ row, tiers: normalizeTiers(row.apyList) }))
      .filter((item) => item.row.productId && item.tiers.length > 0)
      .sort((left, right) => (right.tiers[0]?.apr ?? 0) - (left.tiers[0]?.apr ?? 0));

    const heldFallback = assetRows
      .filter((row) => row.productCoin === asset && row.periodType === "flexible" && row.productLevel !== "VIP")
      .map((row) => ({ row, tiers: normalizeAssetTiers(row.apy) }))
      .filter((item) => item.tiers.length > 0)
      .sort((left, right) => finiteNumber(right.row.holdAmount) - finiteNumber(left.row.holdAmount));
    const selectedRows = availableRows.length > 0 ? availableRows : heldFallback;

    selectedRows.slice(0, slots[asset].length).forEach((item, index) => {
      const targetId = slots[asset][index];
      rates.push({
        productId: targetId,
        ...buildProductIdentity(targetId, { productType: "flexible", tiers: item.tiers }, { externalProductId: item.row.productId }),
        name: bitgetProductName(item.row, index),
        apr: item.tiers[0]?.apr ?? 0,
        tiers: item.tiers,
        fetchedAt,
        sourceLabel: availableRows.length > 0 ? "Bitget 官方账户产品 API" : "Bitget 官方账户持仓 API",
      });
    });
  }

  const holdings: Record<string, number> = {};
  if (assetsResult.status === "fulfilled") {
    for (const asset of assets) {
      const targetId = slots[asset][0];
      const matchingRows = assetRows
        .filter((row) => row.productCoin === asset && row.periodType === "flexible" && row.productLevel !== "VIP");
      // An absent position row is not proof of a zero balance. Leave that
      // product out so the dashboard can keep the last successful API cache
      // instead of presenting an API-synced 0.
      if (matchingRows.length > 0) {
        holdings[targetId] = matchingRows.reduce((sum, row) => sum + finiteNumber(row.holdAmount), 0);
      }
    }
  }

  // USDGO is still queried for diagnostics, but its current absence is a known
  // manually maintained product and not a failure of the USDT/USDC connector.
  const requiredProductResults = productResults.filter((_, index) => assets[index] !== "USDGO");
  const failedRequiredProduct = requiredProductResults.find((result) => result.status === "rejected");
  const missingRequiredAssets = assets.filter((asset) => asset !== "USDGO" && !rates.some((rate) => rate.productId === slots[asset][0]));

  return {
    rates,
    holdings,
    sync: {
      products: requiredProductResults.every((result) => result.status === "fulfilled") && missingRequiredAssets.length === 0,
      holdings: assetsResult.status === "fulfilled",
      productDiagnostic: failedRequiredProduct ? endpointDiagnostic(failedRequiredProduct.reason) : missingRequiredAssets.length > 0 ? `missing_${missingRequiredAssets.join("_")}` : undefined,
      holdingsDiagnostic: assetsResult.status === "rejected" ? endpointDiagnostic(assetsResult.reason) : undefined,
    },
  };
}

function normalizeTiers(rows: BitgetApyRow[] | undefined) {
  const tiers = (rows ?? []).flatMap((row) => {
    const min = finiteNumber(row.minStepVal);
    const maxValue = finiteNumber(row.maxStepVal);
    const apr = Number.parseFloat(row.currentApy ?? "");
    const max = maxValue > min ? maxValue : null;
    return Number.isFinite(apr) ? [{ min, max, apr }] : [];
  }).sort((left, right) => left.min - right.min);
  return tiers;
}

function normalizeAssetTiers(rows: BitgetAssetRow["apy"]) {
  return normalizeTiers(rows?.map((row) => ({
    minStepVal: row.minApy,
    maxStepVal: row.maxApy,
    currentApy: row.currentApy,
  })));
}

function bitgetProductName(row: { productLevel?: string }, index: number) {
  const level = row.productLevel && row.productLevel !== "normal" ? ` · ${row.productLevel}` : "";
  return `Savings Flexible${level}${index > 0 ? ` · 产品 ${index + 1}` : ""}`;
}

async function signedGet<Data>(path: string, query: URLSearchParams, credentials: BitgetCredentials) {
  const timestamp = String(Date.now());
  const queryString = query.toString();
  const requestPath = queryString ? `${path}?${queryString}` : path;
  const signature = await hmacBase64(`${timestamp}GET${requestPath}`, credentials.apiSecret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await exchangeFetch(`${credentials.baseUrl ?? "https://api.bitget.com"}${requestPath}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Stable-Earn-Monitor/1.0",
        "ACCESS-KEY": credentials.apiKey,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": credentials.passphrase,
        locale: "en-US",
      },
    });
    const rawBody = await response.text();
    let body: BitgetResponse<Data> = {};
    try {
      body = JSON.parse(rawBody) as BitgetResponse<Data>;
    } catch {
      // Some upstream access denials return HTML instead of Bitget's JSON
      // envelope. Classify it without exposing the response body.
    }
    if (!response.ok || body.code !== "00000") {
      const responseKind = body.code ?? (rawBody.trimStart().startsWith("<") ? "html" : "non_bitget_json");
      throw new Error(`Bitget read-only API failed (${response.status}/${responseKind})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function endpointDiagnostic(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  const message = error instanceof Error ? error.message : "";
  const responseCode = message.match(/\(([a-z0-9_\/;-]+)\)/i)?.[0];
  return responseCode ? responseCode.slice(1, -1) : "unknown";
}

async function canReachBitgetPublicApi(baseUrl = "https://api.bitget.com") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await exchangeFetch(`${baseUrl}/api/v2/public/time`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    const body = await response.json() as BitgetResponse<{ serverTime?: string }>;
    return body.code === "00000";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function hmacBase64(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64(new Uint8Array(signature));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function finiteNumber(value: string | number | undefined) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}
