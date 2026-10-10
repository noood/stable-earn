import type { EligibilityStatus, Product, ProductAvailability, RateCoverage } from "@/lib/domain";
import { buildPlatformProductIdentity } from "@/lib/product-identity";
import { parseExchangeNumber } from "@/lib/exchange-number";
import { syncDiagnostic } from "@/lib/sync-diagnostics";
import { publicProductAssetsFor } from "@/lib/platform-capabilities";
import { fetchBybitFlexibleProductRows, parseBybitFlexibleTiers, scanBybitFixedProducts } from "@/lib/integrations/bybit";

export type LiveRate = {
  productId: string;
  /** A known position can exist even when no product/APR catalogue row exists. */
  productDataMode?: "api" | "manual";
  manualFields?: Product["manualFields"];
  canonicalProductId?: string;
  name?: string;
  apr: number;
  /** Shape of the rate data returned by the product API, for diagnostics. */
  rateShape?: "single_rate" | "tiered_rate" | "no_rate";
  /** Binance flexible base APR, before its optional bonus tiers. */
  baseApr?: number;
  /** Binance flexible bonus APR bands, kept separate from the final APR tiers. */
  bonusTiers?: Array<{ min: number; max: number; apr: number }>;
  tierAprs?: number[];
  tiers?: Array<{ min: number; max: number | null; apr: number; maxStatus?: "unlimited" }>;
  fetchedAt: string;
  sourceLabel: string;
  productType?: "flexible" | "fixed";
  termDays?: number;
  /** Only set for an explicit upstream cancellation, never for null/omission. */
  clearedProductFields?: Array<"termDays" | "subscriptionEndsAt">;
  minimumAmount?: number;
  subscriptionMaximum?: number | null;
  subscriptionMaximumStatus?: "limited" | "unlimited" | "not_returned" | "unreadable";
  subscriptionMaximumSource?: "api" | "not_returned" | "cache";
  subscriptionMaximumFetchedAt?: string;
  productPoolRemaining?: number;
  subscriptionStartsAt?: string;
  subscriptionEndsAt?: string;
  availability?: ProductAvailability;
  eligibilityRequired?: boolean;
  eligibilityLabel?: string;
  eligibilityStatus?: EligibilityStatus;
  rateCoverage?: RateCoverage;
  /** Field validity is separate from completeness of the combined schedule. */
  aprStatus?: "available" | "unavailable";
  capacityStatus?: "available" | "unavailable";
  /** Incomplete row counts or incompatible tier boundaries cannot be spliced. */
  tierStructureStatus?: "complete" | "incomplete";
  /** APR source and timestamp are independent from other product fields. */
  aprSource?: "live" | "cache";
  aprFetchedAt?: string;
  capacitySource?: "live" | "cache";
  capacityFetchedAt?: string;
  externalProductId?: string;
  /** Original upstream ID when a platform reuses it across product variants. */
  sourceProductId?: string;
  /** Prior identity key used only to reuse an existing row during identity repair. */
  legacyIdentityKey?: string;
  identityKey?: string;
  /** Required when an adapter can return a product absent from the compatibility templates. */
  catalog?: {
    accountId: string;
    exchange: Product["exchange"];
    region: Product["region"];
    asset: Product["asset"];
    holdingDataMode: Product["holdingDataMode"];
    apiAccess: "public" | "authenticated";
  };
};

export type ApiFieldNotice = { accountId: string; asset: Product["asset"]; productName: string; externalProductId?: string; fields: string[] };

type BybitEndpoint = {
  platform: "Bybit Global" | "Bybit EU";
  accountId: "bybit-global" | "bybit-eu";
  coin: Product["asset"];
  label: string;
};

