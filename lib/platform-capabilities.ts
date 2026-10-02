import type { Asset } from "./domain";

/** How a platform supplies a product or holding field. */
export type PlatformApiMode = "manual" | "public" | "authenticated";
export type CapabilityProductType = "flexible" | "fixed";
export type CapabilityField = "productApi" | "holdingApi";

export const monitoredAssets = ["USDT", "USDC", "USDGO", "BTC"] as const satisfies readonly Asset[];

export type PlatformCapability = {
  accountId: string;
  exchange: AccountRule["exchange"];
  region: AccountRule["region"];
  asset: Asset;
  productType: CapabilityProductType;
  /** Product/APR information. */
  productApi: PlatformApiMode;
  /** Account holding/position information. */
  holdingApi: PlatformApiMode;
};

type AccountRule = {
  accountId: string;
  exchange: "binance" | "bybit" | "bitget" | "okx" | "mexc";
  region: "global" | "bahrain" | "eu" | "philippines" | "uk";
  flexible: Rule;
  fixed: Rule;
};

type Rule = {
  productAssets: readonly Asset[];
  holdingAssets: readonly Asset[];
  productApi: PlatformApiMode;
  holdingApi: PlatformApiMode;
};

const allAssets = monitoredAssets as readonly Asset[];
const none: readonly Asset[] = [];
const manual = (): Rule => ({
  productAssets: none,
  holdingAssets: none,
  productApi: "manual",
  holdingApi: "manual",
});

function rule(
  productAssets: readonly Asset[],
  holdingAssets: readonly Asset[],
  productApi: Exclude<PlatformApiMode, "manual">,
  holdingApi: Exclude<PlatformApiMode, "manual">,
): Rule {
  return { productAssets, holdingAssets, productApi, holdingApi };
}

const accountRules: AccountRule[] = [
  {
    accountId: "binance-global",
    exchange: "binance",
    region: "global",
    flexible: rule(["USDT", "USDC"], ["USDT", "USDC"], "authenticated", "authenticated"),
    fixed: rule(allAssets, allAssets, "authenticated", "authenticated"),
  },
  {
    accountId: "binance-bahrain",
    exchange: "binance",
    region: "bahrain",
    flexible: rule(["USDT", "USDC"], ["USDT", "USDC"], "authenticated", "authenticated"),
    fixed: rule(allAssets, allAssets, "authenticated", "authenticated"),
  },
  {
    accountId: "bybit-global",
    exchange: "bybit",
    region: "global",
    flexible: rule(["USDT", "USDC"], ["USDT", "USDC"], "public", "authenticated"),
    fixed: rule(allAssets, allAssets, "public", "authenticated"),
  },
  {
    accountId: "bybit-eu",
    exchange: "bybit",
    region: "eu",
    flexible: rule(["USDT"], none, "public", "public"),
    fixed: manual(),
  },
  {
    accountId: "bitget-global",
    exchange: "bitget",
    region: "global",
    // Bitget's current verified product/asset responses cover USDT and USDC.
    // USDGO and BTC remain manual until a real product row is confirmed.
    flexible: rule(["USDT", "USDC"], ["USDT", "USDC"], "authenticated", "authenticated"),
    fixed: manual(),
  },
  {
    accountId: "okx-global",
    exchange: "okx",
    region: "global",
    flexible: rule(none, ["USDT", "USDC", "BTC"], "public", "authenticated"),
    fixed: manual(),
  },
  {
    accountId: "mexc-ph",
    exchange: "mexc",
    region: "philippines",
    flexible: manual(),
    fixed: manual(),
  },
  {
    accountId: "mexc-uk",
    exchange: "mexc",
    region: "uk",
    flexible: manual(),
    fixed: manual(),
  },
];

function expandCapabilities(account: AccountRule): PlatformCapability[] {
  return (["flexible", "fixed"] as const).flatMap((productType) => {
    const current = account[productType];
    return monitoredAssets.map((asset) => ({
      accountId: account.accountId,
      exchange: account.exchange,
      region: account.region,
      asset,
      productType,
      productApi: current.productAssets.includes(asset) ? current.productApi : "manual",
      holdingApi: current.holdingAssets.includes(asset) ? current.holdingApi : "manual",
    }));
  });
}

/** Complete platform × asset × product-type matrix used by adapters and tests. */
export const platformCapabilities = accountRules.flatMap(expandCapabilities);

export function platformCapability(accountId: string, productType: CapabilityProductType, asset: Asset) {
  return platformCapabilities.find((entry) => (
    entry.accountId === accountId && entry.productType === productType && entry.asset === asset
  ));
}

/** Return only assets for which the selected adapter field has a real API. */
export function apiAssetsFor(accountId: string, productType: CapabilityProductType, field: CapabilityField) {
  return platformCapabilities
    .filter((entry) => entry.accountId === accountId && entry.productType === productType && entry[field] !== "manual")
    .map((entry) => entry.asset);
}

/** Public product/APR endpoints are useful for the public-rate aggregator. */
export function publicProductAssetsFor(accountId: string, productType: CapabilityProductType) {
  return platformCapabilities
    .filter((entry) => entry.accountId === accountId && entry.productType === productType && entry.productApi === "public")
    .map((entry) => entry.asset);
}
