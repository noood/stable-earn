import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("Bybit public flexible APR keeps all product IDs and each complete tier ladder", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        url,
      }),
      readExchangeJson: async (response) => {
        const coin = new URL(response.url).searchParams.get("coin");
        const host = new URL(response.url).hostname;
        if (host === "api.bybit.eu") {
          return { retCode: 0, result: { list: [{ productId: "eu-usdt", coin: "USDT", status: "Available", estimateApr: "1.2%" }] } };
        }
        return {
          retCode: 0,
          result: {
            list: coin === "USDC"
              ? [{
                productId: "2",
                coin,
                status: "Available",
                estimateApr: "2.44%",
                tierAprDetails: [
                  { min: "0", max: "200", estimateApr: "5.44%" },
                  { min: "200", max: "-1", estimateApr: "2.44%" },
                ],
              }]
              : [
                {
                  productId: "1",
                  coin,
                  status: "Available",
                  estimateApr: "2.1%",
                  tierAprDetails: [{ min: "0", max: "-1", estimateApr: "2.1%" }],
                },
                {
                  productId: "3",
                  coin,
                  status: "Available",
                  estimateApr: "4.2%",
                  tierAprDetails: [{ min: "0", max: "500", estimateApr: "4.2%" }],
                },
              ],
          },
        };
      },
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchPublicRateSnapshot } = load("@/lib/live-rates");
  const result = await fetchPublicRateSnapshot();
  const rate = result.rates.find((item) => item.identityKey === "bybit-global:USDC:flexible:2");

  assert.equal(result.failures.length, 0);
  const usdtRates = result.rates.filter((item) => item.identityKey?.startsWith("bybit-global:USDT:flexible:"));
  assert.deepEqual(usdtRates.map((item) => item.identityKey), [
    "bybit-global:USDT:flexible:1",
    "bybit-global:USDT:flexible:3",
  ]);
  assert.deepEqual(usdtRates.map((item) => item.apr), [2.1, 4.2]);
  assert.ok(rate);
  assert.equal(rate.apr, 5.44);
  assert.deepEqual(rate.tiers, [
    { min: 0, max: 200, apr: 5.44 },
    { min: 200, max: null, apr: 2.44 },
  ]);
  assert.equal(rate.capacitySource, "live");
  assert.ok(rate.capacityFetchedAt);
  assert.ok(result.rates.find((item) => item.identityKey === "bybit-eu:USDT:flexible:eu-usdt"));
});

test("Bybit fixed sync emits a sanitized product-to-position ID summary", async () => {
  const diagnostics = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async (response) => new URL(response.url).pathname.endsWith("/fixed-term/product")
        ? {
          retCode: 0,
          result: { list: [
            { productId: "fixed-a", coin: "USDT", duration: "7d", status: "Available", tieredApyList: [{ min: "0", max: "300", apy: "7%" }] },
            { productId: "fixed-b", coin: "USDT", duration: "30d", status: "Available", tieredApyList: [{ min: "0", max: "-1", apy: "4%" }] },
          ] },
        }
        : {
          retCode: 0,
          result: { list: [
            { productId: "fixed-a", coin: "USDT", amount: "12.5", status: "Active" },
            { productId: "fixed-b", coin: "USDT", amount: "34", status: "Active" },
          ] },
        },
    },
    "@/lib/sync-diagnostics": {
      syncDiagnostic: (event, fields) => diagnostics.push({ event, fields }),
    },
  });
  const { fetchBybitShortFixedSnapshots } = load("@/lib/integrations/bybit");

  const result = await fetchBybitShortFixedSnapshots({
    apiKey: "secret-key",
    apiSecret: "secret-value",
    baseUrls: ["https://api.bybit.com"],
  });

  assert.deepEqual(result.rates.map((rate) => rate.externalProductId), ["fixed-a", "fixed-b"]);
  assert.equal(result.holdings["bybit-global:USDT:fixed:fixed-a"], 12.5);
  assert.equal(result.holdings["bybit-global:USDT:fixed:fixed-b"], 34);
  const record = diagnostics.find((entry) => entry.event === "bybit_fixed_rows");
  assert.ok(record);
  assert.deepEqual(record.fields.productRows.map((row) => row.productId), ["fixed-a", "fixed-b"]);
  assert.deepEqual(record.fields.positionRows.map((row) => [row.productId, row.hasPositiveHolding]), [
    ["fixed-a", true],
    ["fixed-b", true],
  ]);
  assert.doesNotMatch(JSON.stringify(record), /12\.5|34|secret-key|secret-value/);
});