type BybitFlexibleRow = {
  productId?: string;
  coin?: string;
  estimateApr?: string | number | null;
  estimateApy?: string | number | null;
  apr?: string | number | null;
  apy?: string | number | null;
  bonusApr?: string | number | null;
  extraApr?: string | number | null;
  tierAprDetails?: Array<{
    min?: string | number | null;
    max?: string | number | null;
    estimateApr?: string | number | null;
    apr?: string | number | null;
    estimateApy?: string | number | null;
    apy?: string | number | null;
  }>;
  maxStakeAmount?: string | number | null;
  status?: string;
  [key: string]: unknown;
};

const bybitEndpointDefinitions: BybitEndpoint[] = (["bybit-global", "bybit-eu"] as const).flatMap((accountId) => (
  publicProductAssetsFor(accountId, "flexible").map((coin) => ({
    platform: accountId === "bybit-eu" ? "Bybit EU" as const : "Bybit Global" as const,
    accountId,
    coin: coin as Product["asset"],
    label: accountId === "bybit-eu" ? "Bybit EU 官方公开 API" : "Bybit Global 官方公开 API",
  }))
));

const bybitEndpoints = bybitEndpointDefinitions.filter((endpoint) => {
  const accountId = endpoint.platform === "Bybit Global" ? "bybit-global" : "bybit-eu";
  return publicProductAssetsFor(accountId, "flexible").includes(endpoint.coin as "USDT" | "USDC" | "USDGO" | "BTC");
});

export async function fetchPublicRateSnapshot() {
  const jobs = [
    ...bybitEndpoints.map((endpoint) => ({ label: `${endpoint.platform} ${endpoint.coin} 公共 APR`, task: fetchBybitRate(endpoint) })),
    ...(publicProductAssetsFor("bybit-eu", "fixed").length
      ? [{ label: "Bybit EU 定期产品/API", task: fetchBybitEuFixedRates() }]
      : []),
  ];
  const settled = await Promise.allSettled(jobs.map((job) => job.task));
  return {
    rates: settled.flatMap((result) => result.status === "fulfilled" ? result.value.rates : []),
    fieldNotices: settled.flatMap((result) => result.status === "fulfilled" ? result.value.fieldNotices : []),
    failures: settled.flatMap((result, index) => result.status === "fulfilled" ? [] : [jobs[index].label]),
    partials: settled.flatMap((result, index) => result.status === "fulfilled" && result.value.partial ? [jobs[index].label] : []),
    empty: settled.flatMap((result, index) => result.status === "fulfilled" && result.value.empty ? [jobs[index].label] : []),
  };
}

async function fetchBybitEuFixedRates(): Promise<{ rates: LiveRate[]; partial: boolean; empty: boolean; fieldNotices: ApiFieldNotice[] }> {
  const productScan = await scanBybitFixedProducts("bybit-eu");
  const products = productScan.rows;
  const rates: LiveRate[] = products.map((row) => {
    const identity = buildPlatformProductIdentity({
      accountId: "bybit-eu",
      asset: row.coin,
      productType: "fixed",
      externalProductId: row.externalProductId,
    });
    const tiers = (row.tiers ?? []).map((tier) => ({ min: tier.min, max: tier.max, apr: tier.apy, ...(tier.maxStatus ? { maxStatus: tier.maxStatus } : {}) }));
    const termDays = bybitDurationDays(row.duration);
    const eligibilityRequired = Boolean(row.isVip || row.specialUserGroupRequired);
    return {
      productId: identity.identityKey,
      ...identity,
      name: `Fixed Saving · ${row.duration}`,
      apr: tiers[0]?.apr ?? 0,
      rateShape: row.rateShape,
      aprStatus: row.aprStatus,
      capacityStatus: row.capacityStatus,
      tierStructureStatus: row.tierStructureStatus,
      tiers,
      fetchedAt: new Date().toISOString(),
      sourceLabel: "Bybit EU 官方公开定期产品 API",
      productType: "fixed",
      ...(termDays !== undefined ? { termDays } : {}),
      minimumAmount: row.minAmount,
      availability: row.status === "Available" ? "available" : "unavailable",
      eligibilityRequired,
      eligibilityLabel: row.isVip ? "VIP 用户" : row.specialUserGroupRequired ? "需满足特殊用户组资格" : undefined,
      eligibilityStatus: eligibilityRequired ? "unknown" : undefined,
      rateCoverage: row.rateCoverage ?? (tiers.length ? "complete" : "unavailable"),
      subscriptionMaximum: row.maxAmount,
      subscriptionMaximumStatus: row.maxAmountStatus,
      subscriptionMaximumSource: row.maxAmountSource,
      catalog: {
        accountId: "bybit-eu",
        exchange: "bybit",
        region: "eu",
        asset: row.coin,
        holdingDataMode: "manual",
        apiAccess: "public",
      },
    };
  });
  return {
    rates,
    fieldNotices: products.flatMap((row) => {
      const fields = [
        ...(row.rateShape === "no_rate" ? ["APR 未获取"] : []),
        ...(row.rateCoverage === "partial" ? ["阶梯结构未获取"] : []),
      ];
      return fields.length ? [{ accountId: "bybit-eu", asset: row.coin, productName: `定期 ${row.duration} · ${row.externalProductId}`, externalProductId: row.externalProductId, fields }] : [];
    }),
    partial: !productScan.complete,
    empty: productScan.complete && products.length === 0,
  };
}

