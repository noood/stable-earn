import { exchangeFetch, logExchangePayload, readExchangeJson, readExchangeText } from "@/lib/exchange-fetch";
import { buildPlatformProductIdentity } from "@/lib/product-identity";
import { syncDiagnostic } from "@/lib/sync-diagnostics";
import { apiAssetsFor } from "@/lib/platform-capabilities";
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
  period?: string;
  apyType?: string;
  apyList?: BitgetApyRow[];
  status?: string;
  productLevel?: string;
};

type BitgetAssetRow = {
  productId?: string;
  productCoin?: string;
  periodType?: string;
  period?: string;
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

type BitgetAssetPage = {
  resultList?: BitgetAssetRow[];
  endId?: string;
};

type BitgetAssetPageDiagnostic = {
  page: number;
  requestedLimit: number;
  rowCount: number;
  responseKeys: string[];
  endId: string | null;
};

type BitgetAssetCollection = {
  rows: BitgetAssetRow[];
  complete: boolean;
  pageCount: number;
  pages: BitgetAssetPageDiagnostic[];
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

const bitgetAssetPageSize = 100;
const maxBitgetAssetPages = 50;

type SupportedAsset = "USDT" | "USDC" | "USDGO" | "BTC";

export type BitgetCapabilityProbe = {
  asset: SupportedAsset;
  productApi: {
    status: "returned" | "empty" | "error";
    rowCount: number;
    eligibleFlexibleCount: number;
    rows: Array<{
      productId: string | null;
      periodType: string | null;
      period: string | null;
      status: string | null;
      productLevel: string | null;
      eligibleForMonitoring?: boolean;
      tiers: Array<{ min: number; max: number | null; apr: number }>;
    }>;
    diagnostic?: string;
  };
  holdingsApi: BitgetCapabilityHoldingProbe;
  fixedHoldingsApi: BitgetCapabilityHoldingProbe;
};

type BitgetCapabilityHoldingProbe = {
  status: "complete" | "incomplete" | "error";
  complete: boolean;
  pageCount: number;
  rowCount: number;
  rows: Array<{
    productId: string | null;
    periodType: string | null;
    period: string | null;
    productLevel: string | null;
    hasPositiveHolding: boolean;
    tiers: Array<{ min: number; max: number | null; apr: number }>;
  }>;
  diagnostic?: string;
};

/**
 * One-off, read-only capability check. It does not write the catalog, holdings,
 * cache, or history; the caller decides whether this asset belongs in routine sync.
 */
export async function probeBitgetAsset(
  credentials: BitgetCredentials,
  asset: SupportedAsset,
): Promise<BitgetCapabilityProbe> {
  const [productResult, flexibleAssetsResult, fixedAssetsResult] = await Promise.allSettled([
    fetchBitgetCapabilityProducts(credentials, asset),
    fetchBitgetAssetPages(credentials, "flexible"),
    fetchBitgetAssetPages(credentials, "fixed"),
  ]);

  return buildBitgetCapabilityProbe(asset, productResult, flexibleAssetsResult, fixedAssetsResult);
}

/** Query each coin's products while fetching shared flexible and fixed holdings once. */
export async function probeBitgetAssets(
  credentials: BitgetCredentials,
  assets: readonly SupportedAsset[],
): Promise<BitgetCapabilityProbe[]> {
  const [productResults, flexibleAssetsResult, fixedAssetsResult] = await Promise.all([
    Promise.allSettled(assets.map((asset) => fetchBitgetCapabilityProducts(credentials, asset))),
    Promise.allSettled([fetchBitgetAssetPages(credentials, "flexible")]).then(([result]) => result),
    Promise.allSettled([fetchBitgetAssetPages(credentials, "fixed")]).then(([result]) => result),
  ]);
  return assets.map((asset, index) => buildBitgetCapabilityProbe(
    asset,
    productResults[index],
    flexibleAssetsResult,
    fixedAssetsResult,
  ));
}

function fetchBitgetCapabilityProducts(credentials: BitgetCredentials, asset: SupportedAsset) {
  return signedGet<BitgetProductRow[]>(
    "/api/v2/earn/savings/product",
    new URLSearchParams({ coin: asset, filter: "available_and_held" }),
    credentials,
  );
}

function buildBitgetCapabilityProbe(
  asset: SupportedAsset,
  productResult: PromiseSettledResult<BitgetResponse<BitgetProductRow[]>>,
  flexibleAssetsResult: PromiseSettledResult<BitgetAssetCollection>,
  fixedAssetsResult: PromiseSettledResult<BitgetAssetCollection>,
): BitgetCapabilityProbe {
  const productApi: BitgetCapabilityProbe["productApi"] = productResult.status === "rejected"
    ? { status: "error", rowCount: 0, eligibleFlexibleCount: 0, rows: [], diagnostic: endpointDiagnostic(productResult.reason) }
    : (() => {
      const rows = (productResult.value.data ?? []).filter((row) => row.coin === asset);
      const normalizedRows = rows.map((row) => {
        const eligibleForMonitoring = row.periodType === "flexible"
          ? row.status !== "off_line" && !isBitgetVipLevel(row.productLevel)
          : undefined;
        return {
          productId: normalizeExternalProductId(row.productId) ?? null,
          periodType: row.periodType ?? null,
          period: row.period ?? null,
          status: row.status ?? null,
          productLevel: row.productLevel ?? null,
          ...(eligibleForMonitoring !== undefined ? { eligibleForMonitoring } : {}),
          tiers: normalizeTiers(row.apyList),
        };
      });
      const eligibleFlexibleCount = normalizedRows.filter((row) => row.eligibleForMonitoring === true && row.tiers.length > 0).length;
      return {
        status: rows.length > 0 ? "returned" : "empty",
        rowCount: rows.length,
        eligibleFlexibleCount,
        rows: normalizedRows,
      };
    })();

  const buildHoldings = (
    result: PromiseSettledResult<BitgetAssetCollection>,
    periodType: "flexible" | "fixed",
  ): BitgetCapabilityHoldingProbe => result.status === "rejected"
    ? { status: "error", complete: false, pageCount: 0, rowCount: 0, rows: [], diagnostic: endpointDiagnostic(result.reason) }
    : (() => {
      const collection = result.value;
      const rows = collection.rows
        .filter((row) => row.productCoin === asset && row.periodType === periodType)
        .map((row) => ({
          productId: normalizeExternalProductId(row.productId) ?? null,
          periodType: row.periodType ?? null,
          period: row.period ?? null,
          productLevel: row.productLevel ?? null,
          hasPositiveHolding: finiteNumber(row.holdAmount) > 0,
          tiers: normalizeAssetTiers(row.apy),
        }));
      return {
        status: collection.complete ? "complete" : "incomplete",
        complete: collection.complete,
        pageCount: collection.pageCount,
        rowCount: rows.length,
        rows,
        ...(!collection.complete ? { diagnostic: "pagination_incomplete" } : {}),
      };
    })();

  return {
    asset,
    productApi,
    holdingsApi: buildHoldings(flexibleAssetsResult, "flexible"),
    fixedHoldingsApi: buildHoldings(fixedAssetsResult, "fixed"),
  };
}

export async function fetchBitgetSavingsSnapshot(
  credentials: BitgetCredentials,
  assets: readonly SupportedAsset[] = apiAssetsFor("bitget-global", "flexible", "productApi") as SupportedAsset[],
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
    Promise.allSettled([fetchBitgetAssetPages(credentials)]),
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
  const assetCollection = assetsResult.status === "fulfilled" ? assetsResult.value : null;
  const assetRows = assetCollection?.rows ?? [];

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
    requestedLimit: bitgetAssetPageSize,
    pageCount: assetCollection?.pageCount ?? 0,
    rowCount: assetRows.length,
    complete: assetCollection?.complete ?? false,
    pages: assetCollection?.pages ?? [],
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
      const externalProductId = item.externalProductId ?? bitgetFallbackExternalId(item.tiers, item.row.productLevel, index);
      const identity = buildPlatformProductIdentity({
        accountId: "bitget-global",
        asset,
        productType: "flexible",
        externalProductId,
      });
      rates.push({
        productId: identity.identityKey,
        ...identity,
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
        ...(isBitgetVipLevel(item.row.productLevel) ? {
          eligibilityRequired: true,
          eligibilityLabel: "Bitget VIP 专属产品，账号资格需确认",
          eligibilityStatus: "unknown" as const,
        } : {}),
        rateCoverage: item.tiers.length > 0 ? "complete" : "unavailable",
      });
    });
  }

  const holdings: Record<string, number> = {};
  const missingHoldingAssets: string[] = [];
  if (assetsResult.status === "fulfilled") {
    for (const asset of assets) {
      const matchingRows = assetRows
        .filter((row) => row.productCoin === asset && row.periodType === "flexible");
      const assetRates = rates.filter((rate) => rate.catalog?.asset === asset);
      if (matchingRows.length > 0) {
        matchingRows.forEach((row, index) => {
          const tiers = normalizeAssetTiers(row.apy);
          const externalProductId = normalizeExternalProductId(row.productId)
            ?? bitgetFallbackExternalId(tiers, row.productLevel, index);
          const identity = buildPlatformProductIdentity({
            accountId: "bitget-global",
            asset,
            productType: "flexible",
            externalProductId,
          });
          holdings[identity.identityKey] = (holdings[identity.identityKey] ?? 0) + finiteNumber(row.holdAmount);
        });
      }
      // Bitget's assets endpoint is a paged list of current holdings, not a
      // copy of the product list. Once every page has been read, an offer
      // absent from this list is an authoritative zero. Before pagination is
      // complete, keep it unknown so a truncated response cannot erase a
      // previously known holding.
      if (assetCollection?.complete) {
        for (const rate of assetRates) {
          if (!matchingRows.some((row, index) => bitgetRowExternalId(row, index) === rate.externalProductId)) {
            holdings[rate.identityKey ?? rate.productId] = 0;
          }
        }
      } else {
        for (const rate of assetRates) {
          if (!matchingRows.some((row, index) => bitgetRowExternalId(row, index) === rate.externalProductId)) {
            missingHoldingAssets.push(`${asset}:${rate.externalProductId ?? "unknown"}`);
          }
        }
      }
    }
  }

  syncDiagnostic("bitget_holdings_normalized", { holdings });

  const failedRequiredProduct = productResults.find((result) => result.status === "rejected");
  const missingRequiredAssets = assets.filter((asset) => !rates.some((rate) => rate.catalog?.asset === asset));

  return {
    rates,
    holdings,
    sync: {
      products: productResults.every((result) => result.status === "fulfilled") && missingRequiredAssets.length === 0,
      holdings: assetsResult.status === "fulfilled" && assetCollection?.complete === true && missingHoldingAssets.length === 0,
      productDiagnostic: failedRequiredProduct ? endpointDiagnostic(failedRequiredProduct.reason) : missingRequiredAssets.length > 0 ? `missing_${missingRequiredAssets.join("_")}` : undefined,
      holdingsDiagnostic: assetsResult.status === "rejected"
        ? endpointDiagnostic(assetsResult.reason)
        : !assetCollection?.complete ? "pagination_incomplete" : missingHoldingAssets.length > 0 ? `missing_${missingHoldingAssets.join("_")}` : undefined,
    },
  };
}

