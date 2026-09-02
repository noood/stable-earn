import { exchangeFetch } from "@/lib/exchange-fetch";
import type { Product, RateCoverage } from "@/lib/domain";
import { buildProductIdentity } from "@/lib/product-identity";

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
  subscriptionEndsAt?: string;
  eligibilityRequired?: boolean;
  eligibilityLabel?: string;
  rateCoverage?: RateCoverage;
  externalProductId?: string;
  identityKey?: string;
  identityFingerprint?: string;
  /** Required when an adapter can return a product absent from seed-data. */
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
  productId: string;
  coin: string;
  label: string;
};

const bybitEndpoints: BybitEndpoint[] = [
  { bases: ["https://api.bybit.com", "https://api.bytick.com"], platform: "Bybit.com", productId: "by-g-usdc", coin: "USDC", label: "Bybit 官方公开 API" },
  { bases: ["https://api.bybit.eu"], platform: "Bybit EU", productId: "by-eu-usdt", coin: "USDT", label: "Bybit EU 官方公开 API" },
];

export async function fetchPublicRateSnapshot() {
  const jobs = [
    ...bybitEndpoints.map((endpoint) => ({ label: `${endpoint.platform} ${endpoint.coin} 公共 APR`, task: fetchBybitRate(endpoint) })),
  ];
  const settled = await Promise.allSettled(jobs.map((job) => job.task));
  return {
    rates: settled.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []),
    failures: settled.flatMap((result, index) => result.status === "fulfilled" && result.value ? [] : [jobs[index].label]),
  };
}

export function summarizePublicFailures(failures: string[]) {
  const expectedAssets: Record<string, string[]> = {
    "Bybit.com": ["USDT", "USDC"],
    "Bybit EU": ["USDT", "USDC"],
    OKX: ["USDT", "USDC", "BTC"],
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

async function fetchBybitRate(endpoint: BybitEndpoint): Promise<LiveRate | null> {
  let lastError: unknown;
  for (const base of endpoint.bases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5500);
    try {
      const url = `${base}/v5/earn/product?category=FlexibleSaving&coin=${endpoint.coin}`;
      const response = await exchangeFetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      const body = await response.json() as {
        retCode?: number;
        result?: { list?: Array<{ productId?: string; estimateApr?: string; status?: string }> };
      };
      if (!response.ok || body.retCode !== 0) throw new Error(`Bybit returned ${response.status}/${body.retCode ?? "unknown"}`);
      const item = body.result?.list?.find((candidate) => candidate.status === "Available") ?? body.result?.list?.[0];
      const baseApr = parsePercent(item?.estimateApr);
      if (!Number.isFinite(baseApr)) throw new Error("Bybit returned no APR");
      const externalProductId = item?.productId;
      return {
        productId: endpoint.productId,
        ...buildProductIdentity(endpoint.productId, { productType: "flexible" }, { externalProductId, includeExternalProductId: true }),
        apr: baseApr,
        fetchedAt: new Date().toISOString(),
        sourceLabel: endpoint.label,
        catalog: {
          accountId: endpoint.platform === "Bybit.com" ? "bybit-global" : "bybit-eu",
          exchange: "bybit",
          region: endpoint.platform === "Bybit.com" ? "global" : "eu",
          asset: endpoint.coin as Product["asset"],
          holdingDataMode: endpoint.platform === "Bybit.com" ? "api" : "manual",
          apiAccess: "public",
        },
      };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("Bybit public API unavailable");
}

function parsePercent(value: string | undefined) {
  return Number.parseFloat(value?.replace("%", "") ?? "");
}