function bybitDurationDays(value: string) {
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([dhm])$/);
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  if (match[2] === "h") return amount / 24;
  if (match[2] === "m") return amount / 1440;
  return amount;
}

export function summarizePublicFailures(failures: string[]) {
  const expectedAssets: Record<string, string[]> = {
    "Bybit Global": publicProductAssetsFor("bybit-global", "flexible"),
    "Bybit EU": publicProductAssetsFor("bybit-eu", "flexible"),
  };
  const grouped = new Map<string, Set<string>>();

  for (const failure of failures) {
    const platform = Object.keys(expectedAssets).find((candidate) => failure.startsWith(candidate));
    if (!platform) continue;
    const assets = grouped.get(platform) ?? new Set<string>();
    for (const asset of expectedAssets[platform]) {
      if (failure.includes(asset)) assets.add(asset);
    }
    grouped.set(platform, assets);
  }

  return [...grouped.entries()].map(([platform, assets]) => (
    assets.size > 0 && assets.size < expectedAssets[platform].length
      ? `${platform} ${expectedAssets[platform].filter((asset) => assets.has(asset)).join("/")}`
      : platform
  ));
}

async function fetchBybitRate(endpoint: BybitEndpoint): Promise<{ rates: LiveRate[]; partial: boolean; empty: boolean; fieldNotices: ApiFieldNotice[] }> {
  const productScan = await fetchBybitFlexibleProductRows(endpoint.accountId, endpoint.coin);
      const candidates = productScan.rows;
      const paginationComplete = productScan.complete;
      if (!paginationComplete && candidates.length === 0) return { rates: [], partial: true, empty: false, fieldNotices: [] };
      if (candidates.length === 0 && paginationComplete) {
        syncDiagnostic("bybit_flexible_rows", { platform: endpoint.platform, coin: endpoint.coin, rowCount: 0, unmappedRowCount: 0, rows: [], includedProducts: [] });
        return { rates: [], partial: false, empty: true, fieldNotices: [] };
      }
      const ratesByProductId = new Map<string, LiveRate>();
      const fetchedAt = new Date().toISOString();
      const scopeMismatchCount = candidates.filter((candidate) => candidate.coin && candidate.coin.toUpperCase() !== endpoint.coin).length;
      const scopedCandidates = candidates.filter((candidate) => !candidate.coin || candidate.coin.toUpperCase() === endpoint.coin);
      const unmappedRowCount = scopedCandidates.filter((candidate) => !candidate.productId?.trim()).length;
      const fieldNotices: ApiFieldNotice[] = [];
      for (const item of scopedCandidates) {
        const externalProductId = item.productId?.trim();
        if (!externalProductId) continue;
        const rawMaximum = parseFiniteAmount(item.maxStakeAmount);
        const productMaximumUnreadable = item.maxStakeAmount !== undefined
          && (rawMaximum === undefined || (rawMaximum !== -1 && rawMaximum <= 0));
        const baseApr = parsePercent(item.estimateApr ?? item.apr ?? item.estimateApy ?? item.apy);
        const tierSchedule = parseBybitFlexibleTiers(item.tierAprDetails, rawMaximum, productMaximumUnreadable);
        const aprAvailable = tierSchedule.hasTiers
          ? tierSchedule.aprStatus === "available"
          : Number.isFinite(baseApr) && baseApr >= 0;
        const capacityAvailable = tierSchedule.hasTiers
          ? tierSchedule.capacityStatus === "available"
          : !productMaximumUnreadable;
        const rateScheduleComplete = aprAvailable && capacityAvailable;
        const productMaximum = rawMaximum !== undefined && rawMaximum > 0 ? rawMaximum : undefined;
        const parsedTiers = tierSchedule.tiers.map((tier) => ({ min: tier.min, max: tier.max, apr: tier.apr ?? tier.apy ?? 0, ...(tier.maxStatus ? { maxStatus: tier.maxStatus } : {}) }));
        const tiers = tierSchedule.hasTiers
          ? productMaximum === undefined
            ? parsedTiers
            : parsedTiers.flatMap((tier) => {
              if (tier.min >= productMaximum) return [];
              const cappedTier = {
                ...tier,
                max: tier.max === null
                  ? tier.maxStatus === "unlimited" ? productMaximum : null
                  : Math.min(tier.max, productMaximum),
              };
              delete cappedTier.maxStatus;
              return [cappedTier];
            })
          : [{ min: 0, max: productMaximum ?? null, apr: aprAvailable ? baseApr : 0,
            ...(productMaximum === undefined && (item.maxStakeAmount === undefined || rawMaximum === -1) ? { maxStatus: "unlimited" as const } : {}) }];
        const apr = tiers[0]?.apr ?? 0;
        const fields = [
          ...(!aprAvailable ? ["APR 未获取"] : []),
          ...(!rateScheduleComplete ? ["阶梯结构未获取"] : []),
          ...(productMaximumUnreadable ? ["额度未获取"] : []),
        ];
        if (fields.length) fieldNotices.push({ accountId: endpoint.accountId, asset: endpoint.coin, productName: `活期 · ${externalProductId}`, externalProductId, fields });
        const identity = buildPlatformProductIdentity({
          accountId: endpoint.accountId,
          asset: endpoint.coin,
          productType: "flexible",
          externalProductId,
        });
        const hasLiveCapacity = tiers.some((tier) => tier.max !== null)
          || (typeof item.remainingPoolAmount !== "undefined" && parseFiniteAmount(item.remainingPoolAmount) !== undefined);
        const subscriptionMaximumStatus: NonNullable<LiveRate["subscriptionMaximumStatus"]> = item.maxStakeAmount === undefined
          ? !tierSchedule.hasTiers ? "unlimited" : "not_returned"
          : rawMaximum === -1 ? "unlimited" : productMaximumUnreadable ? "unreadable" : "limited";
        const rate: LiveRate = {
          productId: identity.identityKey,
          ...identity,
          apr,
          aprStatus: aprAvailable ? "available" : "unavailable",
          capacityStatus: capacityAvailable ? "available" : "unavailable",
          tierStructureStatus: tierSchedule.hasTiers ? tierSchedule.tierStructureStatus : "complete",
          rateShape: tierSchedule.hasTiers ? "tiered_rate" : aprAvailable ? "single_rate" : "no_rate",
          ...(tiers.length > 0 ? { tiers } : {}),
          fetchedAt,
          sourceLabel: endpoint.label,
          availability: item.status === "Available"
            ? "available"
            : item.status
              ? "unavailable"
              : "unknown",
          rateCoverage: !aprAvailable ? "unavailable" : rateScheduleComplete ? "complete" : "partial",
          subscriptionMaximum: rawMaximum === undefined || rawMaximum === -1 ? null : rawMaximum,
          subscriptionMaximumStatus,
          subscriptionMaximumSource: item.maxStakeAmount === undefined ? "not_returned" : "api",
          ...(parseFiniteAmount(item.remainingPoolAmount) !== undefined ? { productPoolRemaining: parseFiniteAmount(item.remainingPoolAmount) } : {}),
          ...(hasLiveCapacity || productMaximum !== undefined ? { capacitySource: "live" as const, capacityFetchedAt: fetchedAt } : {}),
          catalog: {
            accountId: endpoint.accountId,
            exchange: "bybit",
            region: endpoint.platform === "Bybit Global" ? "global" : "eu",
            asset: endpoint.coin as Product["asset"],
            holdingDataMode: endpoint.accountId === "bybit-global" ? "api" : "manual",
            apiAccess: "public",
          },
        };
        const existing = ratesByProductId.get(externalProductId);
        if (!existing || bybitRateScore(rate) > bybitRateScore(existing)) ratesByProductId.set(externalProductId, rate);
      }
      const rates = [...ratesByProductId.values()];
      syncDiagnostic("bybit_flexible_rows", {
        platform: endpoint.platform,
        coin: endpoint.coin,
        rowCount: candidates.length,
        unmappedRowCount,
        scopeMismatchCount,
        rows: candidates.map((candidate) => ({
          productId: candidate.productId ?? null,
          coin: candidate.coin ?? null,
          status: candidate.status ?? null,
          estimateApr: candidate.estimateApr ?? null,
          estimateApy: candidate.estimateApy ?? null,
          apr: candidate.apr ?? null,
          apy: candidate.apy ?? null,
          bonusApr: candidate.bonusApr ?? null,
          extraApr: candidate.extraApr ?? null,
          responseKeys: Object.keys(candidate).sort(),
          rateFields: safeBybitRateFields(candidate),
        })),
        includedProducts: rates.map((rate) => ({
          productId: rate.externalProductId ?? null,
          identityKey: rate.identityKey ?? null,
          apr: rate.apr,
          tierCount: rate.tiers?.length ?? 0,
        })),
      });
  return { rates, fieldNotices, partial: !paginationComplete || scopeMismatchCount > 0 || unmappedRowCount > 0, empty: false };
}

