import { exchangeFetch, readExchangeJson } from "@/lib/exchange-fetch";
import { buildPlatformProductIdentity, scopedExternalProductAlias } from "@/lib/product-identity";
import type { LiveRate } from "@/lib/live-rates";
import type { HoldingPosition, Product } from "@/lib/domain";
import { diagnosticErrorKind, syncDiagnostic } from "@/lib/sync-diagnostics";
import { apiAssetsFor, monitoredAssets } from "@/lib/platform-capabilities";
import { parseExchangeNumber } from "@/lib/exchange-number";

type Credentials = {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
};

type FlexibleProductRow = {
  asset?: string;
  latestAnnualPercentageRate?: string | number | null;
  tierAnnualPercentageRate?: unknown;
  productId?: string;
};

type FlexiblePositionRow = FlexibleProductRow & {
  totalAmount?: string | null;
};

type LockedProductDetail = {
  asset?: string;
  apr?: string | number | null;
  apy?: string | number | null;
  annualPercentageRate?: string | number | null;
  interestRate?: string | number | null;
  duration?: string | number | null;
  status?: string;
  isSoldOut?: boolean;
  subscriptionStartTime?: string | number | null;
};

type LockedProductRow = {
  projectId?: string;
  detail?: LockedProductDetail;
  quota?: {
    minimum?: string | number | null;
    totalPersonalQuota?: string | number | null;
  };
};

type LockedPositionRow = {
  positionId?: string | number;
  projectId?: string;
  asset?: string;
  amount?: string | number | null;
  principal?: string | number | null;
  apy?: string | number | null;
  apr?: string | number | null;
  annualPercentageRate?: string | number | null;
  interestRate?: string | number | null;
  duration?: string | number | null;
  purchaseTime?: string | number | null;
  redeemDate?: string | number | null;
  status?: string;
};

type PageResponse<Row> = {
  rows?: Row[];
  total?: number | string;
};

type DiagnosticField = {
  state: "missing" | "null" | "returned" | "empty_string" | "other";
  value?: string | number | boolean | null;
  valueType?: string;
};

type BinanceTier = {
  min: number;
  max: number | null;
  apr: number;
  maxStatus?: "unlimited";
};

type BinanceTierSchedule = {
  tiers: BinanceTier[];
  hasReportedTiers: boolean;
  complete: boolean;
  aprStatus?: "available" | "unavailable";
  capacityStatus?: "available" | "unavailable";
  tierStructureStatus?: "complete" | "incomplete";
};

export type BinanceFlexibleSnapshot = {
  rates: LiveRate[];
  holdings: Record<string, number>;
  productListsComplete: boolean;
  positionListsComplete: boolean;
  productApiStatus: "complete" | "partial" | "error";
  positionApiStatus: "complete" | "partial" | "error";
};

export type BinanceFlexibleTierDiagnostic = {
  account: "binance-global" | "binance-bahrain";
  asset: string;
  endpoint: "/sapi/v1/simple-earn/flexible/list";
  status: "returned" | "empty" | "partial" | "error";
  responseComplete: boolean;
  pageSize: number;
  rowCount: number | null;
  reportedTotal: number | null;
  failureKind?: string;
  rows: Array<{
    asset: string | null;
    productIdPresent: boolean;
    latestAprPresent: boolean;
    latestAprPercent: number | null;
    tierFieldState: "missing" | "null" | "object" | "array" | "string" | "number" | "boolean";
    tierEntryCount: number;
    tiers: Array<{
      rangeLabel: string;
      rangeParsed: boolean;
      min?: number;
      max?: number;
      aprParsed: boolean;
      bonusAprPercent: number | null;
      aprPercent: number | null;
    }>;
    tierScheduleComplete: boolean;
    tierScheduleIssue: "none_reported" | "empty_object" | "unrecognized_entry" | "range_gap_or_overlap" | "complete";
  }>;
};

export type BinanceLockedProductDiagnostic = {
  account: "binance-global" | "binance-bahrain";
  endpoint: "/sapi/v1/simple-earn/locked/list";
  status: "returned" | "empty" | "partial" | "error";
  responseComplete: boolean;
  pageSize: number;
  pagesRead: number;
  totalRowCount: number | null;
  reportedTotal: number | null;
  unmappedAssetRowCount: number;
  assetCounts: Record<string, number>;
  sampleFieldShapes: Array<{
    topLevelFields: string[];
    detailKind: string;
    detailFields: string[];
    assetCandidates: {
      rowAsset: DiagnosticField;
      rowCoin: DiagnosticField;
      detailAsset: DiagnosticField;
      detailCoin: DiagnosticField;
      detailSymbol: DiagnosticField;
    };
  }>;
  failureKind?: string;
  rows: Array<{
    projectId: string | null;
    asset: string | null;
    duration: DiagnosticField;
    apr: DiagnosticField;
    apy: DiagnosticField;
    annualPercentageRate: DiagnosticField;
    interestRate: DiagnosticField;
    minimum: DiagnosticField;
    totalPersonalQuota: DiagnosticField;
    status: string | null;
    isSoldOut: boolean | null;
    subscriptionStartTime: DiagnosticField;
  }>;
};

export type BinanceLockedSnapshot = {
  rates: LiveRate[];
  holdings: Record<string, number>;
  positions: Array<Omit<HoldingPosition, "productId" | "updatedAt" | "source"> & {
    sourceProductId: string;
    accountId: string;
    asset: Product["asset"];
  }>;
  productListComplete: boolean;
  positionListComplete: boolean;
  productApiStatus: "complete" | "partial" | "error";
  positionApiStatus: "complete" | "partial" | "error";
};

