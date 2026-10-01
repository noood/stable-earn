import { exchangeFetch, logExchangePayload, readExchangeJson, readExchangeText } from "@/lib/exchange-fetch";
import { buildProductIdentity } from "@/lib/product-identity";
import { syncDiagnostic } from "@/lib/sync-diagnostics";
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

// These are legacy family IDs used as the adapter-side canonical ID. The
// catalog adds the upstream offer ID to the identity, so one family can have
// multiple durable products (for example Bitget's 0–300 and 0–100000 offers).
const baseProductIds = {
  USDT: ["bg-usdt-simple"],
  USDC: ["bg-usdc"],
  USDGO: ["bg-usdgo"],
} as const;

type SupportedAsset = keyof typeof baseProductIds;

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

  // Temporary, sanitized trace for comparing Bitget's product-list IDs with
  // the IDs returned by the assets/holdings endpoint. Keep only controlled
  // product fields; never include credentials or the raw upstream payload.
  syncDiagnostic("bitget_product_rows", {
    fetchedAt,
    rows: productRows
      .filter((row) => ["USDT", "USDC", "USDGO"].includes(row.coin ?? ""))
      .map((row) => ({
        productId: normalizeExternalProductId(row.productId) ?? null,
        coin: row.coin ?? null,
        periodType: row.periodType ?? null,
        status: row.status ?? null,
        productLevel: row.productLevel ?? null,
        apy: normalizeTiers(row.apyList),
      })),
  });

  // Temporary, sanitized trace for reconciling Bitget's upstream product ID
  // with the product that receives the holding in our catalog. Never include
  // credentials, signatures, request headers, or the full upstream payload.
  syncDiagnostic("bitget_assets_rows", {
    fetchedAt,
    rows: assetRows
      .filter((row) => ["USDT", "USDC", "USDGO"].includes(row.productCoin ?? ""))
      .map((row) => ({
        productId: normalizeExternalProductId(row.productId) ?? null,
        productCoin: row.productCoin ?? null,
        periodType: row.periodType ?? null,
        productLevel: row.productLevel ?? null,
        holdAmount: finiteNumber(row.holdAmount),
        apy: normalizeAssetTiers(row.apy),
      })),
  });

  for (const asset of assets) {
    // The product endpoint can contain several offers for one coin (for
    // example 0–300 and 0–100000). The old code selected only the highest APR
    // row and then assigned every position for that coin to it. Merge the two
    // endpoints by upstream productId, preserving held-only rows when an offer
    // has disappeared from the current product list.
    const selectedRows = mergeBitgetRows(asset, productRows, assetRows);
    selectedRows.forEach((item, index) => {
      const targetId = baseProductIds[asset][0];
      const externalProductId = item.externalProductId ?? bitgetFallbackExternalId(item.tiers, item.row.productLevel, index);
      rates.push({
        productId: targetId,
        canonicalProductId: targetId,
        // Keep the family ID as the adapter ID, and put the upstream offer ID
        // in the identity key. The catalog turns distinct identities in the
        // same family into distinct durable rows without collapsing them.
        ...buildProductIdentity(targetId, { productType: "flexible" }, { externalProductId, includeExternalProductId: true }),
        name: bitgetProductName(item.row, index),
        apr: item.tiers[0]?.apr ?? 0,
        tiers: item.tiers,
        fetchedAt,
        sourceLabel: item.hasProductRow ? "Bitget 官方账户产品 API" : "Bitget 官方账户持仓 API",
        catalog: {
          accountId: "bitget-global",
          exchange: "bitget" as const,
          region: "global" as const,
          asset,
          holdingDataMode: "api" as const,
          apiAccess: "authenticated" as const,
        },
      });
    });
  }

  const holdings: Record<string, number> = {};
  const missingHoldingAssets: string[] = [];
  if (assetsResult.status === "fulfilled") {
    for (const asset of assets) {
      const matchingRows = assetRows
        .filter((row) => row.productCoin === asset && row.periodType === "flexible" && row.productLevel !== "VIP");
      const assetRates = rates.filter((rate) => rate.catalog?.asset === asset);
      if (matchingRows.length > 0) {
        matchingRows.forEach((row, index) => {
          const tiers = normalizeAssetTiers(row.apy);
          const externalProductId = normalizeExternalProductId(row.productId)
            ?? bitgetFallbackExternalId(tiers, row.productLevel, index);
          holdings[externalProductId] = (holdings[externalProductId] ?? 0) + finiteNumber(row.holdAmount);
        });
      }
      // An absent position row is not proof of a zero balance. Leave that
      // product out so the dashboard can keep the last successful API cache
      // instead of presenting an API-synced 0. This is per offer, not per
      // coin, so a missing 0–300 row cannot consume the 0–100000 row.
      for (const rate of assetRates) {
        if (!matchingRows.some((row, index) => bitgetRowExternalId(row, index) === rate.externalProductId)) {
          missingHoldingAssets.push(`${asset}:${rate.externalProductId ?? "unknown"}`);
        }
      }
    }
  }

  syncDiagnostic("bitget_holdings_normalized", { holdings });

  // USDGO is still queried for diagnostics, but its current absence is a known
  // manually maintained product and not a failure of the USDT/USDC connector.
  const requiredProductResults = productResults.filter((_, index) => assets[index] !== "USDGO");
  const failedRequiredProduct = requiredProductResults.find((result) => result.status === "rejected");
  const missingRequiredAssets = assets.filter((asset) => asset !== "USDGO" && !rates.some((rate) => rate.catalog?.asset === asset));

  return {
    rates,
    holdings,
    sync: {
      products: requiredProductResults.every((result) => result.status === "fulfilled") && missingRequiredAssets.length === 0,
      holdings: assetsResult.status === "fulfilled" && missingHoldingAssets.length === 0,
      productDiagnostic: failedRequiredProduct ? endpointDiagnostic(failedRequiredProduct.reason) : missingRequiredAssets.length > 0 ? `missing_${missingRequiredAssets.join("_")}` : undefined,
      holdingsDiagnostic: assetsResult.status === "rejected"
        ? endpointDiagnostic(assetsResult.reason)
        : missingHoldingAssets.length > 0 ? `missing_${missingHoldingAssets.join("_")}` : undefined,
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

type BitgetMergedRow = {
  row: BitgetProductRow & Partial<BitgetAssetRow>;
  tiers: Array<{ min: number; max: number | null; apr: number }>;
  externalProductId?: string;
  hasProductRow: boolean;
};

function mergeBitgetRows(asset: SupportedAsset, productRows: BitgetProductRow[], assetRows: BitgetAssetRow[]) {
  const merged = new Map<string, BitgetMergedRow>();
  const productCandidates = productRows
    .filter((row) => row.coin === asset && row.periodType === "flexible" && row.status !== "off_line" && row.productLevel !== "VIP")
    .map((row, index) => ({
      key: bitgetRowKey(row.productId, normalizeTiers(row.apyList), row.productLevel, index),
      row,
      tiers: normalizeTiers(row.apyList),
    }));
  for (const candidate of productCandidates) {
    const current = merged.get(candidate.key);
    merged.set(candidate.key, {
      row: { ...current?.row, ...candidate.row },
      tiers: candidate.tiers.length > 0 ? mergeTiers(current?.tiers ?? [], candidate.tiers) : current?.tiers ?? [],
      externalProductId: normalizeExternalProductId(candidate.row.productId) ?? current?.externalProductId,
      hasProductRow: true,
    });
  }

  assetRows
    .filter((row) => row.productCoin === asset && row.periodType === "flexible" && row.productLevel !== "VIP")
    .forEach((row, index) => {
      const tiers = normalizeAssetTiers(row.apy);
      const key = bitgetRowKey(row.productId, tiers, row.productLevel, index);
      const current = merged.get(key);
      // A held-only row is still a real product. If the product endpoint no
      // longer lists it, retain it rather than manufacturing a second row for
      // the same account position.
      merged.set(key, {
        row: { ...current?.row, ...row },
        // Once the product endpoint has supplied a row, its APY ladder is
        // authoritative. The assets endpoint is only a fallback for a held
        // product that disappeared from the product list.
        tiers: current?.hasProductRow
          ? current.tiers
          : current?.tiers.length ? mergeTiers(current.tiers, tiers) : tiers,
        externalProductId: normalizeExternalProductId(row.productId) ?? current?.externalProductId,
        hasProductRow: current?.hasProductRow ?? false,
      });
    });

  return [...merged.values()]
    .filter((item) => item.tiers.length > 0)
    .sort((left, right) => (left.externalProductId ?? "").localeCompare(right.externalProductId ?? ""));
}

function bitgetRowKey(productId: string | undefined, tiers: Array<{ min: number; max: number | null; apr: number }>, productLevel: string | undefined, index: number) {
  return normalizeExternalProductId(productId)
    ?? `fallback:${productLevel ?? "normal"}:${tiers.map((tier) => `${tier.min}-${tier.max ?? "inf"}`).join(",") || index}`;
}

function bitgetRowExternalId(row: BitgetAssetRow, index: number) {
  return normalizeExternalProductId(row.productId)
    ?? bitgetFallbackExternalId(normalizeAssetTiers(row.apy), row.productLevel, index);
}

function bitgetFallbackExternalId(tiers: Array<{ min: number; max: number | null; apr: number }>, productLevel: string | undefined, index: number) {
  return `fallback:${productLevel ?? "normal"}:${tiers.map((tier) => `${tier.min}-${tier.max ?? "inf"}`).join(",") || index}`;
}

function normalizeExternalProductId(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function mergeTiers(
  left: Array<{ min: number; max: number | null; apr: number }>,
  right: Array<{ min: number; max: number | null; apr: number }>,
) {
  // Adjacent ranges can form one ladder. Overlapping ranges cannot: they are
  // alternative offers, and combining them would make allocation count the
  // same holding twice. Keep the richer representation in that case.
  if (left.some((a) => right.some((b) => tierRangesOverlap(a, b)))) {
    return right.length >= left.length ? right : left;
  }
  const merged = new Map(left.map((tier) => [`${tier.min}:${tier.max ?? "inf"}`, tier]));
  for (const tier of right) merged.set(`${tier.min}:${tier.max ?? "inf"}`, tier);
  return [...merged.values()].sort((a, b) => a.min - b.min || (a.max ?? Number.POSITIVE_INFINITY) - (b.max ?? Number.POSITIVE_INFINITY));
}

function tierRangesOverlap(
  left: { min: number; max: number | null },
  right: { min: number; max: number | null },
) {
  const leftMax = left.max ?? Number.POSITIVE_INFINITY;
  const rightMax = right.max ?? Number.POSITIVE_INFINITY;
  return left.min < rightMax && right.min < leftMax;
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
    const rawBody = await readExchangeText(response);
    let body: BitgetResponse<Data> = {};
    try {
      body = JSON.parse(rawBody) as BitgetResponse<Data>;
    } catch {
      // Some upstream access denials return HTML instead of Bitget's JSON
      // envelope. Classify it without exposing the response body.
    }
    logExchangePayload(response, body.code ? body : null, rawBody);
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
    const body = await readExchangeJson<BitgetResponse<{ serverTime?: string }>>(response);
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
