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
            { productId: "usdgo-fixed", coin: "USDGO", periodType: "fixed", status: "in_progress", productLevel: "normal", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "7" }] },
            { productId: "other-coin", coin: "USDT", periodType: "flexible", status: "in_progress", productLevel: "normal", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "7" }] },
          ] });
        }
        return JSON.stringify({ code: "00000", data: { resultList: [
          { productId: "usdgo-flex", productCoin: "USDGO", periodType: "flexible", holdAmount: "42.5", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "6.5" }] },
          { productId: "usdc-position", productCoin: "USDC", periodType: "flexible", holdAmount: "1000", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "6" }] },
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
  assert.equal(result.holdingsApi.status, "complete");
  assert.equal(result.holdingsApi.rowCount, 1);
  assert.equal(result.holdingsApi.rows[0].hasPositiveHolding, true);
  assert.equal("holdAmount" in result.holdingsApi.rows[0], false);
  assert.deepEqual(requests.map((url) => url.pathname).sort(), [
    "/api/v2/earn/savings/assets",
    "/api/v2/earn/savings/product",
  ]);
  const productRequest = requests.find((url) => url.pathname.endsWith("/savings/product"));
  assert.equal(productRequest.searchParams.get("coin"), "USDGO");
  assert.equal(productRequest.searchParams.get("filter"), "available_and_held");
});
