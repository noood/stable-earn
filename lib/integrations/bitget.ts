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
type BitgetApiReadStatus = "complete" | "partial" | "error";

export type BitgetSavingsSnapshot = {
  rates: LiveRate[];
  holdings: Record<string, number>;
  sync: {
    products: boolean;
    holdings: boolean;
    productStatus: BitgetApiReadStatus;
    holdingStatus: BitgetApiReadStatus;
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
    status: "returned" | "empty" | "partial" | "error";
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
      const dataIsList = Array.isArray(productResult.value.data);
      const rows: BitgetProductRow[] = dataIsList ? productResult.value.data as BitgetProductRow[] : [];
      const scopedRows = rows.filter((row) => row.coin === asset);
      const wrongCoinRows = rows.some((row) => row.coin !== asset);
      const fixedIdentityCounts = new Map<string, number>();
      for (const row of scopedRows) {
        if (row.periodType !== "fixed") continue;
        const identity = bitgetFixedIdentityId(row.productId, row.period);
        if (identity) fixedIdentityCounts.set(identity, (fixedIdentityCounts.get(identity) ?? 0) + 1);
      }
      const duplicateFixedIdentity = [...fixedIdentityCounts.values()].some((count) => count > 1);
      const malformedRows = scopedRows.some((row) => (
        !normalizeExternalProductId(row.productId)
        || !["flexible", "fixed"].includes(row.periodType ?? "")
        || (row.periodType === "fixed" && (parseBitgetTermDays(row.period) === undefined || normalizeTiers(row.apyList).length === 0))
        || (row.periodType === "flexible" && normalizeTiers(row.apyList).length === 0)
      )) || duplicateFixedIdentity;
      const normalizedRows = scopedRows.map((row) => {
        const eligibleForMonitoring = row.periodType === "flexible"
          ? row.status !== "off_line" && !isBitgetVipLevel(row.productLevel)
          : undefined;
        return {
          productId: row.periodType === "fixed"
            ? bitgetFixedIdentityId(row.productId, row.period) ?? null
            : normalizeExternalProductId(row.productId) ?? null,
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
        status: !dataIsList || wrongCoinRows || malformedRows ? "partial" : scopedRows.length > 0 ? "returned" : "empty",
        rowCount: scopedRows.length,
        eligibleFlexibleCount,
        rows: normalizedRows,
        ...(!dataIsList ? { diagnostic: "missing_product_list" } : wrongCoinRows ? { diagnostic: "product_scope_mismatch" } : duplicateFixedIdentity ? { diagnostic: "duplicate_fixed_product_identity" } : malformedRows ? { diagnostic: "missing_required_fields" } : {}),
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
          productId: periodType === "fixed"
            ? bitgetFixedIdentityId(row.productId, row.period) ?? null
            : normalizeExternalProductId(row.productId) ?? null,
          periodType: row.periodType ?? null,
          period: row.period ?? null,
          productLevel: row.productLevel ?? null,
          hasPositiveHolding: finiteNumber(row.holdAmount) > 0,
          tiers: normalizeAssetTiers(row.apy),
        }));
      const identityComplete = collection.rows.every((row) => row.productCoin && row.periodType
        && normalizeExternalProductId(row.productId)
        && strictBitgetNumber(row.holdAmount) !== undefined
        && row.periodType === periodType
        && (periodType !== "fixed" || parseBitgetTermDays(row.period) !== undefined));
      const complete = collection.complete && identityComplete;
      return {
        status: complete ? "complete" : "incomplete",
        complete,
        pageCount: collection.pageCount,
        rowCount: rows.length,
        rows,
        ...(!collection.complete ? { diagnostic: "pagination_incomplete" } : !identityComplete ? { diagnostic: "missing_product_identity" } : {}),
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
  const [productResults, assetsResult] = await Promise.all([
    Promise.allSettled(assets.map((asset) => fetchBitgetCapabilityProducts(credentials, asset))),
    Promise.allSettled([fetchBitgetAssetPages(credentials, "flexible")]).then(([result]) => result),
  ]);
  const failedProduct = productResults.find((result) => result.status === "rejected");
  if (productResults.every((result) => result.status === "rejected") && assetsResult.status === "rejected") {
    const publicApiReachable = await canReachBitgetPublicApi(credentials.baseUrl);
    throw new Error(`Bitget read-only API failed (${endpointDiagnostic(failedProduct?.reason)};public_${publicApiReachable ? "ok" : "blocked"})`);
  }

  const fetchedAt = new Date().toISOString();
  const rates: BitgetSavingsSnapshot["rates"] = [];
  const malformedProductResponse = productResults.some((result) => result.status === "fulfilled" && !Array.isArray(result.value.data));
  const productEntries = productResults.flatMap((result, index) => result.status === "fulfilled" && Array.isArray(result.value.data)
    ? result.value.data.map((row) => ({ requestedAsset: assets[index], row }))
    : []);
  const productRows = productEntries.map((entry) => entry.row);
  const assetCollection = assetsResult.status === "fulfilled" ? assetsResult.value : null;
  const assetRows = assetCollection?.rows ?? [];
  const malformedProductRows = productRows.filter((row) => assets.includes(row.coin as SupportedAsset)
    && (!normalizeExternalProductId(row.productId)
      || !["flexible", "fixed"].includes(row.periodType ?? "")
      || (row.periodType === "flexible" && normalizeTiers(row.apyList).length === 0)
      || (row.periodType === "fixed" && (parseBitgetTermDays(row.period) === undefined || normalizeTiers(row.apyList).length === 0))));
  const productRowsMissingScope = productEntries.some(({ requestedAsset, row }) => !row.coin || !row.periodType || row.coin !== requestedAsset);
  const malformedHoldingRows = assetRows.filter((row) => !row.productCoin || !row.periodType
    || assets.includes(row.productCoin as SupportedAsset)
      && (row.periodType !== "flexible"
        || !normalizeExternalProductId(row.productId)
        || strictBitgetNumber(row.holdAmount) === undefined));
  const holdingsListComplete = assetCollection?.complete === true && malformedHoldingRows.length === 0;

  // Temporary, sanitized trace for comparing Bitget's product-list IDs with
  // the IDs returned by the assets/holdings endpoint. Keep only controlled
  // product fields; never include credentials or the raw upstream payload.
  syncDiagnostic("bitget_product_rows", {
    fetchedAt,
    rows: productRows
      .filter((row) => assets.includes(row.coin as SupportedAsset))
      .map((row) => ({
        productId: row.periodType === "fixed"
            ? bitgetFixedIdentityId(row.productId, row.period) ?? null
            : normalizeExternalProductId(row.productId) ?? null,
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
      .filter((row) => assets.includes(row.productCoin as SupportedAsset))
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
      const externalProductId = item.externalProductId;
      if (!externalProductId) return;
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
        apr: item.hasProductRow ? item.tiers[0]?.apr ?? 0 : 0,
        tiers: item.hasProductRow ? item.tiers : [],
        fetchedAt,
        sourceLabel: item.hasProductRow
          ? item.tiers.length ? "Bitget 官方账户产品 API" : "Bitget 产品资料缺少 APR；待手动填写"
          : "Bitget 官方账户持仓 API；产品资料待填写",
        ...(!item.hasProductRow || item.tiers.length === 0 ? { productDataMode: "manual" as const } : {}),
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
        rateCoverage: item.hasProductRow && item.tiers.length > 0 ? "complete" : "unavailable",
      });
    });
  }

  const holdings: Record<string, number> = {};
  const missingHoldingAssets: string[] = [];
  if (assetsResult.status === "fulfilled") {
    for (const asset of assets) {
      const matchingRows = assetRows
        .filter((row) => row.productCoin === asset && row.periodType === "flexible"
          && normalizeExternalProductId(row.productId)
          && strictBitgetNumber(row.holdAmount) !== undefined);
      const assetRates = rates.filter((rate) => rate.catalog?.asset === asset);
      if (matchingRows.length > 0) {
        matchingRows.forEach((row) => {
          const externalProductId = normalizeExternalProductId(row.productId);
          if (!externalProductId) return;
          const identity = buildPlatformProductIdentity({
            accountId: "bitget-global",
            asset,
            productType: "flexible",
            externalProductId,
          });
          holdings[identity.identityKey] = (holdings[identity.identityKey] ?? 0) + strictBitgetNumber(row.holdAmount)!;
        });
      }
      // Bitget's assets endpoint is a paged list of current holdings, not a
      // copy of the product list. Once every page has been read, an offer
      // absent from this list is an authoritative zero. Before pagination is
      // complete, keep it unknown so a truncated response cannot erase a
      // previously known holding.
      if (holdingsListComplete) {
        for (const rate of assetRates) {
          if (!matchingRows.some((row) => normalizeExternalProductId(row.productId) === rate.externalProductId)) {
            holdings[rate.identityKey ?? rate.productId] = 0;
          }
        }
      } else {
        for (const rate of assetRates) {
          if (!matchingRows.some((row) => normalizeExternalProductId(row.productId) === rate.externalProductId)) {
            missingHoldingAssets.push(`${asset}:${rate.externalProductId ?? "unknown"}`);
          }
        }
      }
    }
  }

  const failedRequiredProduct = productResults.find((result) => result.status === "rejected");
  const productStatus: BitgetApiReadStatus = productResults.length > 0 && productResults.every((result) => result.status === "rejected")
    ? "error"
    : productResults.some((result) => result.status === "rejected") || malformedProductResponse || productRowsMissingScope || malformedProductRows.length > 0
      ? "partial"
      : "complete";
  const holdingStatus: BitgetApiReadStatus = assetsResult.status === "rejected"
    ? "error"
    : holdingsListComplete && missingHoldingAssets.length === 0 ? "complete" : "partial";

  return {
    rates,
    holdings,
    sync: {
      products: productStatus === "complete",
      holdings: holdingStatus === "complete",
      productStatus,
      holdingStatus,
      productDiagnostic: failedRequiredProduct ? endpointDiagnostic(failedRequiredProduct.reason) : malformedProductResponse ? "missing_product_list" : productRowsMissingScope ? "missing_product_scope" : malformedProductRows.length ? "missing_required_fields" : undefined,
      holdingsDiagnostic: assetsResult.status === "rejected"
        ? endpointDiagnostic(assetsResult.reason)
        : !assetCollection?.complete ? "pagination_incomplete" : malformedHoldingRows.length ? "missing_product_identity" : missingHoldingAssets.length > 0 ? `missing_${missingHoldingAssets.join("_")}` : undefined,
    },
  };
}

/** Daily fixed-term snapshot, using the same authenticated Savings endpoints as the read-only scan. */
export async function fetchBitgetFixedSnapshot(
  credentials: BitgetCredentials,
  assets: readonly SupportedAsset[] = apiAssetsFor("bitget-global", "fixed", "productApi") as SupportedAsset[],
): Promise<BitgetSavingsSnapshot> {
  const [productResults, holdingsResult] = await Promise.all([
    Promise.allSettled(assets.map((asset) => fetchBitgetCapabilityProducts(credentials, asset))),
    Promise.allSettled([fetchBitgetAssetPages(credentials, "fixed")]),
  ]);
  const holdingsPageResult = holdingsResult[0];
  const productError = productResults.find((result) => result.status === "rejected");
  if (productResults.every((result) => result.status === "rejected") && holdingsPageResult.status === "rejected") {
    throw new Error(`Bitget fixed Savings API failed (${endpointDiagnostic(productError?.reason)})`);
  }

  const fetchedAt = new Date().toISOString();
  const malformedProductResponse = productResults.some((result) => result.status === "fulfilled" && !Array.isArray(result.value.data));
  const productEntries = productResults.flatMap((result, index) => result.status === "fulfilled" && Array.isArray(result.value.data)
    ? result.value.data.map((row) => ({ requestedAsset: assets[index], row }))
    : []);
  const productRows = productEntries.map((entry) => entry.row);
  const holdingsPage = holdingsPageResult.status === "fulfilled" ? holdingsPageResult.value : null;
  const holdingRows = holdingsPage?.rows ?? [];
  const rates: LiveRate[] = [];
  const holdings: Record<string, number> = {};
  const malformedProducts = new Set<string>();
  const malformedHoldings = new Set<string>();
  const duplicateOfferIds = new Set<string>();
  const seenOfferIds = new Set<string>();

  for (const { requestedAsset, row } of productEntries) {
    if (!row.coin || !row.periodType || row.coin !== requestedAsset) malformedProducts.add(requestedAsset);
    if (row.coin !== requestedAsset || row.periodType !== "fixed") continue;
    const identity = bitgetFixedIdentityId(row.productId, row.period);
    if (!identity || normalizeTiers(row.apyList).length === 0) malformedProducts.add(requestedAsset);
    if (identity && seenOfferIds.has(`${requestedAsset}:${identity}`)) duplicateOfferIds.add(`${requestedAsset}:${identity}`);
    if (identity) seenOfferIds.add(`${requestedAsset}:${identity}`);
  }
  for (const row of holdingRows) {
    if (!row.productCoin) {
      assets.forEach((asset) => malformedHoldings.add(asset));
      continue;
    }
    if (!assets.includes(row.productCoin as SupportedAsset)) continue;
    const asset = row.productCoin as SupportedAsset;
    if (row.periodType !== "fixed"
      || !bitgetFixedIdentityId(row.productId, row.period)
      || strictBitgetNumber(row.holdAmount) === undefined) malformedHoldings.add(asset);
  }
  for (const key of duplicateOfferIds) malformedProducts.add(key.slice(0, key.indexOf(":")));
  const holdingsListComplete = holdingsPage?.complete === true && malformedHoldings.size === 0;

  for (const asset of assets) {
    const offerRows = productRows.filter((row) => row.coin === asset && row.periodType === "fixed");
    const assetHoldingRows = holdingRows.filter((row) => row.productCoin === asset && row.periodType === "fixed");

    const byId = new Map<string, { row: BitgetProductRow & Partial<BitgetAssetRow>; tiers: Array<{ min: number; max: number | null; apr: number }>; hasProduct: boolean }>();
    for (const row of offerRows) {
      const id = bitgetFixedIdentityId(row.productId, row.period);
      if (!id || row.status === "off_line") continue;
      if (duplicateOfferIds.has(`${asset}:${id}`)) continue;
      const matchingHolding = assetHoldingRows.find((holding) => bitgetFixedIdentityId(holding.productId, holding.period) === id);
      const tiers = normalizeTiers(row.apyList);
      if (isBitgetVipLevel(row.productLevel) && finiteNumber(matchingHolding?.holdAmount) <= 0) continue;
      byId.set(id, { row: { ...row, ...matchingHolding }, tiers, hasProduct: true });
    }
    for (const row of assetHoldingRows) {
      const id = bitgetFixedIdentityId(row.productId, row.period);
      if (!id) continue;
      if (duplicateOfferIds.has(`${asset}:${id}`)) continue;
      const parsedAmount = strictBitgetNumber(row.holdAmount);
      if (parsedAmount === undefined) continue;
      const amount = parsedAmount;
      if (isBitgetVipLevel(row.productLevel) && amount <= 0) continue;
      const current = byId.get(id);
      if (!current && amount <= 0) continue;
      byId.set(id, {
        row: { ...current?.row, ...row },
        tiers: current?.tiers ?? [],
        hasProduct: current?.hasProduct ?? false,
      });
      const identity = buildPlatformProductIdentity({ accountId: "bitget-global", asset, productType: "fixed", externalProductId: id });
      holdings[identity.identityKey] = (holdings[identity.identityKey] ?? 0) + amount;
    }

    for (const [externalProductId, item] of byId) {
      const identity = buildPlatformProductIdentity({ accountId: "bitget-global", asset, productType: "fixed", externalProductId });
      const termDays = parseBitgetTermDays(item.row.period);
      const rowRate = {
        productId: identity.identityKey,
        ...identity,
        name: bitgetProductName(item.row, 0, "fixed"),
        apr: item.hasProduct ? item.tiers[0]?.apr ?? 0 : 0,
        tiers: item.hasProduct ? item.tiers : [],
        fetchedAt,
        sourceLabel: item.hasProduct
          ? item.tiers.length ? "Bitget 官方 Savings 定期产品 API" : "Bitget 定期产品资料缺少 APR；待手动填写"
          : "Bitget 官方 Savings 定期持仓 API；产品资料待填写",
        ...(!item.hasProduct || item.tiers.length === 0 ? { productDataMode: "manual" as const } : {}),
        productType: "fixed" as const,
        ...(termDays !== undefined ? { termDays } : {}),
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
        rateCoverage: item.hasProduct && item.tiers.length ? "complete" as const : "unavailable" as const,
      };
      rates.push(rowRate);
      if (holdingsListComplete && !Object.hasOwn(holdings, identity.identityKey)) holdings[identity.identityKey] = 0;
    }
  }

  syncDiagnostic("bitget_fixed_rows", {
    productApiStatus: productResults.every((result) => result.status === "fulfilled") && !malformedProductResponse && malformedProducts.size === 0 ? "success" : "partial",
    productRowCount: productRows.filter((row) => row.periodType === "fixed").length,
    productRows: productRows.filter((row) => assets.includes(row.coin as SupportedAsset) && row.periodType === "fixed").map((row) => ({
      productId: bitgetFixedIdentityId(row.productId, row.period) ?? null,
      coin: row.coin ?? null,
      duration: row.period ?? null,
      status: row.status ?? null,
      isVip: isBitgetVipLevel(row.productLevel),
      rateShape: normalizeTiers(row.apyList).length ? "tiered_rate" : "no_rate",
    })),
    holdingsApiStatus: holdingsPageResult.status === "rejected" ? "error" : holdingsListComplete ? "success" : "partial",
    positionRowCount: holdingRows.length,
    positionRows: holdingRows.filter((row) => assets.includes(row.productCoin as SupportedAsset) && row.periodType === "fixed").map((row) => ({
      productId: bitgetFixedIdentityId(row.productId, row.period) ?? null,
      coin: row.productCoin ?? null,
      duration: row.period ?? null,
      status: row.productLevel ?? null,
      hasPositiveHolding: finiteNumber(row.holdAmount) > 0,
    })),
  });

  const productStatus: BitgetApiReadStatus = productResults.length > 0 && productResults.every((result) => result.status === "rejected")
    ? "error"
    : productResults.some((result) => result.status === "rejected") || malformedProductResponse || malformedProducts.size > 0
      ? "partial"
      : "complete";
  const holdingStatus: BitgetApiReadStatus = holdingsPageResult.status === "rejected"
    ? "error"
    : holdingsListComplete ? "complete" : "partial";

  return {
    rates,
    holdings,
    sync: {
      products: productStatus === "complete",
      holdings: holdingStatus === "complete",
      productStatus,
      holdingStatus,
      productDiagnostic: productError ? endpointDiagnostic(productError.reason) : malformedProductResponse ? "missing_product_list" : malformedProducts.size ? `missing_required_fields_${[...malformedProducts].join("_")}` : undefined,
      holdingsDiagnostic: holdingsPageResult.status === "rejected" ? endpointDiagnostic(holdingsPageResult.reason) : !holdingsPage?.complete ? "pagination_incomplete" : malformedHoldings.size ? `missing_product_identity_${[...malformedHoldings].join("_")}` : undefined,
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
    if (!response.data || !Array.isArray(response.data.resultList)) {
      pages.push({
        page,
        requestedLimit: bitgetAssetPageSize,
        rowCount: 0,
        responseKeys: response.data ? Object.keys(response.data).sort() : [],
        endId: null,
      });
      break;
    }
    const data = response.data;
    const pageRows = data.resultList as BitgetAssetRow[];
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
    .filter((row) => row.coin === asset && row.periodType === "flexible" && row.status !== "off_line"
      && Boolean(normalizeExternalProductId(row.productId))
      && (!isBitgetVipLevel(row.productLevel) || assetRows.some((holding) => normalizeExternalProductId(holding.productId) === normalizeExternalProductId(row.productId) && finiteNumber(holding.holdAmount) > 0)))
    .map((row) => ({
      key: normalizeExternalProductId(row.productId)!,
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
      && Boolean(normalizeExternalProductId(row.productId))
      && (!isBitgetVipLevel(row.productLevel) || finiteNumber(row.holdAmount) > 0))
    .forEach((row) => {
      const tiers = normalizeAssetTiers(row.apy);
      const key = normalizeExternalProductId(row.productId)!;
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

function bitgetProductName(row: { productLevel?: string; period?: string }, index: number, productType: "flexible" | "fixed" = "flexible") {
  const level = row.productLevel && row.productLevel !== "normal" ? ` · ${row.productLevel}` : "";
  const period = productType === "fixed" && row.period ? ` · ${row.period}` : "";
  return `Savings ${productType === "fixed" ? "Fixed" : "Flexible"}${period}${level}${index > 0 ? ` · 产品 ${index + 1}` : ""}`;
}

function parseBitgetTermDays(value: string | undefined) {
  const match = value?.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(d|day|days|h|hour|hours)?$/);
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return match[2]?.startsWith("h") ? amount / 24 : amount;
}

function bitgetFixedIdentityId(productId: string | undefined, period: string | undefined) {
  const id = normalizeExternalProductId(productId);
  const days = parseBitgetTermDays(period);
  if (!id || days === undefined) return undefined;
  return `${id}@${Number(days.toPrecision(12))}d`;
}

function strictBitgetNumber(value: string | number | undefined) {
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
