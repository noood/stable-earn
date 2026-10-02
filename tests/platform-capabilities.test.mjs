import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("platform capability matrix covers every monitored account, asset, and product type", async () => {
  const load = moduleLoader();
  const { monitoredAssets, platformCapabilities, platformCapability } = load("@/lib/platform-capabilities");
  const { accounts: seedAccounts } = load("@/lib/seed-data");
  const accountIds = [
    "binance-global", "binance-bahrain", "bybit-global", "bybit-eu",
    "bitget-global", "okx-global", "mexc-ph", "mexc-uk",
  ];
  assert.deepEqual(seedAccounts.map((account) => account.id), accountIds);
  assert.equal(platformCapabilities.length, accountIds.length * monitoredAssets.length * 2);
  for (const accountId of accountIds) {
    for (const asset of monitoredAssets) {
      for (const productType of ["flexible", "fixed"]) {
        assert.ok(platformCapability(accountId, productType, asset));
      }
    }
  }
});

test("matrix only marks verified API scopes as automatic", async () => {
  const load = moduleLoader();
  const { apiAssetsFor, publicProductAssetsFor } = load("@/lib/platform-capabilities");

  assert.deepEqual(apiAssetsFor("binance-global", "flexible", "productApi"), ["USDT", "USDC"]);
  assert.deepEqual(apiAssetsFor("binance-global", "fixed", "productApi"), ["USDT", "USDC", "USDGO", "BTC"]);
  assert.deepEqual(apiAssetsFor("bybit-global", "flexible", "holdingApi"), ["USDT", "USDC"]);
  assert.deepEqual(apiAssetsFor("bybit-global", "fixed", "holdingApi"), ["USDT", "USDC", "USDGO", "BTC"]);
  assert.deepEqual(publicProductAssetsFor("bybit-global", "flexible"), ["USDT", "USDC"]);
  assert.deepEqual(publicProductAssetsFor("bybit-eu", "flexible"), ["USDT"]);
  assert.deepEqual(apiAssetsFor("bitget-global", "flexible", "productApi"), ["USDT", "USDC"]);
  assert.deepEqual(apiAssetsFor("okx-global", "flexible", "holdingApi"), ["USDT", "USDC", "BTC"]);
  assert.deepEqual(apiAssetsFor("mexc-ph", "flexible", "productApi"), []);
});
