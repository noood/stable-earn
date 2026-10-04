import { exchangeFetch, readExchangeJson } from "@/lib/exchange-fetch";
import { buildPlatformProductIdentity } from "@/lib/product-identity";
import type { Product } from "@/lib/domain";
import type { LiveRate } from "@/lib/live-rates";
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
  result?: { list?: Row[]; nextPageCursor?: string };
};

type BybitPageScan<Row> = { rows: Row[]; complete: boolean };
const maxBybitPages = 50;

type SupportedAsset = Product["asset"];

export type BybitFlexibleProductRow = {
  productId?: string;
  coin?: string;
  status?: string;
  estimateApr?: string | number;
  estimateApy?: string | number;
  apr?: string | number;
  apy?: string | number;
  bonusApr?: string | number;
  extraApr?: string | number;
  minStakeAmount?: string | number;
  maxStakeAmount?: string | number;
  tierAprDetails?: Array<{
    min?: string | number;
    max?: string | number;
    estimateApr?: string | number;
    apr?: string | number;
    estimateApy?: string | number;
    apy?: string | number;
  }>;
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
  const holdingRows: Array<{ asset: SupportedAsset; externalProductId: string; amount: number }> = [];
  const results = await Promise.allSettled(assets.map(async (asset) => {
    const query = new URLSearchParams({ category: "FlexibleSaving", coin: asset });
    const pageScan = await fetchBybitPages(query, (pageQuery) => signedGet<BybitPositionRow>("/v5/earn/position", pageQuery, credentials));
    const accountId = account === "eu" ? "bybit-eu" : "bybit-global";
    const rawRows = pageScan.rows;
    const listComplete = pageScan.complete;
    const rows = rawRows.filter((row) => row.coin?.toUpperCase() === asset);
    const scopeMismatchCount = rawRows.length - rows.length;
    const amounts = new Map<string, number>();
    const normalizedRows: Array<{ asset: SupportedAsset; externalProductId: string; amount: number }> = [];
    let missingIdentityCount = 0;
    let invalidAmountCount = 0;
    for (const row of rows) {
      const externalProductId = row.productId?.trim();
      if (!externalProductId) {
        missingIdentityCount += 1;
        continue;
      }
      const identity = buildPlatformProductIdentity({
        accountId,
        asset,
        productType: "flexible",
        externalProductId,
      });
      const amount = strictFiniteNumber(row.amount);
      if (amount === undefined || amount < 0) {
        invalidAmountCount += 1;
        continue;
      }
      amounts.set(identity.identityKey, (amounts.get(identity.identityKey) ?? 0) + amount);
      normalizedRows.push({ asset, externalProductId, amount });
    }
    // The public product list is traced in live-rates.ts. Pair it with this
    // sanitized position trace so product IDs can be compared without logging
    // signed request details or the raw exchange response.
    syncDiagnostic("bybit_flexible_position_rows", {
      account: account === "eu" ? "bybit-eu" : "bybit-global",
      asset,
      rowCount: rows.length,
      listComplete,
      scopeMismatchCount,
      missingIdentityCount,
      invalidAmountCount,
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
    return {
      values: [...amounts.entries()] as Array<readonly [string, number]>,
      rows: normalizedRows,
      complete: listComplete && scopeMismatchCount === 0 && missingIdentityCount === 0 && invalidAmountCount === 0,
    };
  }));

  const partialAssets: SupportedAsset[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      for (const [productId, amount] of result.value.values) holdings[productId] = amount;
      holdingRows.push(...result.value.rows);
      if (!result.value.complete) partialAssets.push(assets[index]);
    }
  });

  const fetchedAt = new Date().toISOString();
  const fallbackRates: LiveRate[] = holdingRows.filter((row) => row.amount > 0).map((row) => {
    const accountId = account === "eu" ? "bybit-eu" : "bybit-global";
    const identity = buildPlatformProductIdentity({ accountId, asset: row.asset, productType: "flexible", externalProductId: row.externalProductId });
    return {
      productId: identity.identityKey,
      ...identity,
      productDataMode: "manual",
      name: "Flexible Saving",
      apr: 0,
      tiers: [{ min: 0, max: null, apr: 0 }],
      fetchedAt,
      sourceLabel: "Bybit 活期持仓 API（产品资料待填写）",
      rateCoverage: "unavailable",
      catalog: {
        accountId,
        exchange: "bybit" as const,
        region: account === "eu" ? "eu" as const : "global" as const,
        asset: row.asset,
        holdingDataMode: "api" as const,
        apiAccess: "public" as const,
      },
    };
  });
  return {
    holdings,
    holdingRows,
    rates: fallbackRates,
    sync: {
      successfulAssets: assets.filter((_, index) => results[index].status === "fulfilled" && !partialAssets.includes(assets[index])),
      partialAssets,
      failedAssets: assets.filter((_, index) => results[index].status === "rejected"),
    },
  };
}

