import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function loadProbe() {
  const accountId = (region) => region === "global" ? "binance-global" : "binance-bahrain";
  const load = moduleLoader({
    "@/lib/integrations/binance": {
      fetchBinanceFlexibleSnapshot: async (_credential, region, assets) => {
        const account = accountId(region);
        const rates = assets.map((asset) => ({
          externalProductId: `bn-flex-${region}-${asset}`,
          apr: 6.4,
          rateShape: "tiered_rate",
          tiers: [{ min: 0, max: 300, apr: 6.4 }, { min: 300, max: null, apr: 3.1 }],
          minimumAmount: 1,
          catalog: { asset },
        }));
        const holdings = Object.fromEntries(rates.map((rate) => [`api:${account}:${rate.catalog.asset}:flexible:${rate.externalProductId}`, 123.456]));
        return { rates, holdings, productListsComplete: true, positionListsComplete: true };
      },
      fetchBinanceLockedSnapshot: async (_credential, region) => {
        const account = accountId(region);
        const rates = ["USDT", "USDC", "USDGO", "BTC"].map((asset) => ({
          externalProductId: `bn-fixed-${region}-${asset}`,
          apr: 3.2,
          rateShape: "single_rate",
          tiers: [{ min: 0, max: 5000, apr: 3.2 }],
          minimumAmount: 10,
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
              { productId: `bg-flex-${asset}`, periodType: "flexible", eligibleForMonitoring: true, tiers: [{ min: 0, max: 300, apr: 7.79 }, { min: 300, max: null, apr: 3.13 }] },
              { productId: `bg-fixed-${asset}`, periodType: "fixed", period: "7d", eligibleForMonitoring: false, tiers: [{ min: 0, max: 5000, apr: 2.5 }] },
            ],
          },
          holdingsApi: {
            status: "complete",
            complete: true,
            pageCount: 1,
            rowCount: 1,
            rows: [{ productId: `bg-flex-${asset}`, periodType: "flexible", hasPositiveHolding: true, tiers: [] }],
          },
          fixedHoldingsApi: {
            status: "complete",
            complete: true,
            pageCount: 1,
            rowCount: 1,
            rows: [{ productId: `bg-fixed-${asset}`, periodType: "fixed", period: "7d", hasPositiveHolding: true, tiers: [] }],
          },
        })),
    },
    "@/lib/integrations/bybit": {
      bybitGlobalApiBases: ["https://api.bybit.com"],
      probeBybitFlexibleProducts: async (accountId, asset) => asset === "USDGO"
        ? []
        : [{
          productId: `by-flex-${accountId}-${asset}`,
          status: "Available",
          tierCount: accountId === "bybit-eu" && asset === "USDC" ? 0 : 1,
          rateShape: accountId === "bybit-eu" && asset === "USDC" ? "single_rate" : accountId === "bybit-eu" && asset === "BTC" ? "no_rate" : "tiered_rate",
          ...(accountId === "bybit-eu" && asset === "BTC" ? {} : { apr: 1.4 }),
          tiers: accountId === "bybit-eu" && asset === "USDC" ? [] : [{ min: 0, max: 1000, apr: 1.4 }],
        }],
      probeBybitFixedProducts: async (accountId) => accountId === "bybit-eu"
        ? [{ externalProductId: "eu-fixed-1@90d", coin: "USDC", duration: "90d", status: "Available", tierCount: 1, apy: 4.1, rateShape: "tiered_rate", tiers: [{ min: 0, max: 10000, apy: 4.1 }], isVip: false, specialUserGroupRequired: false }]
        : [],
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
          apr: 3.4,
          rateShape: "single_rate",
          tiers: [{ min: 0, max: 1000, apr: 3.4 }],
          catalog: { asset },
        })),
        holdings: Object.fromEntries(["USDT", "USDC", "USDGO", "BTC"].map((asset) => [`bybit-global:${asset}:fixed:by-fixed-${asset}`, 10.25])),
        sync: { products: true, holdings: true },
      }),
      probeBybitFixedHoldings: async () => [{ productId: "eu-fixed-1", coin: "USDC", duration: "90d", status: "InProgress", hasPositiveHolding: true }],
    },
    "@/lib/integrations/okx": {
      fetchOkxSavingsHoldings: async () => ({ holdings: { "okx-usdt": 0 }, observedAssets: ["USDT", "USDGO"] }),
      fetchOkxOnchainOffers: async () => ({ byAsset: {
        USDT: { rowCount: 1, rows: [{ id: "offer-1", asset: "USDT", protocol: "Example Staking", protocolType: "staking", status: "available", term: "0", apy: "4.2" }] },
        USDC: { rowCount: 0, rows: [] }, USDGO: { rowCount: 0, rows: [] }, BTC: { rowCount: 0, rows: [] },
      } }),
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
  return load("@/lib/platform-capability-probe");
}

