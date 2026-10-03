import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function loadProbe() {
  const accountId = (region) => region === "global" ? "binance-global" : "binance-bahrain";
  const load = moduleLoader({
    "@/lib/integrations/binance": {
      fetchBinanceFlexibleSnapshot: async (_credential, region, assets) => {
        const account = accountId(region);
        const rates = assets.map((asset) => ({ externalProductId: `bn-flex-${region}-${asset}`, catalog: { asset } }));
        const holdings = Object.fromEntries(rates.map((rate) => [`api:${account}:${rate.catalog.asset}:flexible:${rate.externalProductId}`, 123.456]));
        return { rates, holdings, productListsComplete: true, positionListsComplete: true };
      },
      fetchBinanceLockedSnapshot: async (_credential, region) => {
        const account = accountId(region);
        const rates = ["USDT", "USDC", "USDGO", "BTC"].map((asset) => ({
          externalProductId: `bn-fixed-${region}-${asset}`,
          catalog: { asset },
        }));
        const positions = rates.map((rate) => ({
          asset: rate.catalog.asset,
          sourceProductId: `api:${account}:${rate.catalog.asset}:${rate.externalProductId}`,
          amount: 99.99,
        }));
        return { rates, positions, productListComplete: true, positionListComplete: true };
      },
    },
    "@/lib/integrations/bitget": {
      probeBitgetAssets: async (_credential, assets) => assets.map((asset) => ({
          asset,
          productApi: {
            status: "returned",
            rowCount: 2,
            eligibleFlexibleCount: 1,
            rows: [
              { productId: `bg-flex-${asset}`, periodType: "flexible", eligibleForMonitoring: true, tiers: [] },
              { productId: `bg-fixed-${asset}`, periodType: "fixed", eligibleForMonitoring: false, tiers: [] },
            ],
          },
          holdingsApi: {
            status: "complete",
            complete: true,
            pageCount: 1,
            rowCount: 1,
            rows: [{ productId: `bg-flex-${asset}`, periodType: "flexible", hasPositiveHolding: true, tiers: [] }],
          },
        })),
    },
    "@/lib/integrations/bybit": {
      bybitGlobalApiBases: ["https://api.bybit.com"],
      probeBybitFlexibleProducts: async (accountId, asset) => asset === "USDGO"
        ? []
        : [{ productId: `by-flex-${accountId}-${asset}`, status: "Available", tierCount: 1 }],
      fetchBybitFlexibleHoldings: async (_credential, account, assets) => {
        const accountId = account === "eu" ? "bybit-eu" : "bybit-global";
        return {
          holdings: Object.fromEntries(assets.map((asset) => [`${accountId}:${asset}:flexible:by-flex-${asset}`, 45.67])),
          sync: { successfulAssets: assets, failedAssets: [] },
        };
      },
      fetchBybitShortFixedSnapshots: async () => ({
        rates: ["USDT", "USDC", "USDGO", "BTC"].map((asset) => ({
          externalProductId: `by-fixed-${asset}`,
          catalog: { asset },
        })),
        holdings: Object.fromEntries(["USDT", "USDC", "USDGO", "BTC"].map((asset) => [`bybit-global:${asset}:fixed:by-fixed-${asset}`, 10.25])),
        sync: { products: true, holdings: true },
      }),
    },
    "@/lib/integrations/okx": {
      fetchOkxSavingsHoldings: async () => ({ holdings: { "okx-usdt": 0 }, observedAssets: ["USDT", "USDGO"] }),
    },
    "@/lib/live-rates": {
      fetchPublicRateSnapshot: async () => ({
        rates: ["USDT", "USDC", "USDT"].map((asset, index) => ({
          externalProductId: `by-public-${index}`,
          productType: "flexible",
          catalog: { accountId: index === 2 ? "bybit-eu" : "bybit-global", asset },
        })),
        failures: [],
      }),
    },
  });
  return load("@/lib/platform-capability-probe").probePlatformCapabilities;
}

test("capability probe returns all scopes without exposing holding amounts or credentials", async () => {
  const probe = loadProbe();
  const credentials = Object.fromEntries([
    "binance-global", "binance-bahrain", "bybit-global", "bybit-eu", "bitget-global", "okx-global",
  ].map((accountId) => [accountId, { apiKey: "secret-key", apiSecret: "secret-value", passphrase: "secret-pass" }]));

  const result = await probe(credentials);
  const json = JSON.stringify(result);
  assert.equal(result.dataChangesCommitted, false);
  assert.equal(result.includesHoldingAmounts, false);
  assert.equal(result.checkedScopeCount, 64);
  assert.equal(result.scopes.length, 64);
  assert.equal(json.includes("secret-key"), false);
  assert.equal(json.includes("secret-value"), false);
  assert.equal(json.includes("123.456"), false);
  assert.equal(json.includes("99.99"), false);
  assert.equal(json.includes("45.67"), false);

  const scope = (accountId, asset, productType) => result.scopes.find((entry) => (
    entry.accountId === accountId && entry.asset === asset && entry.productType === productType
  ));
  assert.deepEqual(scope("binance-global", "USDT", "flexible").idMatch.matchedIds, ["bn-flex-global-USDT"]);
  assert.equal(scope("binance-global", "BTC", "flexible").productApi.status, "returned");
  assert.equal(scope("bybit-global", "USDGO", "flexible").productApi.status, "empty");
  assert.equal(scope("bybit-global", "USDGO", "flexible").holdingApi.status, "returned");
  assert.equal(scope("bybit-eu", "USDC", "flexible").productApi.status, "returned");
  assert.equal(scope("bybit-eu", "USDC", "flexible").holdingApi.status, "returned");
  assert.equal(scope("bitget-global", "BTC", "flexible").productApi.status, "returned");
  assert.equal(scope("bitget-global", "BTC", "flexible").holdingApi.status, "returned");
  assert.equal(scope("bitget-global", "USDT", "fixed").productApi.status, "returned");
  assert.equal(scope("bitget-global", "USDT", "fixed").holdingApi.status, "not_integrated");
  assert.equal(scope("okx-global", "USDGO", "flexible").holdingApi.status, "returned");
  assert.equal(scope("mexc-ph", "USDT", "flexible").productApi.status, "not_integrated");

  const withoutCredentials = await probe({});
  const euHoldingScope = withoutCredentials.scopes.find((entry) => (
    entry.accountId === "bybit-eu" && entry.asset === "USDC" && entry.productType === "flexible"
  ));
  assert.equal(euHoldingScope.holdingApi.status, "not_configured");
  assert.match(euHoldingScope.holdingApi.note, /只读 API 凭证/);
});
