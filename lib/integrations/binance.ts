import { exchangeFetch, readExchangeJson } from "@/lib/exchange-fetch";
import { buildPlatformProductIdentity, scopedExternalProductAlias } from "@/lib/product-identity";
import type { LiveRate } from "@/lib/live-rates";
import type { HoldingPosition, Product } from "@/lib/domain";
import { syncDiagnostic } from "@/lib/sync-diagnostics";
import { apiAssetsFor } from "@/lib/platform-capabilities";

type Credentials = {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
};

type FlexibleProductRow = {
  asset?: string;
  latestAnnualPercentageRate?: string | number;
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
  productListsComplete: boolean;
  positionListsComplete: boolean;
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
};

const accounts = {
  global: {
    sourceLabel: "Binance.com 官方账户 API",
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
  allowEmpty = false,
): Promise<BinanceFlexibleSnapshot> {
  const accountConfig = accounts[account];
  const fetchedAt = new Date().toISOString();
  const results = await Promise.all(assets.map(async (asset) => {
    const [productPage, positionPage] = await Promise.all([
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

    const [products, positions] = await Promise.all([
      collectBinancePages("/sapi/v1/simple-earn/flexible/list", productPage, credentials, { asset }),
      collectBinancePages("/sapi/v1/simple-earn/flexible/position", positionPage, credentials, { asset }),
    ]);
    const productRows = products.rows?.filter((row) => row.asset === asset) ?? [];
    const positionRows = positions.rows?.filter((row) => row.asset === asset) ?? [];
    // Sanitized trace for verifying whether one flexible asset maps to
    // multiple upstream products. Keep product/position IDs and amounts only;
    // never emit credentials, signatures, or raw exchange responses.
    syncDiagnostic("binance_flexible_rows", {
      account: account === "global" ? "binance-global" : "binance-bahrain",
      asset,
      productListComplete: products.complete,
      productTotal: products.total ?? null,
      productRowCount: productRows.length,
      productRows: productRows.map((row) => {
        const tiers = parseBinanceTiers(asset, row.latestAnnualPercentageRate, row.tierAnnualPercentageRate);
        const hasApr = hasBinanceApr(row);
        return {
          productId: String(row.productId ?? "").trim() || null,
          asset: row.asset ?? null,
          latestAnnualPercentageRate: row.latestAnnualPercentageRate ?? null,
          rateShape: !hasApr ? "no_rate" : tiers.length > 1 ? "tiered_rate" : "single_rate",
          tierAnnualPercentageRate: tiers,
        };
      }),
      positionListComplete: positions.complete,
      positionTotal: positions.total ?? null,
      positionRowCount: positionRows.length,
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
      const productId = normalizeBinanceProductId(row.productId)
        ?? (productRows.length === 1 ? `flexible-${asset.toLowerCase()}` : undefined);
      if (!productId) {
        unmappedProductRowCount += 1;
        return;
      }
      const existing = productRowsById.get(productId);
      if (!existing || (!hasBinanceApr(existing) && hasBinanceApr(row))) productRowsById.set(productId, row);
    });

    const positionsById = new Map<string, { amount: number; rateRow?: FlexiblePositionRow }>();
    let unmappedPositivePositionCount = 0;
    positionRows.forEach((row) => {
      const productId = normalizeBinanceProductId(row.productId)
        ?? (productRowsById.size === 1
          ? productRowsById.keys().next().value
          : productRowsById.size === 0 && positionRows.length === 1
            ? `flexible-${asset.toLowerCase()}`
            : undefined);
      if (!productId) {
        if (finiteNumber(row.totalAmount) > 0) unmappedPositivePositionCount += 1;
        return;
      }
      const existing = positionsById.get(productId);
      positionsById.set(productId, {
        amount: (existing?.amount ?? 0) + finiteNumber(row.totalAmount),
        rateRow: existing?.rateRow ?? (hasBinanceApr(row) ? row : undefined),
      });
    });

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
      const rateSource = hasBinanceApr(product) ? product : position?.rateRow ?? product;
      const hasApr = hasBinanceApr(rateSource);
      const tiers = hasApr
        ? parseBinanceTiers(asset, rateSource?.latestAnnualPercentageRate, rateSource?.tierAnnualPercentageRate)
        : [];
      const identity = buildPlatformProductIdentity({
        accountId,
        asset,
        productType: "flexible",
        externalProductId,
      });

      rates.push({
        productId: identity.identityKey,
        ...identity,
        apr: tiers[0]?.apr ?? 0,
        rateShape: !hasApr ? "no_rate" : tiers.length > 1 ? "tiered_rate" : "single_rate",
        tiers,
        fetchedAt,
        sourceLabel: product
          ? accountConfig.sourceLabel
          : accountConfig.sourceLabel.replace("账户 API", "账户持仓 API"),
        rateCoverage: hasApr ? "complete" : "unavailable",
        catalog: {
          accountId,
          exchange: "binance" as const,
          region: account,
          asset,
          holdingDataMode: "api" as const,
          apiAccess: "authenticated" as const,
        },
      });
      holdings[identity.identityKey] = position?.amount ?? 0;
    };

    if (rates.length === 0 && !allowEmpty) throw new Error(`Binance returned no ${asset} flexible product`);
    return {
      rates,
      holdings,
      productListComplete: products.complete && unmappedProductRowCount === 0,
      positionListComplete: positions.complete && unmappedPositivePositionCount === 0,
    };
  }));

  return {
    rates: results.flatMap((result) => result.rates),
    holdings: Object.assign({}, ...results.map((result) => result.holdings)),
    productListsComplete: results.every((result) => result.productListComplete),
    positionListsComplete: results.every((result) => result.positionListComplete),
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
  const [productPage, positionPage] = await Promise.all([
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

  const [products, positionsResponse] = await Promise.all([
    collectBinancePages("/sapi/v1/simple-earn/locked/list", productPage, credentials),
    collectBinancePages("/sapi/v1/simple-earn/locked/position", positionPage, credentials),
  ]);
  const productRows = products.rows;
  const positionRows = positionsResponse.rows;
  const fetchedAt = new Date().toISOString();

  // Temporary, sanitized trace for verifying why an expired locked product
  // remains visible. Keep product and position IDs together with only the
  // fields needed for lifecycle decisions; never emit the raw response.
  syncDiagnostic("binance_locked_rows", {
    account,
    productRowCount: productRows.length,
    positionRowCount: positionRows.length,
    productTotal: products.total ?? null,
    positionTotal: positionsResponse.total ?? null,
    productListComplete: products.complete,
    positionListComplete: positionsResponse.complete,
    productRows: productRows.flatMap((row) => {
      const detail = row.detail;
      const asset = String(detail?.asset ?? "").toUpperCase();
      return supported.has(asset) ? [{
        // This is Binance's upstream projectId, not our database product_id.
        externalProjectId: String(row.projectId ?? "").trim() || null,
        asset,
        duration: positiveNumber(detail?.duration),
        apr: parseBinanceApr(detail?.apr ?? detail?.apy ?? detail?.annualPercentageRate ?? detail?.interestRate),
        status: detail?.status ?? null,
        isSoldOut: detail?.isSoldOut ?? null,
      }] : [];
    }),
    positionRows: positionRows.flatMap((row) => {
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
    const accountId = account === "global" ? "binance-global" : "binance-bahrain";
    holdings[scopedExternalProductAlias(accountId, asset, projectId)] = amount;
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
    const accountId = account === "global" ? "binance-global" : "binance-bahrain";
    const alias = scopedExternalProductAlias(accountId, asset, projectId);
    holdings[alias] = (holdings[alias] ?? 0) + finiteNumber(row.amount ?? row.principal);
  }

  const positions = positionRows.flatMap((row) => {
    const projectId = String(row.projectId ?? "").trim();
    const asset = String(row.asset ?? "").toUpperCase() as Product["asset"];
    const amount = finiteNumber(row.amount ?? row.principal);
    if (!projectId || !supported.has(asset) || amount <= 0) return [];
    const accountId = account === "global" ? "binance-global" : "binance-bahrain";
    return [{
      sourceProductId: scopedExternalProductAlias(accountId, asset, projectId),
      accountId,
      asset,
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
    productListComplete: products.complete,
    positionListComplete: positionsResponse.complete,
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
  return {
    productId: identity.identityKey,
    ...identity,
    name: `Simple Earn Locked · ${formatLockedDuration(duration)}`,
    apr,
    rateShape: "single_rate",
    tiers: [{ min: 0, max: maximum && maximum > 0 ? maximum : null, apr }],
    fetchedAt,
    sourceLabel: accountConfig.sourceLabel.replace("账户 API", "定期账户 API"),
    productType: "fixed",
    termDays: duration,
    minimumAmount: minimum && minimum > 0 ? minimum : undefined,
    subscriptionStartsAt: timestampIso(detail?.subscriptionStartTime),
    availability: detail?.isSoldOut || /sold.?out|unavailable|off.?line/i.test(detail?.status ?? "") ? "unavailable" : "available",
    rateCoverage: maximum === undefined ? "base_only" : "complete",
    capacitySource: maximum === undefined ? "cache" : "live",
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
  rawBaseApr: string | number | undefined,
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

const binancePageSize = 100;
const maxBinancePages = 20;

async function collectBinancePages<Row>(
  path: string,
  firstPage: PageResponse<Row>,
  credentials: Credentials,
  baseParams: Record<string, string | number> = {},
) {
  const rows = [...(firstPage.rows ?? [])];
  const reportedTotal = finiteOptional(firstPage.total);
  const totalPages = reportedTotal === undefined
    ? undefined
    : Math.max(1, Math.ceil(reportedTotal / binancePageSize));
  let current = 1;
  let lastPageSize = rows.length;

  while (current < (totalPages ?? maxBinancePages)
    && (totalPages !== undefined || lastPageSize === binancePageSize)) {
    current += 1;
    const page = await signedGet<PageResponse<Row>>(path, { ...baseParams, current, size: binancePageSize }, credentials);
    const pageRows = page.rows ?? [];
    rows.push(...pageRows);
    lastPageSize = pageRows.length;
    if (totalPages === undefined && pageRows.length < binancePageSize) break;
  }

  return {
    rows,
    total: reportedTotal,
    complete: reportedTotal !== undefined
      ? rows.length >= reportedTotal
      : lastPageSize < binancePageSize,
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

function finiteNumber(value: string | number | undefined) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeBinanceProductId(value: string | undefined) {
  const productId = value?.trim();
  return productId || undefined;
}

function hasBinanceApr(row: FlexibleProductRow | undefined): row is FlexibleProductRow & {
  latestAnnualPercentageRate: string | number;
} {
  if (!row || row.latestAnnualPercentageRate === undefined || row.latestAnnualPercentageRate === null) return false;
  const apr = typeof row.latestAnnualPercentageRate === "number"
    ? row.latestAnnualPercentageRate
    : Number.parseFloat(row.latestAnnualPercentageRate);
  return Number.isFinite(apr) && apr >= 0;
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
