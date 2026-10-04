import type { EligibilityStatus, Product, ProductAvailability, RateCoverage } from "@/lib/domain";
import { buildPlatformProductIdentity } from "@/lib/product-identity";
import { syncDiagnostic } from "@/lib/sync-diagnostics";
import { publicProductAssetsFor } from "@/lib/platform-capabilities";
import { fetchBybitFlexibleProductRows, scanBybitFixedProducts } from "@/lib/integrations/bybit";

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
  tierAprs?: number[];
  tiers?: Array<{ min: number; max: number | null; apr: number; maxStatus?: "unlimited" }>;
  fetchedAt: string;
  sourceLabel: string;
  productType?: "flexible" | "fixed";
  termDays?: number;
  minimumAmount?: number;
  subscriptionStartsAt?: string;
  subscriptionEndsAt?: string;
  availability?: ProductAvailability;
  eligibilityRequired?: boolean;
  eligibilityLabel?: string;
  eligibilityStatus?: EligibilityStatus;
  rateCoverage?: RateCoverage;
  capacitySource?: "live" | "cache";
  capacityFetchedAt?: string;
  externalProductId?: string;
  /** Original upstream ID when a platform reuses it across product variants. */
  sourceProductId?: string;
  /** Prior identity key used only to reuse an existing row during identity repair. */
  legacyIdentityKey?: string;
  identityKey?: string;
  identityFingerprint?: string;
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

type BybitEndpoint = {
  platform: "Bybit.com" | "Bybit EU";
  accountId: "bybit-global" | "bybit-eu";
  coin: Product["asset"];
  label: string;
};

type BybitFlexibleRow = {
  productId?: string;
  coin?: string;
  estimateApr?: string | number;
  estimateApy?: string | number;
  apr?: string | number;
  apy?: string | number;
  bonusApr?: string | number;
  extraApr?: string | number;
  tierAprDetails?: Array<{
    min?: string | number | null;
    max?: string | number | null;
    estimateApr?: string | number | null;
    apr?: string | number | null;
  }>;
  status?: string;
  [key: string]: unknown;
};

const bybitEndpointDefinitions: BybitEndpoint[] = (["bybit-global", "bybit-eu"] as const).flatMap((accountId) => (
  publicProductAssetsFor(accountId, "flexible").map((coin) => ({
    platform: accountId === "bybit-eu" ? "Bybit EU" as const : "Bybit.com" as const,
    accountId,
    coin: coin as Product["asset"],
    label: accountId === "bybit-eu" ? "Bybit EU 官方公开 API" : "Bybit 官方公开 API",
  }))
));

const bybitEndpoints = bybitEndpointDefinitions.filter((endpoint) => {
  const accountId = endpoint.platform === "Bybit.com" ? "bybit-global" : "bybit-eu";
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
    failures: settled.flatMap((result, index) => result.status === "fulfilled" ? [] : [jobs[index].label]),
    partials: settled.flatMap((result, index) => result.status === "fulfilled" && result.value.partial ? [jobs[index].label] : []),
    empty: settled.flatMap((result, index) => result.status === "fulfilled" && result.value.empty ? [jobs[index].label] : []),
  };
}

