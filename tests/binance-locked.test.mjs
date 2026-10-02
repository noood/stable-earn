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
  assert.equal(result.productListComplete, true);
  assert.equal(result.positionListComplete, true);
});

test("Binance locked snapshot fetches past the first page before marking products complete", async () => {
  const requests = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => {
        const parsed = new URL(url);
        requests.push(parsed);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          path: parsed.pathname,
          url,
          text: async () => "{}",
        };
      },
      readExchangeJson: async (response) => {
        const current = Number(new URL(response.url).searchParams.get("current"));
        if (response.path.endsWith("/locked/list")) {
          return current === 1
            ? {
              total: 101,
              rows: Array.from({ length: 100 }, (_, index) => ({
                projectId: `OTHER${index}`,
                detail: { asset: "OTHER", apr: "0.01", duration: 7 },
              })),
            }
            : {
              total: 101,
              rows: [{
                projectId: "USDT001",
                detail: { asset: "USDT", apr: "0.0673", duration: 7 },
                quota: { totalPersonalQuota: "1000" },
              }],
            };
        }
        return { total: 0, rows: [] };
      },
    },
  });
  const { fetchBinanceLockedSnapshot } = load("@/lib/integrations/binance");
  const result = await fetchBinanceLockedSnapshot({ apiKey: "key", apiSecret: "secret" });

  assert.equal(result.productListComplete, true);
  assert.equal(result.rates.length, 1);
  assert.ok(requests.some((request) => request.pathname.endsWith("/locked/list")
    && request.searchParams.get("current") === "2"));
});
