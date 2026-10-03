import { exchangeFetch, readExchangeJson } from "@/lib/exchange-fetch";
import type { EligibilityStatus, Product, ProductAvailability, RateCoverage } from "@/lib/domain";
import { buildPlatformProductIdentity } from "@/lib/product-identity";
import { syncDiagnostic } from "@/lib/sync-diagnostics";
import { publicProductAssetsFor } from "@/lib/platform-capabilities";

export type LiveRate = {
  productId: string;
  canonicalProductId?: string;
  name?: string;
  apr: number;
  tierAprs?: number[];
  tiers?: Array<{ min: number; max: number | null; apr: number }>;
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
  bases: readonly string[];
  platform: "Bybit.com" | "Bybit EU";
  accountId: "bybit-global" | "bybit-eu";
  coin: string;
  label: string;
};

type BybitFlexibleRow = {
  productId?: string;
  coin?: string;
  estimateApr?: string;
  estimateApy?: string;
  apr?: string;
  apy?: string;
  bonusApr?: string;
  extraApr?: string;
  tierAprDetails?: Array<{
    min?: string | number | null;
    max?: string | number | null;
    estimateApr?: string | number | null;
    apr?: string | number | null;
  }>;
  status?: string;
  [key: string]: unknown;
};

const bybitEndpointDefinitions: BybitEndpoint[] = [
  { bases: ["https://api.bybit.com", "https://api.bytick.com"], platform: "Bybit.com", accountId: "bybit-global", coin: "USDT", label: "Bybit 官方公开 API" },
  { bases: ["https://api.bybit.com", "https://api.bytick.com"], platform: "Bybit.com", accountId: "bybit-global", coin: "USDC", label: "Bybit 官方公开 API" },
  { bases: ["https://api.bybit.eu"], platform: "Bybit EU", accountId: "bybit-eu", coin: "USDT", label: "Bybit EU 官方公开 API" },
];

const bybitEndpoints = bybitEndpointDefinitions.filter((endpoint) => {
  const accountId = endpoint.platform === "Bybit.com" ? "bybit-global" : "bybit-eu";
  return publicProductAssetsFor(accountId, "flexible").includes(endpoint.coin as "USDT" | "USDC" | "USDGO" | "BTC");
});

export async function fetchPublicRateSnapshot() {
  const jobs = [
    ...bybitEndpoints.map((endpoint) => ({ label: `${endpoint.platform} ${endpoint.coin} 公共 APR`, task: fetchBybitRate(endpoint) })),
  ];
  const settled = await Promise.allSettled(jobs.map((job) => job.task));
  return {
    rates: settled.flatMap((result) => result.status === "fulfilled" ? result.value : []),
    failures: settled.flatMap((result, index) => result.status === "fulfilled" ? [] : [jobs[index].label]),
  };
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

async function fetchBybitRate(endpoint: BybitEndpoint): Promise<LiveRate[]> {
  let lastError: unknown;
  for (const base of endpoint.bases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5500);
    try {
      const url = `${base}/v5/earn/product?category=FlexibleSaving&coin=${endpoint.coin}`;
      const response = await exchangeFetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      const body = await readExchangeJson<{
        retCode?: number;
        result?: { list?: BybitFlexibleRow[] };
      }>(response);
      if (!response.ok || body.retCode !== 0) throw new Error(`Bybit returned ${response.status}/${body.retCode ?? "unknown"}`);
      const candidates = body.result?.list ?? [];
      const ratesByProductId = new Map<string, LiveRate>();
      const fetchedAt = new Date().toISOString();
      const unmappedRowCount = candidates.filter((candidate) => !candidate.productId?.trim() && candidates.length > 1).length;
      for (const item of candidates) {
        const externalProductId = item.productId?.trim()
          || (candidates.length === 1 ? `flexible-${endpoint.coin.toLowerCase()}` : undefined);
        if (!externalProductId) continue;
        const baseApr = parsePercent(item.estimateApr);
        const tiers = parseBybitTiers(item.tierAprDetails);
        const apr = tiers[0]?.apr ?? baseApr;
        if (!Number.isFinite(apr)) continue;
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
            holdingDataMode: endpoint.platform === "Bybit.com" ? "api" : "manual",
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
      if (rates.length === 0) throw new Error("Bybit returned no usable flexible product APR");
      return rates;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("Bybit public API unavailable");
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
    return [{ min, max: max !== null && Number.isFinite(max) && max > min ? max : null, apr }];
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

function parsePercent(value: string | undefined) {
  return Number.parseFloat(value?.replace("%", "") ?? "");
}