/** Public, read-only check for one Bybit flexible-earn asset outside routine sync. */
export async function probeBybitFlexibleProducts(accountId: "bybit-global" | "bybit-eu", asset: Product["asset"]) {
  return (await scanBybitFlexibleProducts(accountId, asset)).rows;
}

/** Shared raw public product fetch used by both routine APR sync and diagnostics. */
export async function fetchBybitFlexibleProductRows(accountId: "bybit-global" | "bybit-eu", asset: Product["asset"]) {
  const baseUrls = accountId === "bybit-eu" ? ["https://api.bybit.eu"] : bybitGlobalApiBases;
  const query = new URLSearchParams({ category: "FlexibleSaving", coin: asset });
  return fetchBybitPages(query, (pageQuery) => publicGet<BybitFlexibleProductRow>("/v5/earn/product", pageQuery, baseUrls));
}

export async function scanBybitFlexibleProducts(accountId: "bybit-global" | "bybit-eu", asset: Product["asset"]) {
  const pageScan = await fetchBybitFlexibleProductRows(accountId, asset);
  const rawRows = pageScan.rows;
  const rows = rawRows
    .filter((row) => !row.coin || row.coin.toUpperCase() === asset)
    .map((row) => {
      const tiers = (row.tierAprDetails ?? []).flatMap((tier) => {
        const min = probeNumber(tier.min);
        const rawMax = probeNumber(tier.max);
        const apr = probePercent(tier.estimateApr ?? tier.apr);
        const apy = probePercent(tier.estimateApy ?? tier.apy);
        if (min === undefined || (apr === undefined && apy === undefined)) return [];
        return [{ min, max: rawMax === -1 ? null : rawMax !== undefined && rawMax > min ? rawMax : null, ...(apr !== undefined ? { apr } : {}), ...(apy !== undefined ? { apy } : {}) }];
      });
      const apr = probePercent(row.estimateApr ?? row.apr);
      const apy = probePercent(row.estimateApy ?? row.apy);
      return {
        productId: row.productId?.trim() || null,
        coin: row.coin?.toUpperCase() || asset,
        status: row.status ?? null,
        tierCount: tiers.length,
        rateShape: tiers.length ? "tiered_rate" as const : apr !== undefined || apy !== undefined ? "single_rate" as const : "no_rate" as const,
        ...(apr !== undefined ? { apr } : {}),
        ...(apy !== undefined ? { apy } : {}),
        ...(tiers.length ? { tiers } : {}),
        ...(probeNumber(row.minStakeAmount) !== undefined ? { minAmount: probeNumber(row.minStakeAmount) } : {}),
        ...(probeAmountLimit(row.maxStakeAmount) !== undefined ? { maxAmount: probeAmountLimit(row.maxStakeAmount) } : {}),
      };
    });
  return {
    rows,
    rowCount: rawRows.length,
    complete: pageScan.complete && rawRows.every((row) => (
      (!row.coin || row.coin.toUpperCase() === asset)
      && Boolean(row.productId?.trim())
      && rows.some((candidate) => candidate.productId === row.productId?.trim() && candidate.rateShape !== "no_rate")
    )),
  };
}

/** Public, read-only check for Bybit fixed-term product/APR rows by account region. */
export async function probeBybitFixedProducts(accountId: "bybit-global" | "bybit-eu") {
  return (await scanBybitFixedProducts(accountId)).rows;
}