test("capability probe returns all scopes without exposing holding amounts or credentials", async () => {
  const { probePlatformCapabilities: probe } = loadProbe();
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
  assert.equal(json.includes("On-chain Earn offers"), true);

  const scope = (accountId, asset, productType) => result.scopes.find((entry) => (
    entry.accountId === accountId && entry.asset === asset && entry.productType === productType
  ));
  assert.deepEqual(scope("binance-global", "USDT", "flexible").idMatch.matchedIds, ["bn-flex-global-USDT"]);
  assert.equal(scope("binance-global", "BTC", "flexible").productApi.status, "returned");
  assert.equal(scope("binance-global", "USDT", "flexible").productApi.rows[0].rateShape, "tiered_rate");
  assert.equal(scope("binance-global", "USDT", "flexible").productApi.rows[0].tierCount, 2);
  assert.equal(scope("binance-global", "USDT", "flexible").productApi.rateSummary.tieredRateRows, 1);
  assert.equal(scope("binance-global", "USDT", "fixed").productApi.rows[0].rateShape, "single_rate");
  assert.equal(scope("bybit-global", "USDGO", "flexible").productApi.status, "empty");
  assert.equal(scope("bybit-global", "USDGO", "flexible").holdingApi.status, "returned");
  assert.equal(scope("bybit-eu", "USDC", "flexible").productApi.status, "returned");
  assert.equal(scope("bybit-eu", "USDC", "flexible").productApi.rows[0].tierCount, 0);
  assert.equal(scope("bybit-eu", "USDC", "flexible").productApi.rows[0].rateShape, "single_rate");
  assert.equal(scope("bybit-eu", "USDC", "flexible").productApi.rateSummary.singleRateRows, 1);
  assert.equal(scope("bybit-eu", "BTC", "flexible").productApi.status, "returned");
  assert.equal(scope("bybit-eu", "BTC", "flexible").productApi.rows[0].rateShape, "no_rate");
  assert.equal(scope("bybit-eu", "BTC", "flexible").productApi.rateSummary.noRateRows, 1);
  assert.equal(scope("bybit-eu", "USDC", "flexible").holdingApi.status, "returned");
  assert.equal(scope("bybit-eu", "USDC", "fixed").productApi.status, "returned");
  assert.equal(scope("bybit-eu", "USDC", "fixed").productApi.rows[0].rateShape, "tiered_rate");
  assert.equal(scope("bybit-global", "USDT", "fixed").productApi.rows[0].rateShape, "single_rate");
  assert.equal(scope("bybit-eu", "USDC", "fixed").holdingApi.status, "returned");
  assert.deepEqual(scope("bybit-eu", "USDC", "fixed").idMatch.matchedIds, ["eu-fixed-1@90d"]);
  assert.equal(scope("bitget-global", "BTC", "flexible").productApi.status, "returned");
  assert.equal(scope("bitget-global", "BTC", "flexible").holdingApi.status, "returned");
  assert.equal(scope("bitget-global", "USDT", "fixed").productApi.status, "returned");
  assert.equal(scope("bitget-global", "USDT", "flexible").productApi.rows[0].rateShape, "tiered_rate");
  assert.equal(scope("bitget-global", "USDT", "flexible").productApi.rows[0].tierCount, 2);
  assert.equal("apy" in scope("bitget-global", "USDT", "flexible").productApi.rows[0], false);
  assert.equal(scope("bitget-global", "USDT", "fixed").holdingApi.status, "returned");
  assert.equal(scope("bitget-global", "USDT", "fixed").holdingApi.rows[0].period, "7d");
  assert.equal(scope("okx-global", "USDGO", "flexible").holdingApi.status, "returned");
  assert.equal(scope("okx-global", "USDT", "flexible").productApi.status, "not_integrated");
  const okxOffers = result.additionalProbes.find((entry) => entry.id === "okx-onchain-earn-offers");
  assert.equal(okxOffers.assets.find((entry) => entry.asset === "USDT").status, "returned");
  assert.equal(okxOffers.assets.find((entry) => entry.asset === "USDT").rows[0].apy, "4.2");
  assert.equal(okxOffers.assets.find((entry) => entry.asset === "USDC").status, "empty");
  assert.match(okxOffers.note, /不代表普通活期\/定期/);
  assert.equal(scope("mexc-ph", "USDT", "flexible").productApi.status, "not_integrated");

  const withoutCredentials = await probe({});
  const euHoldingScope = withoutCredentials.scopes.find((entry) => (
    entry.accountId === "bybit-eu" && entry.asset === "USDC" && entry.productType === "flexible"
  ));
  assert.equal(euHoldingScope.holdingApi.status, "not_configured");
  assert.match(euHoldingScope.holdingApi.note, /只读 API 凭证/);
  assert.equal(withoutCredentials.scopes.find((entry) => entry.accountId === "bybit-eu" && entry.asset === "USDC" && entry.productType === "fixed").holdingApi.status, "not_configured");
  const okxOffersWithoutCredential = withoutCredentials.additionalProbes.find((entry) => entry.id === "okx-onchain-earn-offers");
  assert.equal(okxOffersWithoutCredential.assets.every((entry) => entry.status === "not_configured"), true);
});