async function fetchBitgetAssetPages(
  credentials: BitgetCredentials,
  periodType: "flexible" | "fixed" = "flexible",
): Promise<BitgetAssetCollection> {
  const rows: BitgetAssetRow[] = [];
  const pages: BitgetAssetPageDiagnostic[] = [];
  const seenEndIds = new Set<string>();
  let endId: string | undefined;
  let complete = false;

  for (let page = 1; page <= maxBitgetAssetPages; page += 1) {
    const query = new URLSearchParams({ periodType, limit: String(bitgetAssetPageSize) });
    if (endId) query.set("idLessThan", endId);
    const response = await signedGet<BitgetAssetPage>(
      "/api/v2/earn/savings/assets",
      query,
      credentials,
    );
    const data = response.data ?? {};
    const pageRows = Array.isArray(data.resultList) ? data.resultList : [];
    const nextEndId = normalizeExternalProductId(data.endId);
    rows.push(...pageRows);
    pages.push({
      page,
      requestedLimit: bitgetAssetPageSize,
      rowCount: pageRows.length,
      responseKeys: Object.keys(data).sort(),
      endId: nextEndId ?? null,
    });

    // No endId means Bitget has no next page. A short page is also terminal;
    // this protects us from an upstream response that repeats a terminal
    // cursor instead of omitting it.
    if (!nextEndId || pageRows.length < bitgetAssetPageSize) {
      complete = true;
      break;
    }
    if (seenEndIds.has(nextEndId)) break;
    seenEndIds.add(nextEndId);
    endId = nextEndId;
  }

  syncDiagnostic("bitget_assets_pagination", {
    requestedLimit: bitgetAssetPageSize,
    pageCount: pages.length,
    rowCount: rows.length,
    complete,
    pages,
  }, !complete);

  return { rows, complete, pageCount: pages.length, pages };
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
    .filter((row) => row.coin === asset && row.periodType === "flexible" && row.status !== "off_line" && !isBitgetVipLevel(row.productLevel))
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
    .filter((row) => row.productCoin === asset
      && row.periodType === "flexible"
      && (!isBitgetVipLevel(row.productLevel) || finiteNumber(row.holdAmount) > 0))
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
    // A positive balance is authoritative evidence that the account owns a
    // real product, even when the product/APR endpoint no longer returns it
    // or the holding response has no usable rate ladder.
    .filter((item) => item.tiers.length > 0 || finiteNumber(item.row.holdAmount) > 0)
    .sort((left, right) => (left.externalProductId ?? "").localeCompare(right.externalProductId ?? ""));
}

function isBitgetVipLevel(value: string | undefined) {
  return value?.trim().toUpperCase() === "VIP";
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
