export type Asset = "USDT" | "USDC" | "USDGO" | "BTC";
type Exchange = "binance" | "bybit" | "bitget" | "okx" | "mexc";
type Region = "global" | "bahrain" | "eu" | "philippines" | "uk";

export type Account = {
  id: string;
  exchange: Exchange;
  region: Region;
  name: string;
  mark: string;
  color: string;
  foreground?: string;
};

type Tier = {
  id: string;
  min: number;
  max: number | null;
  apr: number;
};

type RateSource = {
  kind: "live" | "private" | "manual" | "demo";
  label: string;
  fetchedAt?: string;
};

export type RateCoverage = "complete" | "base_only" | "max_only" | "unavailable";

export type ProductDataSource =
  | { productDataMode: "api"; apiAccess: "public" | "authenticated" }
  | { productDataMode: "manual"; apiAccess?: never };

export type Product = {
  id: string;
  accountId: string;
  exchange: Exchange;
  region: Region;
  asset: Asset;
  name: string;
  holdingDataMode: "api" | "manual";
  productType: "flexible" | "fixed";
  manualKind?: "flexible" | "fixed" | "limited";
  termDays?: number;
  minimumAmount?: number;
  subscriptionEndsAt?: string;
  eligibilityRequired?: boolean;
  eligibilityLabel?: string;
  tiers: Tier[];
  source: RateSource;
  rateCoverage: RateCoverage;
  externalProductId?: string;
  identityKey: string;
  identityFingerprint?: string;
  requiresLiveRate?: boolean;
  manualFields?: {
    termDays?: boolean;
  };
} & ProductDataSource;

export type HoldingMap = Record<string, number>;

type Allocation = Tier & { amount: number };

function allocate(product: Product, holding: number): Allocation[] {
  return product.tiers.map((tier) => {
    const tierCapacity = tier.max === null ? Number.POSITIVE_INFINITY : Math.max(0, tier.max - tier.min);
    const amount = Math.max(0, Math.min(tierCapacity, holding - tier.min));
    return { ...tier, amount };
  });
}

export function effectiveApr(product: Product, holding: number) {
  if (holding <= 0) return 0;
  const earned = allocate(product, holding).reduce((sum, tier) => sum + tier.amount * tier.apr, 0);
  return earned / holding;
}

export function marginalApr(product: Product, holding: number) {
  const tier = product.tiers.find((item) => item.max === null || holding < item.max);
  return tier?.apr ?? 0;
}

export function remainingHighYield(product: Product, holding: number) {
  const firstTier = product.tiers[0];
  if (product.rateCoverage !== "complete" || !firstTier || firstTier.max === null) return 0;
  const capacity = Math.max(0, firstTier.max - firstTier.min);
  const used = Math.max(0, Math.min(capacity, holding - firstTier.min));
  return Math.max(0, capacity - used);
}

export function formatAmount(value: number) {
  if (value !== 0 && Math.abs(value) < 0.01) return value > 0 ? "<0.01" : ">-0.01";
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