test("capability report groups safe upstream failure details without exposing response text", () => {
  const { summarizePlatformApiFailures } = loadProbe();
  const failures = summarizePlatformApiFailures([
    {
      event: "exchange_http",
      requestId: "request-1",
      platform: "binance-global",
      host: "api.binance.com",
      endpoint: "/sapi/v1/simple-earn/flexible/list",
      asset: "USDT",
      requestAttempt: 1,
      httpStatus: 403,
      apiKey: "do-not-include-this",
    },
    {
      event: "exchange_payload",
      requestId: "request-1",
      httpStatus: 403,
      apiCode: "-2015",
      accessReason: "ip_not_allowed",
      rawResponse: "private upstream response",
    },
    {
      event: "exchange_http",
      requestId: "request-2",
      host: "api.bybit.eu",
      endpoint: "/v5/earn/product",
      asset: "USDC",
      outcome: "timeout_or_abort",
    },
    {
      event: "exchange_http",
      requestId: "successful-request",
      platform: "bitget-global",
      host: "api.bitget.com",
      endpoint: "/api/v2/earn/savings/product",
      httpStatus: 200,
    },
  ]);

  assert.deepEqual(failures, [
    {
      accountId: "binance-global",
      host: "api.binance.com",
      endpoint: "/sapi/v1/simple-earn/flexible/list",
      asset: "USDT",
      reason: "ip_not_allowed",
      httpStatus: 403,
      apiCode: "-2015",
      accessReason: "ip_not_allowed",
      requestCount: 1,
    },
    {
      accountId: "bybit-eu",
      host: "api.bybit.eu",
      endpoint: "/v5/earn/product",
      asset: "USDC",
      reason: "timeout_or_abort",
      requestCount: 1,
    },
  ]);
  const json = JSON.stringify(failures);
  assert.equal(json.includes("do-not-include-this"), false);
  assert.equal(json.includes("private upstream response"), false);
  assert.equal(json.includes("request-1"), false);
});
