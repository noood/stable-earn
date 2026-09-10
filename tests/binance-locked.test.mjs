import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("Binance locked snapshot maps available products and held positions", async () => {
  const requests = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => {
        const path = new URL(url).pathname;
        requests.push(path);
        return { ok: true, status: 200, headers: new Headers(), path, text: async () => "{}" };
      },
      readExchangeJson: async (response) => {
        const path = response.path;
        if (path.endsWith("/locked/list")) return {
          rows: [{
            projectId: "USDT001",
            detail: { asset: "USDT", apr: "0.0673", duration: 7, status: "PURCHASABLE" },
            quota: { minimum: "10", totalPersonalQuota: "1000" },
          }],
        };
        return { rows: [{ projectId: "USDT001", asset: "USDT", amount: "123.45", duration: 7, apy: "0.0673" }] };
      },
    },
  });
  const { fetchBinanceLockedSnapshot } = load("@/lib/integrations/binance");
  const result = await fetchBinanceLockedSnapshot({ apiKey: "key", apiSecret: "secret" });

  assert.deepEqual(requests.sort(), ["/sapi/v1/simple-earn/locked/list", "/sapi/v1/simple-earn/locked/position"]);
  assert.equal(result.rates.length, 1);
  assert.equal(result.rates[0].productType, "fixed");
  assert.equal(result.rates[0].termDays, 7);
  assert.ok(Math.abs(result.rates[0].apr - 6.73) < 1e-9);
  assert.equal(result.rates[0].tiers[0].min, 0);
  assert.equal(result.rates[0].tiers[0].max, 1000);
  assert.ok(Math.abs(result.rates[0].tiers[0].apr - 6.73) < 1e-9);
  assert.equal(result.holdings["USDT001"], 123.45);
  assert.equal(result.holdings[result.rates[0].productId], 123.45);
});