async function fetchBybitEuFixedRates(): Promise<{ rates: LiveRate[]; partial: boolean; empty: boolean }> {
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
      rateCoverage: tiers.length ? "complete" : "unavailable",
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
    partial: !productScan.complete || products.some((row) => row.rateShape === "no_rate" || !bybitDurationDays(row.duration)),
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
    "Bybit.com": publicProductAssetsFor("bybit-global", "flexible"),
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

async function fetchBybitRate(endpoint: BybitEndpoint): Promise<{ rates: LiveRate[]; partial: boolean; empty: boolean }> {
  const productScan = await fetchBybitFlexibleProductRows(endpoint.accountId, endpoint.coin);
      const candidates = productScan.rows;
      const paginationComplete = productScan.complete;
      if (!paginationComplete && candidates.length === 0) return { rates: [], partial: true, empty: false };
      if (candidates.length === 0 && paginationComplete) {
        syncDiagnostic("bybit_flexible_rows", { platform: endpoint.platform, coin: endpoint.coin, rowCount: 0, unmappedRowCount: 0, rows: [], includedProducts: [] });
        return { rates: [], partial: false, empty: true };
      }
      const ratesByProductId = new Map<string, LiveRate>();
      const fetchedAt = new Date().toISOString();
      const scopeMismatchCount = candidates.filter((candidate) => candidate.coin && candidate.coin.toUpperCase() !== endpoint.coin).length;
      const scopedCandidates = candidates.filter((candidate) => !candidate.coin || candidate.coin.toUpperCase() === endpoint.coin);
      const unmappedRowCount = scopedCandidates.filter((candidate) => !candidate.productId?.trim()).length;
      let missingRateCount = 0;
      for (const item of scopedCandidates) {
        const externalProductId = item.productId?.trim();
        if (!externalProductId) continue;
        const baseApr = parsePercent(item.estimateApr);
        const tiers = parseBybitTiers(item.tierAprDetails);
        const apr = tiers[0]?.apr ?? baseApr;
        if (!Number.isFinite(apr)) { missingRateCount += 1; continue; }
        const identity = buildPlatformProductIdentity({
          accountId: endpoint.accountId,
          asset: endpoint.coin,
          productType: "flexible",
          externalProductId,
        });
        const hasLiveCapacity = tiers.some((tier) => tier.max !== null);
        const rate: LiveRate = {
          productId: identity.identityKey,
          ...identity,
          apr,
          rateShape: tiers.length > 0 ? "tiered_rate" : Number.isFinite(baseApr) ? "single_rate" : "no_rate",
          ...(tiers.length > 0 ? { tiers } : {}),
          fetchedAt,
          sourceLabel: endpoint.label,
          availability: item.status === "Available"
            ? "available"
            : item.status
              ? "unavailable"
              : "unknown",
          rateCoverage: tiers.length > 0 ? "complete" : "base_only",
          ...(hasLiveCapacity ? { capacitySource: "live" as const, capacityFetchedAt: fetchedAt } : {}),
          catalog: {
            accountId: endpoint.accountId,
            exchange: "bybit",
            region: endpoint.platform === "Bybit.com" ? "global" : "eu",
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
  return { rates, partial: !paginationComplete || scopeMismatchCount > 0 || unmappedRowCount > 0 || missingRateCount > 0, empty: false };
}

function bybitRateScore(rate: LiveRate) {
  return Number(rate.availability === "available") * 1000
    + (rate.tiers?.length ?? 0)
    + Number(rate.rateCoverage === "complete");
}

function parseBybitTiers(details: BybitFlexibleRow["tierAprDetails"]) {
  return (details ?? []).flatMap((detail) => {
    const min = parseFiniteNumber(detail.min);
    const rawMax = parseFiniteNumber(detail.max);
    const max = rawMax === -1 ? null : rawMax;
    const apr = parsePercentValue(detail.estimateApr ?? detail.apr);
    if (!Number.isFinite(min) || !Number.isFinite(apr)) return [];
    return [{ min, max: max !== null && Number.isFinite(max) && max > min ? max : null, apr,
      ...(rawMax === -1 ? { maxStatus: "unlimited" as const } : {}) }];
  }).sort((left, right) => left.min - right.min);
}

function parsePercentValue(value: string | number | null | undefined) {
  if (typeof value === "number") return value;
  return parsePercent(value ?? undefined);
}

function parseFiniteNumber(value: string | number | null | undefined) {
  if (typeof value === "number") return value;
  const parsed = Number.parseFloat((value ?? "").replaceAll(",", ""));
  return parsed;
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

function parsePercent(value: string | number | undefined) {
  return Number.parseFloat(String(value ?? "").replace("%", ""));
}