export async function scanBybitFixedProducts(accountId: "bybit-global" | "bybit-eu") {
  const baseUrls = accountId === "bybit-eu" ? ["https://api.bybit.eu"] : bybitGlobalApiBases;
  const pageScan = await fetchBybitPages(new URLSearchParams(), (query) => publicGet<BybitFixedProductRow>(
    "/v5/earn/fixed-term/product",
    query,
    baseUrls,
  ));
  const rawRows = pageScan.rows;
  const rows = rawRows
    .filter((row) => supportedFixedAssets.has(row.coin?.toUpperCase() as Product["asset"]))
    .flatMap((row) => {
      const productId = row.productId?.trim();
      const duration = normalizeBybitDuration(row.duration);
      const coin = row.coin?.toUpperCase() as Product["asset"];
      if (!productId || !duration || !supportedFixedAssets.has(coin)) return [];
      const tiers = fixedProductTiers(row);
      const hasTieredRate = (row.tieredApyList ?? []).some((tier) => Number.isFinite(parsePercent(tier.apy)));
      return [{
        externalProductId: `${productId}@${duration}`,
        coin,
        duration,
        status: row.status ?? null,
        tierCount: row.tieredApyList?.length ?? 0,
        rateShape: hasTieredRate ? "tiered_rate" as const : tiers.length ? "single_rate" as const : "no_rate" as const,
        ...(tiers.length ? { apy: tiers[0].apr, tiers: tiers.map((tier) => ({ min: tier.min, max: tier.max, apy: tier.apr, ...(tier.maxStatus ? { maxStatus: tier.maxStatus } : {}) })) } : {}),
        ...(probeNumber(row.minStakeAmount) !== undefined ? { minAmount: probeNumber(row.minStakeAmount) } : {}),
        ...(probeAmountLimit(row.maxStakeAmount) !== undefined ? { maxAmount: probeAmountLimit(row.maxStakeAmount) } : {}),
        isVip: Boolean(row.isVip),
        specialUserGroupRequired: Boolean(row.specialUserGroupRequired),
      }];
    });
  const malformed = !pageScan.complete || rawRows.some((row) => {
    const coin = row.coin?.toUpperCase() as Product["asset"];
    if (!supportedFixedAssets.has(coin)) return !row.coin;
    return !row.productId?.trim() || !normalizeBybitDuration(row.duration) || fixedProductTiers(row).length === 0;
  });
  return {
    rows,
    complete: pageScan.complete && !malformed,
    rowCount: rawRows.filter((row) => supportedFixedAssets.has(row.coin?.toUpperCase() as Product["asset"])).length,
  };
}

/** One-off, read-only check for product-scoped fixed-term holdings in either region. */
export async function probeBybitFixedHoldings(credentials: BybitCredentials) {
  return (await scanBybitFixedHoldings(credentials)).rows;
}

export async function scanBybitFixedHoldings(credentials: BybitCredentials) {
  const pageScan = await fetchBybitPages(new URLSearchParams(), (query) => signedGet<BybitFixedPositionRow>(
    "/v5/earn/fixed-term/position",
    query,
    credentials,
  ));
  const rawRows = pageScan.rows;
  const rows = rawRows
    .filter((row) => supportedFixedAssets.has(row.coin?.toUpperCase() as Product["asset"]))
    .map((row) => ({
      productId: row.productId?.trim() || null,
      coin: row.coin?.toUpperCase() ?? null,
      duration: normalizeBybitDuration(row.duration) ?? null,
      status: row.status ?? null,
      hasPositiveHolding: finiteNumber(row.amount) > 0,
    }));
  return {
    rows,
    rowCount: rawRows.length,
    complete: pageScan.complete && rawRows.every((row) => {
      const coin = row.coin?.toUpperCase() as Product["asset"] | undefined;
      if (!coin) return false;
      if (!supportedFixedAssets.has(coin)) return true;
      const amount = strictFiniteNumber(row.amount);
      return Boolean(row.productId?.trim() && normalizeBybitDuration(row.duration))
        && amount !== undefined
        && amount >= 0;
    }),
  };
}

