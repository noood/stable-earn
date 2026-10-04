import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("Binance flexible complete empty responses remain a successful empty result in routine sync and probes", async () => {
  const requests = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => {
        const parsed = new URL(url);
        requests.push(parsed);
        return { ok: true, status: 200, headers: new Headers(), url };
      },
      readExchangeJson: async () => ({ total: 0, rows: [] }),
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchBinanceFlexibleSnapshot } = load("@/lib/integrations/binance");
  const credentials = { apiKey: "key", apiSecret: "secret" };

  const result = await fetchBinanceFlexibleSnapshot(credentials, "global", ["BTC"]);

  assert.deepEqual(result.rates, []);
  assert.deepEqual(result.holdings, {});
  assert.equal(result.productListsComplete, true);
  assert.equal(result.positionListsComplete, true);
  assert.deepEqual(requests.map((url) => [url.pathname, url.searchParams.get("asset")]).sort(), [
    ["/sapi/v1/simple-earn/flexible/list", "BTC"],
    ["/sapi/v1/simple-earn/flexible/position", "BTC"],
  ].sort());
  const routineResult = await fetchBinanceFlexibleSnapshot(credentials, "global", ["BTC"]);
  assert.deepEqual(routineResult.rates, []);
  assert.deepEqual(routineResult.holdings, {});
  assert.equal(routineResult.productListsComplete, true);
  assert.equal(routineResult.positionListsComplete, true);
});

test("Binance distinguishes a failed endpoint from a complete empty response", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/flexible/list")) throw new Error("network unavailable");
        return { ok: true, status: 200, headers: new Headers(), path };
      },
      readExchangeJson: async () => ({ total: 0, rows: [] }),
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchBinanceFlexibleSnapshot } = load("@/lib/integrations/binance");
  const result = await fetchBinanceFlexibleSnapshot({ apiKey: "key", apiSecret: "secret" }, "global", ["BTC"]);

  assert.equal(result.productApiStatus, "error");
  assert.equal(result.positionApiStatus, "complete");
  assert.equal(result.productListsComplete, false);
  assert.equal(result.positionListsComplete, true);
});

test("Binance marks malformed product data and an interrupted later page as partial", async () => {
  const calls = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => {
        const parsed = new URL(url);
        calls.push(parsed);
        const path = parsed.pathname;
        if (path.endsWith("/flexible/list") && parsed.searchParams.get("current") === "2") {
          throw new Error("later page unavailable");
        }
        return { ok: true, status: 200, headers: new Headers(), path, url };
      },
      readExchangeJson: async (response) => {
        if (response.path.endsWith("/flexible/list")) {
          if (new URL(response.url).searchParams.get("current") === "1") {
            return {
              total: 101,
              rows: Array.from({ length: 100 }, (_, index) => ({
                asset: "BTC", productId: `offer-${index}`, latestAnnualPercentageRate: "0.025",
              })),
            };
          }
          return { total: 1, rows: [{ asset: "BTC", latestAnnualPercentageRate: "0.025" }] };
        }
        return { total: 0, rows: [] };
      },
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchBinanceFlexibleSnapshot } = load("@/lib/integrations/binance");
  const result = await fetchBinanceFlexibleSnapshot({ apiKey: "key", apiSecret: "secret" }, "global", ["BTC"]);

  assert.equal(result.productApiStatus, "partial");
  assert.equal(result.productListsComplete, false);
  assert.equal(result.positionApiStatus, "complete");
  assert.equal(calls.filter((url) => url.pathname.endsWith("/flexible/list")).length, 2);
});

test("a positive Binance holding without APR becomes an editable manual information row", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), path: new URL(url).pathname }),
      readExchangeJson: async (response) => response.path.endsWith("/flexible/list")
        ? { total: 1, rows: [{ asset: "BTC", productId: "offer-no-apr" }] }
        : { total: 1, rows: [{ asset: "BTC", productId: "offer-no-apr", totalAmount: "0.25" }] },
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchBinanceFlexibleSnapshot } = load("@/lib/integrations/binance");
  const result = await fetchBinanceFlexibleSnapshot({ apiKey: "key", apiSecret: "secret" }, "global", ["BTC"]);

  assert.equal(result.productApiStatus, "partial");
  assert.equal(result.positionApiStatus, "complete");
  assert.equal(result.rates.length, 1);
  assert.equal(result.rates[0].productDataMode, "manual");
  assert.equal(result.rates[0].rateCoverage, "unavailable");
  assert.equal(result.holdings[result.rates[0].productId], 0.25);
});