const accounts = {
  global: {
    sourceLabel: "Binance Global 官方账户 API",
  },
  bahrain: {
    sourceLabel: "Binance Bahrain 官方账户 API",
  },
} as const;

type BinanceAccount = keyof typeof accounts;
type SupportedAsset = Product["asset"];

export async function fetchBinanceFlexibleSnapshot(
  credentials: Credentials,
  account: BinanceAccount = "global",
  assets: readonly SupportedAsset[] = apiAssetsFor(
    account === "global" ? "binance-global" : "binance-bahrain",
    "flexible",
    "productApi",
  ) as SupportedAsset[],
): Promise<BinanceFlexibleSnapshot> {
  const accountConfig = accounts[account];
  const fetchedAt = new Date().toISOString();
  const results = await Promise.all(assets.map(async (asset) => {
    const [productResult, positionResult] = await Promise.allSettled([
      signedGet<PageResponse<FlexibleProductRow>>(
        "/sapi/v1/simple-earn/flexible/list",
        { asset, current: 1, size: 100 },
        credentials,
      ).then((page) => collectBinancePages("/sapi/v1/simple-earn/flexible/list", page, credentials, { asset })),
      signedGet<PageResponse<FlexiblePositionRow>>(
        "/sapi/v1/simple-earn/flexible/position",
        { asset, current: 1, size: 100 },
        credentials,
      ).then((page) => collectBinancePages("/sapi/v1/simple-earn/flexible/position", page, credentials, { asset })),
    ]);
    const products = productResult.status === "fulfilled"
      ? productResult.value
      : { rows: [], total: undefined, complete: false };
    const positions = positionResult.status === "fulfilled"
      ? positionResult.value
      : { rows: [], total: undefined, complete: false };
    const productRows = products.rows.filter((row) => row.asset?.toUpperCase() === asset);
    const positionRows = positions.rows.filter((row) => row.asset?.toUpperCase() === asset);
    const productScopeMismatchCount = products.rows.length - productRows.length;
    const positionScopeMismatchCount = positions.rows.length - positionRows.length;
    const productRowsShapeComplete = productRows.every((row) => normalizeBinanceProductId(row.productId));
    const positionRowsShapeComplete = positionRows.every((row) => normalizeBinanceProductId(row.productId)
      && parseStrictFinite(row.totalAmount) !== undefined);
    const productListComplete = productResult.status === "fulfilled"
      && products.complete && productScopeMismatchCount === 0 && productRowsShapeComplete;
    const positionResponseComplete = positionResult.status === "fulfilled"
      && positions.complete && positionScopeMismatchCount === 0 && positionRowsShapeComplete;
    const productApiStatus = productResult.status === "rejected" ? "error" as const
      : productListComplete ? "complete" as const : "partial" as const;
    const positionApiStatus = positionResult.status === "rejected" ? "error" as const
      : positionResponseComplete ? "complete" as const : "partial" as const;
    // Sanitized trace for verifying whether one flexible asset maps to
    // multiple upstream products. Keep product/position IDs and amounts only;
    // never emit credentials, signatures, or raw exchange responses.
    syncDiagnostic("binance_flexible_rows", {
      account: account === "global" ? "binance-global" : "binance-bahrain",
      asset,
      productApiStatus,
      productListComplete,
      productTotal: products.total ?? null,
      productRowCount: productRows.length,
      productScopeMismatchCount,
      productRows: productRows.map((row) => {
        const schedule = parseBinanceTiers(asset, row.latestAnnualPercentageRate, row.tierAnnualPercentageRate);
        const hasApr = hasBinanceApr(row);
        const baseAprPercent = parseBinanceApr(row.latestAnnualPercentageRate);
        const bonusTiers = parseBinanceBonusTiers(asset, row.tierAnnualPercentageRate);
        return {
          productId: String(row.productId ?? "").trim() || null,
          asset: row.asset ?? null,
          baseAprPercent: Number.isFinite(baseAprPercent) ? baseAprPercent : null,
          rateShape: !hasApr ? "no_rate" : schedule.hasReportedTiers ? "tiered_rate" : "single_rate",
          bonusTiers,
          tiers: schedule.tiers,
          tierScheduleComplete: schedule.complete,
        };
      }),
      positionApiStatus,
      positionListComplete: positionResponseComplete,
      positionTotal: positions.total ?? null,
      positionRowCount: positionRows.length,
      positionScopeMismatchCount,
      positionRows: positionRows.map((row) => ({
        productId: String(row.productId ?? "").trim() || null,
        asset: row.asset ?? null,
        totalAmount: finiteNumber(row.totalAmount),
      })),
    });

    // Product and position endpoints are both product-scoped. Join on the
    // upstream productId instead of selecting one product row and summing
    // every position for the coin into it.
    const productRowsById = new Map<string, FlexibleProductRow>();
    let unmappedProductRowCount = 0;
    productRows.forEach((row) => {
      const productId = normalizeBinanceProductId(row.productId);
      if (!productId) {
        unmappedProductRowCount += 1;
        return;
      }
      const existing = productRowsById.get(productId);
      if (!existing || (!hasBinanceApr(existing) && hasBinanceApr(row))) productRowsById.set(productId, row);
    });

    const positionsById = new Map<string, { amount: number }>();
    let unmappedPositionCount = 0;
    let invalidPositionAmountCount = 0;
    positionRows.forEach((row) => {
      const productId = normalizeBinanceProductId(row.productId);
      if (!productId) {
        unmappedPositionCount += 1;
        return;
      }
      const amount = parseStrictFinite(row.totalAmount);
      if (amount === undefined) {
        invalidPositionAmountCount += 1;
        return;
      }
      const existing = positionsById.get(productId);
      positionsById.set(productId, {
        amount: (existing?.amount ?? 0) + amount,
      });
    });
    const positionListComplete = positionResponseComplete
      && unmappedPositionCount === 0 && invalidPositionAmountCount === 0;

    const productIds = new Set(productRowsById.keys());
    for (const [productId, position] of positionsById) {
      if (position.amount > 0) productIds.add(productId);
    }

    const accountId = account === "global" ? "binance-global" : "binance-bahrain";
    const rates: LiveRate[] = [];
    const holdings: Record<string, number> = {};
    for (const externalProductId of productIds) {
      const product = productRowsById.get(externalProductId);
      const position = positionsById.get(externalProductId);
      const hasProductRow = Boolean(product);
      const rateSource = product;
      const hasApr = hasBinanceApr(rateSource);
      const schedule = parseBinanceTiers(asset, rateSource?.latestAnnualPercentageRate, rateSource?.tierAnnualPercentageRate);
      const tiers = schedule.tiers;
      const identity = buildPlatformProductIdentity({
        accountId,
        asset,
        productType: "flexible",
        externalProductId,
      });

      rates.push({
        productId: identity.identityKey,
        ...identity,
        ...(!hasProductRow ? { productDataMode: "manual" as const } : {}),
        apr: tiers[0]?.apr ?? 0,
        ...(hasApr ? { baseApr: parseBinanceApr(rateSource?.latestAnnualPercentageRate) } : {}),
        bonusTiers: parseBinanceBonusTiers(asset, rateSource?.tierAnnualPercentageRate),
        rateShape: !hasApr ? "no_rate" : schedule.hasReportedTiers ? "tiered_rate" : "single_rate",
        aprStatus: schedule.aprStatus,
        capacityStatus: schedule.capacityStatus,
        tierStructureStatus: schedule.tierStructureStatus,
        tiers,
        fetchedAt,
        sourceLabel: hasProductRow
          ? accountConfig.sourceLabel
          : accountConfig.sourceLabel.replace("账户 API", "账户持仓 API；产品资料待填写"),
        rateCoverage: !hasApr ? "unavailable" : schedule.complete ? "complete" : "base_only",
        catalog: {
          accountId,
          exchange: "binance" as const,
          region: account,
          asset,
          holdingDataMode: "api" as const,
          apiAccess: "authenticated" as const,
        },
      });
      if (position) holdings[identity.identityKey] = position.amount;
      else if (positionListComplete) holdings[identity.identityKey] = 0;
    };

    return {
      rates,
      holdings,
      productListComplete: productResult.status === "fulfilled"
        && products.complete && productScopeMismatchCount === 0 && unmappedProductRowCount === 0
        && productRowsShapeComplete,
      positionListComplete,
      productApiStatus: productResult.status === "rejected" ? "error" as const
        : products.complete && productScopeMismatchCount === 0 && unmappedProductRowCount === 0
        && productRowsShapeComplete ? "complete" as const : "partial" as const,
      positionApiStatus: positionResult.status === "rejected" ? "error" as const
        : positionListComplete ? "complete" as const : "partial" as const,
    };
  }));

  return {
    rates: results.flatMap((result) => result.rates),
    holdings: Object.assign({}, ...results.map((result) => result.holdings)),
    productListsComplete: results.every((result) => result.productListComplete),
    positionListsComplete: results.every((result) => result.positionListComplete),
    productApiStatus: aggregateSnapshotStatus(results.map((result) => result.productApiStatus)),
    positionApiStatus: aggregateSnapshotStatus(results.map((result) => result.positionApiStatus)),
  };
}

