import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("Bitget USDGO capability probe checks products and holdings without returning amounts", async () => {
  const requests = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => {
        requests.push(new URL(url));
        return { ok: true, status: 200, headers: new Headers(), url, text: async () => "" };
      },
      readExchangeText: async (response) => {
        const url = new URL(response.url);
        if (url.pathname.endsWith("/savings/product")) {
          return JSON.stringify({ code: "00000", data: [
            { productId: "usdgo-flex", coin: "USDGO", periodType: "flexible", status: "in_progress", productLevel: "normal", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "6.5" }] },
            { productId: "usdgo-vip", coin: "USDGO", periodType: "flexible", status: "in_progress", productLevel: "VIP", apyList: [{ minStepVal: "0", maxStepVal: "300000", currentApy: "8" }] },
            { productId: "usdgo-fixed", coin: "USDGO", periodType: "fixed", period: "7d", status: "in_progress", productLevel: "normal", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "7" }] },
            { productId: "other-coin", coin: "USDT", periodType: "flexible", status: "in_progress", productLevel: "normal", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "7" }] },
          ] });
        }
        const periodType = new URL(response.url).searchParams.get("periodType");
        return JSON.stringify({ code: "00000", data: { resultList: periodType === "flexible" ? [
          { productId: "usdgo-flex", productCoin: "USDGO", periodType: "flexible", holdAmount: "42.5", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "6.5" }] },
          { productId: "usdc-position", productCoin: "USDC", periodType: "flexible", holdAmount: "1000", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "6" }] },
        ] : [
          { productId: "usdgo-fixed", productCoin: "USDGO", periodType: "fixed", period: "7d", holdAmount: "12", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "7" }] },
        ] } });
      },
      readExchangeJson: async () => ({ code: "00000", data: { serverTime: "1" } }),
      logExchangePayload: () => {},
    },
  });

  const { probeBitgetAsset } = load("@/lib/integrations/bitget");
  const result = await probeBitgetAsset({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }, "USDGO");

  assert.equal(result.productApi.status, "returned");
  assert.equal(result.productApi.rowCount, 3);
  assert.equal(result.productApi.eligibleFlexibleCount, 1);
  assert.deepEqual(result.productApi.rows.map((row) => row.productId), ["usdgo-flex", "usdgo-vip", "usdgo-fixed"]);
  assert.equal(result.productApi.rows[0].eligibleForMonitoring, true);
  assert.equal(result.productApi.rows[1].eligibleForMonitoring, false);
  assert.equal("eligibleForMonitoring" in result.productApi.rows[2], false);
  assert.equal(result.holdingsApi.status, "complete");
  assert.equal(result.holdingsApi.rowCount, 1);
  assert.equal(result.holdingsApi.rows[0].hasPositiveHolding, true);
  assert.equal("holdAmount" in result.holdingsApi.rows[0], false);
  assert.equal(result.fixedHoldingsApi.status, "complete");
  assert.equal(result.fixedHoldingsApi.rowCount, 1);
  assert.equal(result.fixedHoldingsApi.rows[0].period, "7d");
  assert.equal(result.fixedHoldingsApi.rows[0].hasPositiveHolding, true);
  assert.equal("holdAmount" in result.fixedHoldingsApi.rows[0], false);
  assert.equal(requests.filter((url) => url.pathname.endsWith("/savings/assets")).length, 2);
  const productRequest = requests.find((url) => url.pathname.endsWith("/savings/product"));
  assert.equal(productRequest.searchParams.get("coin"), "USDGO");
  assert.equal(productRequest.searchParams.get("filter"), "available_and_held");
  assert.deepEqual(requests.filter((url) => url.pathname.endsWith("/savings/assets")).map((url) => url.searchParams.get("periodType")).sort(), ["fixed", "flexible"]);
});

test("Bitget capability matrix probe fetches one holdings pagination sequence per period for all four assets", async () => {
  const requests = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => {
        requests.push(new URL(url));
        return { ok: true, status: 200, headers: new Headers(), url, text: async () => "" };
      },
      readExchangeText: async (response) => {
        const url = new URL(response.url);
        if (url.pathname.endsWith("/savings/product")) {
          const coin = url.searchParams.get("coin");
          return JSON.stringify({ code: "00000", data: [{ productId: `${coin}-flex`, coin, periodType: "flexible", status: "in_progress", productLevel: "normal", apyList: [] }] });
        }
        return JSON.stringify({ code: "00000", data: { resultList: [], endId: "" } });
      },
      readExchangeJson: async () => ({ code: "00000", data: {} }),
      logExchangePayload: () => {},
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { probeBitgetAssets } = load("@/lib/integrations/bitget");
  const assets = ["USDT", "USDC", "USDGO", "BTC"];
  const result = await probeBitgetAssets({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }, assets);

  assert.deepEqual(result.map((entry) => entry.asset), assets);
  assert.equal(requests.filter((url) => url.pathname.endsWith("/savings/product")).length, 4);
  assert.equal(requests.filter((url) => url.pathname.endsWith("/savings/assets")).length, 2);
  assert.ok(result.every((entry) => entry.holdingsApi.complete));
  assert.ok(result.every((entry) => entry.fixedHoldingsApi.complete));
  assert.deepEqual(requests.filter((url) => url.pathname.endsWith("/savings/assets")).map((url) => url.searchParams.get("periodType")).sort(), ["fixed", "flexible"]);
});