function bybitRateScore(rate: LiveRate) {
  return Number(rate.availability === "available") * 1000
    + (rate.tiers?.length ?? 0)
    + Number(rate.rateCoverage === "complete");
}

function parseFiniteAmount(value: string | number | null | undefined) {
  return parseExchangeNumber(value, { allowThousandsSeparators: true });
}

/**
 * Keep the diagnostic useful for account-specific reward fields without
 * logging a raw upstream response. Only fields whose names describe APR/APY,
 * rewards, or rate tiers are retained; values are bounded and recursively
 * sanitized.
 */
function safeBybitRateFields(candidate: BybitFlexibleRow) {
  return Object.fromEntries(Object.entries(candidate)
    .filter(([key]) => /apr|apy|reward|rate|tier/i.test(key))
    .map(([key, value]) => [key, sanitizeBybitRateValue(value)]));
}

function sanitizeBybitRateValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeBybitRateValue(item, depth + 1));
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => /apr|apy|reward|rate|tier|min|max/i.test(key))
    .slice(0, 30)
    .map(([key, nested]) => [key, sanitizeBybitRateValue(nested, depth + 1)]));
}

function parsePercent(value: string | number | null | undefined) {
  return parseExchangeNumber(value, { allowPercentSuffix: true }) ?? Number.NaN;
}
