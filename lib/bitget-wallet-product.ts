import type { LiveRate } from "./live-rates";
import { BGW_ACCOUNT_ID, BGW_IDENTITY_KEY, BGW_CHAIN_ID, BGW_VAULT_ADDRESS } from "./integrations/bitget-wallet";

/** Product terms are user-maintained; RPC supplies the holding independently. */
export function bitgetWalletRate(): LiveRate {
  return {
    productId: BGW_IDENTITY_KEY,
    identityKey: BGW_IDENTITY_KEY,
    externalProductId: `${BGW_CHAIN_ID}:${BGW_VAULT_ADDRESS}`,
    name: "Gauntlet USDC",
    productType: "flexible",
    productTypeStatus: "known",
    productDataMode: "manual",
    apr: 0,
    tiers: [{ min: 0, max: null, apr: 0 }],
    rateCoverage: "unavailable",
    aprStatus: "unavailable",
    rateShape: "no_rate",
    capacityStatus: "unavailable",
    tierStructureStatus: "complete",
    availability: "unknown",
    fetchedAt: new Date().toISOString(),
    sourceLabel: "整体 APR 由用户填写",
    catalog: { accountId: BGW_ACCOUNT_ID, exchange: "bitget-wallet", region: "morph", asset: "USDC", holdingDataMode: "api", apiAccess: "public" },
  };
}
