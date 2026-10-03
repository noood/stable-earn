import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("Binance flexible diagnostic pairs sanitized product IDs with position IDs", async () => {
  const diagnostics = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async (response) => {
        const parsed = new URL(response.url);
        if (parsed.pathname.endsWith("/flexible/list")) {
          return {
            total: 2,
            rows: [
              { productId: "offer-300", asset: "USDT", latestAnnualPercentageRate: "0.0779" },
              { productId: "offer-large", asset: "USDT", latestAnnualPercentageRate: "0.0313" },
            ],
          };
        }
        return {
          total: 2,
          rows: [
            { productId: "offer-300", asset: "USDT", totalAmount: "12.5" },
            { productId: "offer-large", asset: "USDT", totalAmount: "34" },
          ],
        };
      },
    },
    "@/lib/sync-diagnostics": {
      syncDiagnostic: (event, fields) => diagnostics.push({ event, fields }),
    },
  });
  const { fetchBinanceFlexibleSnapshot } = load("@/lib/integrations/binance");

  const snapshot = await fetchBinanceFlexibleSnapshot({ apiKey: "secret-key", apiSecret: "secret-value" }, "global", ["USDT"]);

  assert.deepEqual(snapshot.rates.map((rate) => rate.externalProductId), ["offer-300", "offer-large"]);
  assert.ok(Math.abs(snapshot.rates[0].apr - 7.79) < 1e-9);
  assert.ok(Math.abs(snapshot.rates[1].apr - 3.13) < 1e-9);
  assert.deepEqual(snapshot.holdings, {
    "binance-global:USDT:flexible:offer-300": 12.5,
    "binance-global:USDT:flexible:offer-large": 34,
  });

  const record = diagnostics.find((entry) => entry.event === "binance_flexible_rows");
  assert.ok(record);
  assert.equal(record.fields.account, "binance-global");
  assert.equal(record.fields.productListComplete, true);
  assert.equal(record.fields.positionListComplete, true);
  assert.deepEqual(record.fields.productRows.map((row) => row.productId), ["offer-300", "offer-large"]);
  assert.deepEqual(record.fields.positionRows.map((row) => [row.productId, row.totalAmount]), [
    ["offer-300", 12.5],
    ["offer-large", 34],
  ]);
  assert.doesNotMatch(JSON.stringify(record), /secret-key|secret-value/);
});

test("Bybit flexible diagnostic records position product IDs and amounts", async () => {
  const diagnostics = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async () => ({
        retCode: 0,
        result: {
          list: [
            { productId: "offer-a", coin: "USDT", amount: "8" },
            { productId: "offer-b", coin: "USDT", amount: "21" },
          ],
        },
      }),
    },
    "@/lib/sync-diagnostics": {
      syncDiagnostic: (event, fields) => diagnostics.push({ event, fields }),
    },
  });
  const { fetchBybitFlexibleHoldings } = load("@/lib/integrations/bybit");

  const snapshot = await fetchBybitFlexibleHoldings({
    apiKey: "secret-key",
    apiSecret: "secret-value",
    baseUrls: ["https://api.bybit.com"],
  }, "global", ["USDT"]);

  assert.deepEqual(snapshot.holdings, {
    "bybit-global:USDT:flexible:offer-a": 8,
    "bybit-global:USDT:flexible:offer-b": 21,
  });

  const record = diagnostics.find((entry) => entry.event === "bybit_flexible_position_rows");
  assert.ok(record);
  assert.equal(record.fields.account, "bybit-global");
  assert.deepEqual(record.fields.rows.map((row) => [row.productId, row.amount]), [
    ["offer-a", 8],
    ["offer-b", 21],
  ]);
  assert.doesNotMatch(JSON.stringify(record), /secret-key|secret-value/);
});