/**
 * One-page, read-only diagnosis of Binance flexible product APR metadata.
 * It intentionally does not call the holdings endpoint, follow pagination,
 * or return product IDs, credentials, raw payloads, or account positions.
 */
export async function diagnoseBinanceFlexibleTiers(
  credentials: Credentials,
  account: BinanceAccount,
  asset = "USDC",
): Promise<BinanceFlexibleTierDiagnostic> {
  const accountId = account === "global" ? "binance-global" : "binance-bahrain";
  const pageSize = 100;
  try {
    const page = await signedGet<PageResponse<FlexibleProductRow>>(
      "/sapi/v1/simple-earn/flexible/list",
      { asset, current: 1, size: pageSize },
      credentials,
    );
    const pageRows = Array.isArray(page.rows) ? page.rows : [];
    const matchingRows = pageRows.filter((row) => row && row.asset?.toUpperCase() === asset.toUpperCase());
    const reportedTotal = finiteOptional(page.total) ?? null;
    const responseComplete = Array.isArray(page.rows)
      && (reportedTotal === null ? pageRows.length < pageSize : pageRows.length === reportedTotal);

    return {
      account: accountId,
      asset,
      endpoint: "/sapi/v1/simple-earn/flexible/list",
      status: !responseComplete ? "partial" : matchingRows.length ? "returned" : "empty",
      responseComplete,
      pageSize,
      rowCount: matchingRows.length,
      reportedTotal,
      rows: matchingRows.slice(0, 50).map((row) => describeFlexibleTierRow(row, asset)),
    };
  } catch (error) {
    return {
      account: accountId,
      asset,
      endpoint: "/sapi/v1/simple-earn/flexible/list",
      status: "error",
      responseComplete: false,
      pageSize,
      rowCount: null,
      reportedTotal: null,
      failureKind: diagnosticErrorKind(error),
      rows: [],
    };
  }
}

/**
 * Narrow, read-only diagnosis of Binance Locked product rows. It calls only
 * the product-list endpoint, follows its pages, filters to monitored assets,
 * and never requests positions or returns credentials/raw response objects.
 */
