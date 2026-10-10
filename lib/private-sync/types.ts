import type { BinanceFlexibleSnapshot, BinanceLockedSnapshot } from "@/lib/integrations/binance";
import type { HoldingPosition, HoldingSyncState, Product } from "@/lib/domain";
import type { ApiFieldNotice, LiveRate } from "@/lib/live-rates";
import type { ProductIdentityChange } from "@/lib/product-identity";
import type { ProductCatalogSync } from "@/lib/product-catalog";

export type PrivateStatus = "not_configured" | "synced" | "partial" | "error";

export type PrivateResult<T> = { snapshot: T | null; status: PrivateStatus; diagnostic?: string };

export type BinanceAccountSnapshot = Omit<BinanceFlexibleSnapshot, "productApiStatus" | "positionApiStatus"> & {
  sync: { flexible: boolean; locked: boolean };
  apiStatuses: {
    flexibleProducts: "complete" | "partial" | "error";
    flexibleHoldings: "complete" | "partial" | "error";
    fixedProducts: "complete" | "partial" | "error";
    fixedHoldings: "complete" | "partial" | "error";
  };
  positions: BinanceLockedSnapshot["positions"];
  lockedProductListComplete: boolean;
  lockedPositionListComplete: boolean;
};

export type PrivateStatuses = {
  binanceGlobal: PrivateStatus;
  binanceBahrain: PrivateStatus;
  bybitGlobal: PrivateStatus;
  bitget: PrivateStatus;
  okx: PrivateStatus;
};

export type PrivateDiagnostics = Partial<Record<keyof PrivateStatuses, string>>;

export type PrivateProductsPayload = {
  products: Product[];
  rates: LiveRate[];
  rateFallbacks: Record<string, string>;
  holdingUpdates: Record<string, number>;
  holdingSourceIds: string[];
  holdingFallbacks: Record<string, string>;
  holdingSyncStates: Record<string, HoldingSyncState>;
  holdingPositions: HoldingPosition[];
  apiFieldNotices?: ApiFieldNotice[];
  fetchedAt: string;
  partial: boolean;
  note: string;
  failures?: string[];
  fallbackUpdatedAt?: string | null;
  identityChanges?: Record<string, ProductIdentityChange>;
};

export type PrivatePayloadBuild = {
  payload: PrivateProductsPayload;
  catalog: ProductCatalogSync;
  retryable: boolean;
};

export type RefreshOptions = {
  leaseToken?: string;
  trigger?: "scheduled" | "manual" | "daily";
  attempt?: number;
  runId?: string;
  manual?: boolean;
  acceptPartial?: boolean;
  persistFailure?: boolean;
  recordAttempt?: boolean;
};