export async function fetchBybitShortFixedSnapshots(credentials: BybitCredentials) {
  const [productResult, positionResult] = await Promise.allSettled([
    fetchBybitPages(new URLSearchParams(), (query) => publicGet<BybitFixedProductRow>(
      "/v5/earn/fixed-term/product",
      query,
      credentials.baseUrls,
    )),
    fetchBybitPages(new URLSearchParams(), (query) => signedGet<BybitFixedPositionRow>(
      "/v5/earn/fixed-term/position",
      query,
      credentials,
    )),
  ]);
  const productRows = productResult.status === "fulfilled" ? productResult.value.rows : [];
  const productListValid = productResult.status === "fulfilled" && productResult.value.complete;
  const positionRows = positionResult.status === "fulfilled" ? positionResult.value.rows : [];
  const positionListValid = positionResult.status === "fulfilled" && positionResult.value.complete;
  const positions = positionRows.filter((row) => supportedFixedAssets.has(row.coin?.toUpperCase() as Product["asset"]));
  const productIdentityIncomplete = productRows.some((row) => {
    const asset = row.coin?.toUpperCase() as Product["asset"];
    if (!supportedFixedAssets.has(asset)) return !row.coin;
    return !row.productId?.trim() || !normalizeBybitDuration(row.duration) || fixedProductTiers(row).length === 0;
  });
  const rates: Array<LiveRate & { sourceProductId?: string }> = productRows.flatMap((row) => {
    const rate = fixedProductRate(row);
    return rate ? [rate] : [];
  });
  const resolvedPositions = positions.flatMap((row) => {
    const amount = strictFiniteNumber(row.amount);
    if (amount === undefined || amount < 0) return [];
    const externalProductId = resolveBybitFixedPositionId(row, rates);
    return externalProductId ? [{ row, externalProductId }] : [];
  });
  const unresolvedPositionCount = positions.length - resolvedPositions.length;
  const invalidPositionAmountCount = positions.filter((row) => {
    const amount = strictFiniteNumber(row.amount);
    return amount === undefined || amount < 0;
  }).length;
  const positionIdentityIncomplete = !positionListValid
    || positionRows.some((row) => !row.coin)
    || unresolvedPositionCount > 0
    || invalidPositionAmountCount > 0;
  for (const { row, externalProductId } of resolvedPositions) {
    if (finiteNumber(row.amount) <= 0 || rates.some((rate) => rate.externalProductId === externalProductId && rate.catalog?.asset === row.coin?.toUpperCase())) continue;
    const asset = row.coin?.toUpperCase() as Product["asset"];
    if (supportedFixedAssets.has(asset)) rates.push(bybitFixedHoldingOnlyRate(row, asset, externalProductId));
  }
  syncDiagnostic("bybit_fixed_rows", {
    productApiStatus: productResult.status === "rejected" ? "error" : !productListValid || productIdentityIncomplete ? "partial" : "success",
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
        rateShape: (row.tieredApyList ?? []).some((tier) => Number.isFinite(parsePercent(tier.apy)))
          ? "tiered_rate"
          : fixedProductTiers(row).length ? "single_rate" : "no_rate",
        tiers: fixedProductTiers(row),
      }];
    }),
    holdingsApiStatus: positionResult.status === "rejected" ? "error" : positionIdentityIncomplete ? "partial" : "success",
    positionRowCount: positionRows.length,
    unresolvedPositionCount,
    invalidPositionAmountCount,
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
      const matches = resolvedPositions.filter(({ row, externalProductId }) => externalProductId === rate.externalProductId && row.coin?.toUpperCase() === rate.catalog?.asset);
      if (matches.length > 0 || !positionIdentityIncomplete) {
        const amount = matches.reduce((sum, { row }) => sum + (strictFiniteNumber(row.amount) ?? 0), 0);
        holdings[rate.productId] = amount;
        if (rate.externalProductId) holdings[rate.externalProductId] = amount;
      }
    }
    for (const { row, externalProductId } of resolvedPositions) {
      const matched = rates.some((rate) => rate.externalProductId === externalProductId && rate.catalog?.asset === row.coin?.toUpperCase());
      if (!matched) holdings[externalProductId] = (holdings[externalProductId] ?? 0) + finiteNumber(row.amount);
    }
  }

  return {
    rates,
    holdings,
    sync: {
      products: productResult.status === "fulfilled" && productListValid && !productIdentityIncomplete,
      holdings: positionResult.status === "fulfilled" && !positionIdentityIncomplete,
      productStatus: productResult.status === "rejected" ? "error" as const : productListValid && !productIdentityIncomplete ? "complete" as const : "partial" as const,
      holdingStatus: positionResult.status === "rejected" ? "error" as const : !positionIdentityIncomplete ? "complete" as const : "partial" as const,
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
    ...(!tiers.length ? { productDataMode: "manual" as const } : {}),
    name: `Fixed Saving · ${formatDuration(row.duration)}`,
    apr: tiers[0]?.apr ?? 0,
    rateShape: (row.tieredApyList ?? []).some((tier) => Number.isFinite(parsePercent(tier.apy)))
      ? "tiered_rate" as const
      : tiers.length ? "single_rate" as const : "no_rate" as const,
    tiers,
    fetchedAt: new Date().toISOString(),
    sourceLabel: tiers.length ? "Bybit 官方固定期限产品与账户持仓 API" : "Bybit 定期产品资料缺少 APR；待手动填写",
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

function bybitFixedHoldingOnlyRate(row: BybitFixedPositionRow, asset: Product["asset"], externalProductId: string): LiveRate {
  const identity = buildPlatformProductIdentity({
    accountId: "bybit-global",
    asset,
    productType: "fixed",
    externalProductId,
  });
  const termDays = row.duration ? parseDurationDays(row.duration) : 0;
  return {
    productId: identity.identityKey,
    ...identity,
    productDataMode: "manual",
    name: `Fixed Saving · ${formatDuration(row.duration)}`,
    apr: 0,
    tiers: [{ min: 0, max: null, apr: 0 }],
    fetchedAt: new Date().toISOString(),
    sourceLabel: "Bybit 定期持仓 API（产品资料待填写）",
    productType: "fixed",
    ...(termDays > 0 ? { termDays } : {}),
    rateCoverage: "unavailable",
    catalog: {
      accountId: "bybit-global",
      exchange: "bybit",
      region: "global",
      asset,
      holdingDataMode: "api",
      apiAccess: "authenticated",
    },
  };
}

function resolveBybitFixedPositionId(position: BybitFixedPositionRow, rates: Array<LiveRate & { sourceProductId?: string }>) {
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
    return Number.isFinite(apr) ? [{ min, max, apr, ...(tier.max === "-1" ? { maxStatus: "unlimited" as const } : {}) }] : [];
  }).sort((left, right) => left.min - right.min);
  if (tiered.length > 0) return tiered;

  const apr = (row.interestCoinApyList ?? []).reduce((sum, item) => {
    const value = parsePercent(item.apy);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  const max = finiteNumber(row.maxStakeAmount);
  if (apr <= 0) return [];
  return [{ min: 0, max: row.maxStakeAmount === "-1" ? null : max > 0 ? max : null, apr,
    ...(row.maxStakeAmount === "-1" ? { maxStatus: "unlimited" as const } : {}) }];
}

function probeNumber(value: string | number | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function probeAmountLimit(value: string | number | undefined) {
  const parsed = probeNumber(value);
  return parsed === -1 ? null : parsed;
}

function probePercent(value: string | number | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number.parseFloat(value.replaceAll("%", "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : undefined;
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

/** Follow any advertised Bybit cursor; a repeated cursor or failed later page is partial, never empty. */
async function fetchBybitPages<Row>(
  initialQuery: URLSearchParams,
  request: (query: URLSearchParams) => Promise<BybitResponse<Row>>,
): Promise<BybitPageScan<Row>> {
  const rows: Row[] = [];
  const seenCursors = new Set<string>();
  let query = new URLSearchParams(initialQuery);
  for (let page = 0; page < maxBybitPages; page += 1) {
    let response: BybitResponse<Row>;
    try {
      response = await request(query);
    } catch (error) {
      if (page === 0) throw error;
      return { rows, complete: false };
    }
    if (!Array.isArray(response.result?.list)) return { rows, complete: false };
    rows.push(...response.result.list);
    const cursor = response.result.nextPageCursor?.trim();
    if (!cursor) return { rows, complete: true };
    if (seenCursors.has(cursor)) return { rows, complete: false };
    seenCursors.add(cursor);
    query = new URLSearchParams(initialQuery);
    query.set("cursor", cursor);
  }
  return { rows, complete: false };
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

function strictFiniteNumber(value: string | number | undefined) {
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