export async function diagnoseBinanceLockedProducts(
  credentials: Credentials,
  account: BinanceAccount,
): Promise<BinanceLockedProductDiagnostic> {
  const accountId = account === "global" ? "binance-global" : "binance-bahrain";
  const pageSize = binancePageSize;
  try {
    const firstPage = await signedGet<PageResponse<LockedProductRow>>(
      "/sapi/v1/simple-earn/locked/list",
      { current: 1, size: pageSize },
      credentials,
    );
    const products = await collectBinancePages(
      "/sapi/v1/simple-earn/locked/list",
      firstPage,
      credentials,
    );
    const targetAssets = new Set<string>(monitoredAssets);
    const assetRows = products.rows.map((row) => ({ row, asset: lockedProductAsset(row) }));
    const matchingRows = assetRows.filter(({ asset }) => asset && targetAssets.has(asset.toUpperCase()));
    const unmappedAssetRowCount = assetRows.filter(({ asset }) => !asset).length;
    const assetCounts = assetRows.reduce<Record<string, number>>((counts, { asset }) => {
      if (asset) counts[asset] = (counts[asset] ?? 0) + 1;
      return counts;
    }, {});
    const responseComplete = products.complete;
    const status = !responseComplete || unmappedAssetRowCount > 0
      ? "partial"
      : matchingRows.length ? "returned" : "empty";

    return {
      account: accountId,
      endpoint: "/sapi/v1/simple-earn/locked/list",
      status,
      responseComplete,
      pageSize,
      pagesRead: products.pagesRead,
      totalRowCount: products.rows.length,
      reportedTotal: finiteOptional(products.total) ?? null,
      unmappedAssetRowCount,
      assetCounts,
      sampleFieldShapes: products.rows.slice(0, 5).map(lockedProductFieldShape),
      rows: matchingRows.map(({ row, asset }) => ({
        projectId: typeof row.projectId === "string" && row.projectId.trim() ? row.projectId.trim() : null,
        asset: asset ?? null,
        duration: diagnosticField(row.detail?.duration),
        apr: diagnosticField(row.detail?.apr),
        apy: diagnosticField(row.detail?.apy),
        annualPercentageRate: diagnosticField(row.detail?.annualPercentageRate),
        interestRate: diagnosticField(row.detail?.interestRate),
        minimum: diagnosticField(row.quota?.minimum),
        totalPersonalQuota: diagnosticField(row.quota?.totalPersonalQuota),
        status: typeof row.detail?.status === "string" ? row.detail.status : null,
        isSoldOut: typeof row.detail?.isSoldOut === "boolean" ? row.detail.isSoldOut : null,
        subscriptionStartTime: diagnosticField(row.detail?.subscriptionStartTime),
      })),
    };
  } catch (error) {
    return {
      account: accountId,
      endpoint: "/sapi/v1/simple-earn/locked/list",
      status: "error",
      responseComplete: false,
      pageSize,
      pagesRead: 0,
      totalRowCount: null,
      reportedTotal: null,
      unmappedAssetRowCount: 0,
      assetCounts: {},
      sampleFieldShapes: [],
      failureKind: diagnosticErrorKind(error),
      rows: [],
    };
  }
}

function lockedProductAsset(row: LockedProductRow) {
  const raw = row as Record<string, unknown>;
  const detail = recordValue(raw.detail);
  const candidates = [detail?.asset, raw.asset, raw.coin, detail?.coin, detail?.symbol];
  const asset = candidates.find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return asset?.trim();
}

