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
  /** An API must explicitly report unlimited capacity; null alone is unknown. */
  maxStatus?: "unlimited";
};

type RateSource = {
  kind: "live" | "private" | "manual" | "demo";
  label: string;
  fetchedAt?: string;
};

export type RateCoverage = "complete" | "base_only" | "max_only" | "unavailable";

/** Result of the latest account-holding synchronization for an API product. */
export type HoldingSyncState = "not_configured" | "synced" | "partial" | "error";

/** Account-level eligibility returned by an authenticated API. */
export type EligibilityStatus = "eligible" | "ineligible" | "unknown";

/** Whether the upstream product can currently accept a new subscription. */
export type ProductAvailability = "available" | "unavailable" | "unknown";

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
  subscriptionStartsAt?: string;
  subscriptionEndsAt?: string;
  availability?: ProductAvailability;
  eligibilityRequired?: boolean;
  eligibilityLabel?: string;
  eligibilityStatus?: EligibilityStatus;
  tiers: Tier[];
  source: RateSource;
  rateCoverage: RateCoverage;
  /** Whether the displayed quota came from the latest response or a known cache. */
  capacitySource?: "live" | "cache";
  capacityFetchedAt?: string;
  externalProductId?: string;
  identityKey: string;
  manualFields?: {
    termDays?: boolean;
  };
} & ProductDataSource;

export type HoldingMap = Record<string, number>;

/** A user-visible change captured by a local preview or a committed sync. */
export type ProductChangeEvent = {
  id: string;
  productId: string;
  type: "rate" | "capacity" | "holding" | "maturity" | "availability";
  title: string;
  before?: string;
  after?: string;
  observedAt: string;
  source: "定时刷新" | "手动刷新" | "每日首次打开" | "手动编辑";
  attention?: boolean;
  readAt?: string;
};

/** A user position normalized from an authenticated exchange response. */
export type HoldingPosition = {
  productId: string;
  /** Retained in cached snapshots so complete account syncs replace only that account's positions. */
  accountId?: string;
  positionId?: string;
  amount: number;
  purchaseAt?: string;
  redeemAt?: string;
  source: "api" | "manual";
  updatedAt: string;
};

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

export function productHasUnknownTierCapacity(product: Product) {
  return product.tiers.some((tier) => tier.max == null && tier.maxStatus !== "unlimited");
}

export function remainingHighYield(product: Product, holding: number, minimumApr = 6) {
  if (product.rateCoverage !== "complete" || productHasUnknownTierCapacity(product)) return 0;
  return product.tiers.reduce((sum, tier) => {
    if (!Number.isFinite(tier.apr) || tier.apr < minimumApr) return sum;
    if (tier.max === null && tier.maxStatus !== "unlimited") return sum;
    const capacity = tier.max === null ? Number.POSITIVE_INFINITY : Math.max(0, tier.max - tier.min);
    const used = Math.max(0, Math.min(capacity, holding - tier.min));
    return sum + Math.max(0, capacity - used);
  }, 0);
}

export function formatAmount(value: number) {
  if (value !== 0 && Math.abs(value) < 0.01) return value > 0 ? "<0.01" : ">-0.01";
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