function lockedProductFieldShape(row: LockedProductRow): BinanceLockedProductDiagnostic["sampleFieldShapes"][number] {
  const raw = row as Record<string, unknown>;
  const detail = recordValue(raw.detail);
  const detailValue = raw.detail;
  const detailKind = detailValue === undefined ? "missing"
    : detailValue === null ? "null"
      : Array.isArray(detailValue) ? "array"
        : typeof detailValue;
  return {
    topLevelFields: Object.keys(raw).sort(),
    detailKind,
    detailFields: detail ? Object.keys(detail).sort() : [],
    assetCandidates: {
      rowAsset: diagnosticField(raw.asset),
      rowCoin: diagnosticField(raw.coin),
      detailAsset: diagnosticField(detail?.asset),
      detailCoin: diagnosticField(detail?.coin),
      detailSymbol: diagnosticField(detail?.symbol),
    },
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function diagnosticField(value: unknown): DiagnosticField {
  if (value === undefined) return { state: "missing" };
  if (value === null) return { state: "null", value: null };
  if (typeof value === "number") {
    return Number.isFinite(value) ? { state: "returned", value } : { state: "other", valueType: "number" };
  }
  if (typeof value === "boolean") return { state: "returned", value };
  if (typeof value === "string") {
    return value.length ? { state: "returned", value } : { state: "empty_string", value };
  }
  return { state: "other", valueType: Array.isArray(value) ? "array" : typeof value };
}

function describeFlexibleTierRow(row: FlexibleProductRow, asset: string): BinanceFlexibleTierDiagnostic["rows"][number] {
  const rawTiers = row.tierAnnualPercentageRate;
  const tierFieldState = rawTiers === undefined ? "missing"
    : rawTiers === null ? "null"
      : Array.isArray(rawTiers) ? "array"
        : typeof rawTiers === "object" ? "object"
          : typeof rawTiers === "string" ? "string"
            : typeof rawTiers === "number" ? "number"
              : typeof rawTiers === "boolean" ? "boolean" : "string";
  const entries = rawTiers && typeof rawTiers === "object" && !Array.isArray(rawTiers)
    ? Object.entries(rawTiers as Record<string, unknown>)
    : [];
  const parsedEntries = entries.map(([label, rawApr]) => {
    const bounds = parseTierBounds(label, asset);
    const aprCandidate = typeof rawApr === "string" || typeof rawApr === "number" ? rawApr : undefined;
    const parsedApr = parseBinanceApr(aprCandidate);
    return {
      rangeLabel: bounds ? `${bounds.min}-${bounds.max}${asset}` : "<unrecognized>",
      rangeParsed: Boolean(bounds),
      ...(bounds ?? {}),
      aprParsed: Number.isFinite(parsedApr),
      bonusAprPercent: Number.isFinite(parsedApr) ? Number(parsedApr.toFixed(8)) : null,
      aprPercent: Number.isFinite(parsedApr) && Number.isFinite(parseBinanceApr(row.latestAnnualPercentageRate))
        ? Number((parsedApr + parseBinanceApr(row.latestAnnualPercentageRate)).toFixed(8))
        : null,
    };
  });
  const schedule = parseBinanceTiers(asset, row.latestAnnualPercentageRate, rawTiers);
  const tierScheduleIssue = entries.length === 0
    ? tierFieldState === "object" ? "empty_object" as const
      : tierFieldState === "missing" || tierFieldState === "null" ? "none_reported" as const : "unrecognized_entry" as const
    : parsedEntries.length !== entries.length || parsedEntries.some((entry) => !entry.rangeParsed || !entry.aprParsed)
      ? "unrecognized_entry" as const
      : !schedule.complete ? "range_gap_or_overlap" as const : "complete" as const;
  const latestApr = parseBinanceApr(row.latestAnnualPercentageRate);
  return {
    asset: typeof row.asset === "string" ? row.asset : null,
    productIdPresent: Boolean(row.productId?.trim()),
    latestAprPresent: Number.isFinite(latestApr),
    latestAprPercent: Number.isFinite(latestApr) ? Number(latestApr.toFixed(8)) : null,
    tierFieldState,
    tierEntryCount: entries.length,
    tiers: parsedEntries,
    tierScheduleComplete: schedule.complete,
    tierScheduleIssue,
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
  assets: readonly string[] = apiAssetsFor(
    account === "global" ? "binance-global" : "binance-bahrain",
    "fixed",
    "productApi",
  ),
): Promise<BinanceLockedSnapshot> {
  const accountConfig = accounts[account];
  const supported = new Set(assets.map((asset) => asset.toUpperCase()));
  const [productResult, positionResult] = await Promise.allSettled([
    signedGet<PageResponse<LockedProductRow>>(
      "/sapi/v1/simple-earn/locked/list",
      { current: 1, size: 100 },
      credentials,
    ).then((page) => collectBinancePages("/sapi/v1/simple-earn/locked/list", page, credentials)),
    signedGet<PageResponse<LockedPositionRow>>(
      "/sapi/v1/simple-earn/locked/position",
      { current: 1, size: 100 },
      credentials,
    ).then((page) => collectBinancePages("/sapi/v1/simple-earn/locked/position", page, credentials)),
  ]);
  const products = productResult.status === "fulfilled"
    ? productResult.value
    : { rows: [], total: undefined, complete: false };
  const positionsResponse = positionResult.status === "fulfilled"
    ? positionResult.value
    : { rows: [], total: undefined, complete: false };
  const productRows = products.rows;
  const positionRows = positionsResponse.rows;
  const fetchedAt = new Date().toISOString();
  const normalizedAsset = (value: string | undefined) => String(value ?? "").toUpperCase();
  const monitoredProductRows = productRows.filter((row) => supported.has(normalizedAsset(row.detail?.asset)));
  const monitoredPositionRows = positionRows.filter((row) => supported.has(normalizedAsset(row.asset)));
  const productShapeComplete = productRows.every((row) => {
    const asset = normalizedAsset(row.detail?.asset);
    if (!asset) return false;
    if (!supported.has(asset)) return true;
    return Boolean(String(row.projectId ?? "").trim())
      && positiveNumber(row.detail?.duration) !== undefined;
  });
  const positionShapeComplete = positionRows.every((row) => {
    const asset = normalizedAsset(row.asset);
    if (!asset) return false;
    if (!supported.has(asset)) return true;
    return Boolean(String(row.projectId ?? "").trim())
      && positiveNumber(row.duration) !== undefined
      && parseStrictFinite(row.amount ?? row.principal) !== undefined;
  });
  const collectTerms = (rows: Array<LockedProductRow | LockedPositionRow>) => {
    const terms = new Map<string, Set<number>>();
    for (const row of rows) {
      const projectId = String(row.projectId ?? "").trim();
      const productRow = "detail" in row;
      const asset = normalizedAsset(productRow
        ? (row as LockedProductRow).detail?.asset
        : (row as LockedPositionRow).asset);
      const duration = positiveNumber(productRow
        ? (row as LockedProductRow).detail?.duration
        : (row as LockedPositionRow).duration);
      if (!projectId || !asset || duration === undefined) continue;
      const key = `${asset}:${projectId}`;
      const knownTerms = terms.get(key) ?? new Set<number>();
      knownTerms.add(duration);
      terms.set(key, knownTerms);
    }
    return terms;
  };
  const productTermSets = collectTerms(monitoredProductRows);
  const positionTermSets = collectTerms(monitoredPositionRows);
  const conflictingProductIds = new Set([...productTermSets.entries()].filter(([, terms]) => terms.size > 1).map(([key]) => key));
  const conflictingPositionIds = new Set([...positionTermSets.entries()].filter(([, terms]) => terms.size > 1).map(([key]) => key));
  const conflictingTerms = new Set([...conflictingProductIds, ...conflictingPositionIds]);
  const productDurationMismatch = new Set<string>();
  for (const [key, positionTerms] of positionTermSets) {
    const productTerms = productTermSets.get(key);
    if (productTerms?.size === 1 && [...positionTerms].some((term) => !productTerms.has(term))) productDurationMismatch.add(key);
  }
  const ambiguousProjectIds = new Set([...conflictingTerms, ...productDurationMismatch]);
  const productListComplete = products.complete && productShapeComplete
    && conflictingProductIds.size === 0;
  const positionListComplete = positionsResponse.complete && positionShapeComplete
    && conflictingPositionIds.size === 0 && productDurationMismatch.size === 0;
  const productApiStatus = productResult.status === "rejected" ? "error" as const : productListComplete ? "complete" as const : "partial" as const;
  const positionApiStatus = positionResult.status === "rejected" ? "error" as const : positionListComplete ? "complete" as const : "partial" as const;

  // Temporary, sanitized trace for verifying why an expired locked product
  // remains visible. Keep product and position IDs together with only the
  // fields needed for lifecycle decisions; never emit the raw response.
  syncDiagnostic("binance_locked_rows", {
    account,
    productRowCount: productRows.length,
    positionRowCount: positionRows.length,
    productTotal: products.total ?? null,
    positionTotal: positionsResponse.total ?? null,
    productApiStatus,
    positionApiStatus,
    productListComplete,
    positionListComplete,
    productRows: monitoredProductRows.flatMap((row) => {
      const detail = row.detail;
      const asset = String(detail?.asset ?? "").toUpperCase();
      return supported.has(asset) ? [{
        // This is Binance's upstream projectId, not our database product_id.
        externalProjectId: String(row.projectId ?? "").trim() || null,
        asset,
        duration: positiveNumber(detail?.duration),
        apr: parseBinanceApr(detail?.apr ?? detail?.apy ?? detail?.annualPercentageRate ?? detail?.interestRate),
        minAmount: finiteOptional(row.quota?.minimum) ?? null,
        maxAmount: finiteOptional(row.quota?.totalPersonalQuota) ?? null,
        maxAmountStatus: row.quota?.totalPersonalQuota === undefined ? "not_returned" : "limited",
        status: detail?.status ?? null,
        isSoldOut: detail?.isSoldOut ?? null,
      }] : [];
    }),
    positionRows: monitoredPositionRows.flatMap((row) => {
      const asset = String(row.asset ?? "").toUpperCase();
      return supported.has(asset) ? [{
        positionId: row.positionId === undefined ? null : String(row.positionId),
        // This is Binance's upstream projectId, not our database product_id.
        externalProjectId: String(row.projectId ?? "").trim() || null,
        asset,
        amount: finiteNumber(row.amount ?? row.principal),
        duration: positiveNumber(row.duration),
        apr: parseBinanceApr(row.apr ?? row.apy ?? row.annualPercentageRate ?? row.interestRate),
        purchaseTime: timestampIso(row.purchaseTime),
        redeemDate: timestampIso(row.redeemDate),
        status: row.status ?? null,
      }] : [];
    }),
  });

  const rates: LiveRate[] = [];
  const rateByProject = new Map<string, LiveRate>();

  for (const row of monitoredProductRows) {
    const projectId = String(row.projectId ?? "").trim();
    const detail = row.detail;
    const asset = String(detail?.asset ?? "").toUpperCase();
    const duration = positiveNumber(detail?.duration);
    const apr = parseBinanceApr(detail?.apr ?? detail?.apy ?? detail?.annualPercentageRate ?? detail?.interestRate);
    if (!projectId || !supported.has(asset) || !duration
      || ambiguousProjectIds.has(`${asset}:${projectId}`)) continue;
    const parsedApr = Number.isFinite(apr);
    const rate = lockedRate(accountConfig, account, asset, projectId, duration, parsedApr ? apr : 0, detail, row.quota, fetchedAt);
    if (!parsedApr) {
      rate.rateCoverage = "unavailable";
      rate.rateShape = "no_rate";
      rate.aprStatus = "unavailable";
    }
    rates.push(rate);
    rateByProject.set(`${asset}:${projectId}`, rate);
  }

  const validPositions = monitoredPositionRows.flatMap((row) => {
    const projectId = String(row.projectId ?? "").trim();
    const asset = String(row.asset ?? "").toUpperCase();
    const duration = positiveNumber(row.duration);
    const amount = parseStrictFinite(row.amount ?? row.principal);
    if (!projectId || !supported.has(asset) || amount === undefined || ambiguousProjectIds.has(`${asset}:${projectId}`)) return [];
    return [{ row, projectId, asset, duration, amount }];
  });

  // A positive position without a usable product row is retained as a manual
  // information shell. Position-side APR fields do not substitute for the
  // product catalogue endpoint.
  for (const position of validPositions) {
    const key = `${position.asset}:${position.projectId}`;
    if (position.amount <= 0 || rateByProject.has(key)) continue;
    const identity = buildPlatformProductIdentity({
      accountId: account === "global" ? "binance-global" : "binance-bahrain",
      asset: position.asset,
      productType: "fixed",
      externalProductId: position.projectId,
    });
    const rate: LiveRate = {
      productId: identity.identityKey,
      ...identity,
      productDataMode: "manual",
      manualFields: position.duration === undefined ? { termDays: true } : undefined,
      name: position.duration === undefined ? "Simple Earn Locked" : `Simple Earn Locked · ${formatLockedDuration(position.duration)}`,
      apr: 0,
      rateShape: "no_rate",
      tiers: [],
      fetchedAt,
      sourceLabel: accountConfig.sourceLabel.replace("账户 API", "定期账户持仓 API；产品资料待填写"),
      productType: "fixed",
      ...(position.duration !== undefined ? { termDays: position.duration } : {}),
      rateCoverage: "unavailable",
      catalog: {
        accountId: account === "global" ? "binance-global" : "binance-bahrain",
        exchange: "binance",
        region: account,
        asset: position.asset as Product["asset"],
        holdingDataMode: "api",
        apiAccess: "authenticated",
      },
    };
    rates.push(rate);
    rateByProject.set(key, rate);
  }

  const holdings: Record<string, number> = {};
  for (const rate of rates) {
    const projectId = rate.externalProductId;
    const asset = rate.catalog?.asset;
    if (!projectId || !asset) continue;
    const matches = validPositions.filter((position) => position.projectId === projectId && position.asset === asset);
    const amount = matches.reduce((sum, position) => sum + position.amount, 0);
    if (matches.length > 0) holdings[rate.productId] = amount;
    else if (positionListComplete) holdings[rate.productId] = 0;
    const accountId = account === "global" ? "binance-global" : "binance-bahrain";
    if (matches.length > 0 || positionListComplete) holdings[scopedExternalProductAlias(accountId, asset, projectId)] = amount;
  }

  const positions = validPositions.flatMap(({ row, projectId, asset, amount }) => {
    if (amount <= 0) return [];
    const accountId = account === "global" ? "binance-global" : "binance-bahrain";
    return [{
      sourceProductId: scopedExternalProductAlias(accountId, asset, projectId),
      accountId,
      asset: asset as Product["asset"],
      positionId: row.positionId === undefined ? undefined : String(row.positionId),
      amount,
      purchaseAt: timestampIso(row.purchaseTime),
      redeemAt: timestampIso(row.redeemDate),
    }];
  });

  return {
    rates,
    holdings,
    positions,
    productListComplete,
    positionListComplete,
    productApiStatus,
    positionApiStatus,
  };
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
  const accountId = account === "global" ? "binance-global" : "binance-bahrain";
  const identity = buildPlatformProductIdentity({
    accountId,
    asset,
    productType: "fixed",
    externalProductId: projectId,
  });
  const maximum = finiteOptional(quota?.totalPersonalQuota);
  const minimum = finiteOptional(quota?.minimum);
  const rawMaximum = quota?.totalPersonalQuota;
  const maximumStatus: NonNullable<LiveRate["subscriptionMaximumStatus"]> = rawMaximum === undefined
    ? "unlimited"
    : maximum === undefined || (maximum < 0 && maximum !== -1) ? "unreadable"
      : maximum === -1 ? "unlimited" : "limited";
  const capacityAvailable = maximumStatus !== "unreadable";
  return {
    productId: identity.identityKey,
    ...identity,
    name: `Simple Earn Locked · ${formatLockedDuration(duration)}`,
    apr,
    aprStatus: "available",
    capacityStatus: capacityAvailable ? "available" : "unavailable",
    tierStructureStatus: "complete",
    rateShape: "single_rate",
    tiers: [{ min: 0, max: maximum !== undefined && maximum >= 0 ? maximum : null, apr,
      ...(rawMaximum === undefined || maximum === -1 ? { maxStatus: "unlimited" as const } : {}) }],
    subscriptionMaximum: maximum === undefined || maximum === -1 ? null : maximum,
    subscriptionMaximumStatus: maximumStatus,
    subscriptionMaximumSource: rawMaximum === undefined ? "not_returned" : "api",
    fetchedAt,
    sourceLabel: accountConfig.sourceLabel.replace("账户 API", "定期账户 API"),
    productType: "fixed",
    termDays: duration,
    minimumAmount: minimum && minimum > 0 ? minimum : undefined,
    subscriptionStartsAt: timestampIso(detail?.subscriptionStartTime),
    availability: detail?.isSoldOut || /sold.?out|unavailable|off.?line/i.test(detail?.status ?? "") ? "unavailable" : "available",
    rateCoverage: capacityAvailable ? "complete" : "base_only",
    capacitySource: capacityAvailable && rawMaximum !== undefined ? "live" : undefined,
    catalog: {
      accountId,
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
  rawBaseApr: string | number | null | undefined,
  rawTiers: unknown,
): BinanceTierSchedule {
  const baseApr = parseBinanceApr(rawBaseApr);
  const baseAvailable = Number.isFinite(baseApr) && baseApr >= 0;
  const baseOnlyTier = { min: 0, max: null, apr: baseAvailable ? baseApr : 0, maxStatus: "unlimited" as const };
  const singleSchedule = { tiers: [baseOnlyTier], hasReportedTiers: false, complete: baseAvailable,
    aprStatus: baseAvailable ? "available" as const : "unavailable" as const,
    capacityStatus: "available" as const, tierStructureStatus: "complete" as const };
  if (rawTiers === undefined || rawTiers === null) {
    return singleSchedule;
  }
  if (typeof rawTiers !== "object" || Array.isArray(rawTiers)) {
    return { ...singleSchedule, hasReportedTiers: true, complete: false, aprStatus: "unavailable", capacityStatus: "unavailable", tierStructureStatus: "incomplete" };
  }
  const entries = rawTiers && typeof rawTiers === "object" && !Array.isArray(rawTiers)
    ? Object.entries(rawTiers as Record<string, number | string>)
    : [];
  if (entries.length === 0) return singleSchedule;

  // Binance's flexible product fields are two parts of the rate: the latest
  // APR is the base rate, and tierAnnualPercentageRate is an extra reward.
  // Add them while the reward applies, then keep the base rate for amounts
  // beyond the final reward band.
  const parsedBands = entries.map(([label, rawApr]) => ({ bounds: parseTierBounds(label, asset), bonusApr: parseBinanceApr(rawApr) }));
  const finalBonusTiers = parsedBands.flatMap(({ bounds, bonusApr }) => bounds
    ? [{ ...bounds, apr: baseAvailable && Number.isFinite(bonusApr) && bonusApr >= 0 ? baseApr + bonusApr : 0 }]
    : []).sort((left, right) => left.min - right.min);
  const completeBonusBands = finalBonusTiers.length === entries.length
    && finalBonusTiers.length > 0
    && finalBonusTiers[0].min === 0
    && finalBonusTiers.every((tier, index) => index === 0 || finalBonusTiers[index - 1].max === tier.min);
  const tiers = completeBonusBands
    ? [
      ...finalBonusTiers,
      { min: finalBonusTiers[finalBonusTiers.length - 1]!.max!, max: null, apr: baseAvailable ? baseApr : 0, maxStatus: "unlimited" as const },
    ]
    : finalBonusTiers.length > 0 ? finalBonusTiers : [baseOnlyTier];
  const aprAvailable = baseAvailable && parsedBands.every(({ bonusApr }) => Number.isFinite(bonusApr) && bonusApr >= 0);
  const complete = completeBonusBands && aprAvailable;
  return {
    tiers,
    hasReportedTiers: true,
    complete,
    aprStatus: aprAvailable ? "available" : "unavailable",
    capacityStatus: completeBonusBands ? "available" : "unavailable",
    tierStructureStatus: completeBonusBands ? "complete" : "incomplete",
  };
}

function parseBinanceBonusTiers(asset: string, rawTiers: unknown) {
  if (!rawTiers || typeof rawTiers !== "object" || Array.isArray(rawTiers)) return [];
  return Object.entries(rawTiers as Record<string, unknown>).flatMap(([label, rawApr]) => {
    const bounds = parseTierBounds(label, asset);
    const bonusApr = typeof rawApr === "string" || typeof rawApr === "number"
      ? parseBinanceApr(rawApr)
      : Number.NaN;
    return bounds && Number.isFinite(bonusApr)
      ? [{ ...bounds, apr: bonusApr }]
      : [];
  }).sort((left, right) => left.min - right.min);
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

const binancePageSize = 100;
const maxBinancePages = 20;

async function collectBinancePages<Row>(
  path: string,
  firstPage: PageResponse<Row>,
  credentials: Credentials,
  baseParams: Record<string, string | number> = {},
) {
  let shapeComplete = Array.isArray(firstPage.rows);
  const rows = Array.isArray(firstPage.rows) ? [...firstPage.rows] : [];
  let pagesRead = 1;
  const reportedTotal = finiteOptional(firstPage.total);
  const totalPages = reportedTotal === undefined
    ? undefined
    : Math.max(1, Math.ceil(reportedTotal / binancePageSize));
  let current = 1;
  let lastPageSize = rows.length;

  while (current < (totalPages ?? maxBinancePages)
    && (totalPages !== undefined || lastPageSize === binancePageSize)) {
    current += 1;
    let page: PageResponse<Row>;
    try {
      page = await signedGet<PageResponse<Row>>(path, { ...baseParams, current, size: binancePageSize }, credentials);
    } catch {
      // We already received one or more pages, so keep those rows available
      // but never treat the truncated result as an authoritative empty/zero.
      shapeComplete = false;
      break;
    }
    pagesRead += 1;
    const pageShapeValid = Array.isArray(page.rows);
    shapeComplete &&= pageShapeValid;
    const pageRows = pageShapeValid ? page.rows! : [];
    rows.push(...pageRows);
    lastPageSize = pageRows.length;
    if (totalPages === undefined && pageRows.length < binancePageSize) break;
  }

  return {
    rows,
    total: reportedTotal,
    pagesRead,
    complete: shapeComplete && (reportedTotal !== undefined
      ? rows.length >= reportedTotal
      : lastPageSize < binancePageSize),
  };
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

function finiteNumber(value: string | number | null | undefined) {
  return parseExchangeNumber(value) ?? 0;
}

function aggregateSnapshotStatus(statuses: Array<"complete" | "partial" | "error">) {
  if (statuses.length > 0 && statuses.every((status) => status === "error")) return "error" as const;
  return statuses.length > 0 && statuses.every((status) => status === "complete") ? "complete" as const : "partial" as const;
}

function parseStrictFinite(value: unknown) {
  return parseExchangeNumber(value);
}

function normalizeBinanceProductId(value: string | undefined) {
  const productId = value?.trim();
  return productId || undefined;
}

function hasBinanceApr(row: FlexibleProductRow | undefined): row is FlexibleProductRow & {
  latestAnnualPercentageRate: string | number;
} {
  if (!row || row.latestAnnualPercentageRate === undefined || row.latestAnnualPercentageRate === null) return false;
  const apr = parseBinanceApr(row.latestAnnualPercentageRate);
  return Number.isFinite(apr) && apr >= 0;
}

function finiteOptional(value: string | number | null | undefined) {
  return parseExchangeNumber(value);
}

function positiveNumber(value: string | number | null | undefined) {
  const parsed = finiteOptional(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function parseBinanceApr(value: string | number | null | undefined) {
  const explicitPercent = typeof value === "string" && value.trim().endsWith("%");
  const parsed = parseExchangeNumber(value, { allowPercentSuffix: true });
  if (parsed === undefined || parsed < 0) return Number.NaN;
  // Binance normally returns a decimal fraction (for example 0.0673), but
  // percentage-form responses are already percentages.
  return explicitPercent ? parsed : parsed <= 1 ? parsed * 100 : parsed;
}

function timestampIso(value: string | number | null | undefined) {
  const timestamp = finiteOptional(value);
  return timestamp !== undefined && timestamp > 0 ? new Date(timestamp).toISOString() : undefined;
}

function formatLockedDuration(duration: number) {
  return Number.isInteger(duration) ? `${duration} 天` : `${duration.toFixed(2).replace(/\.0+$|(?<=\.[0-9])0+$/, "")} 天`;
}
