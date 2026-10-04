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
              }, {
                productId: "unknown-cap",
                coin,
                status: "Available",
                tierAprDetails: [{ min: "0", estimateApr: "7%" }],
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
    { min: 200, max: null, apr: 2.44, maxStatus: "unlimited" },
  ]);
  const unknown = result.rates.find((item) => item.externalProductId === "unknown-cap");
  assert.deepEqual(unknown?.tiers, [{ min: 0, max: null, apr: 7 }]);
  assert.equal(rate.capacitySource, "live");
  assert.ok(rate.capacityFetchedAt);
  assert.ok(result.rates.find((item) => item.identityKey === "bybit-eu:USDT:flexible:eu-usdt"));
});

test("Bybit EU fixed product probe checks the public endpoint once and distinguishes reused IDs by duration", async () => {
  const requests = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => {
        requests.push(new URL(url));
        return { ok: true, status: 200, headers: new Headers(), url };
      },
      readExchangeJson: async () => ({
        retCode: 0,
        result: { list: [
          { productId: "same-id", coin: "USDT", duration: "7d", status: "Available", tieredApyList: [{ min: "0", max: "100", apy: "7%" }] },
          { productId: "same-id", coin: "USDT", duration: "90d", status: "Available", tieredApyList: [{ min: "0", max: "-1", apy: "4%" }] },
          { productId: "usdgo-id", coin: "USDGO", duration: "30d", status: "Available", tieredApyList: [] },
        ] },
      }),
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { probeBybitFixedProducts } = load("@/lib/integrations/bybit");

  const rows = await probeBybitFixedProducts("bybit-eu");

  assert.deepEqual(rows.map((row) => row.externalProductId), ["same-id@7d", "same-id@90d", "usdgo-id@30d"]);
  assert.deepEqual(requests.map((url) => [url.hostname, url.pathname]), [
    ["api.bybit.eu", "/v5/earn/fixed-term/product"],
  ]);
  assert.equal(rows[0].tierCount, 1);
  assert.equal(rows[0].apy, 7);
  assert.deepEqual(rows[0].tiers, [{ min: 0, max: 100, apy: 7 }]);
  assert.deepEqual(rows[1].tiers, [{ min: 0, max: null, apy: 4, maxStatus: "unlimited" }]);
  assert.equal(JSON.stringify(rows).includes("7%"), false);
});

test("Bybit flexible public scan follows advertised cursors and keeps later-page products", async () => {
  const requests = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => {
        requests.push(new URL(url));
        return { ok: true, status: 200, headers: new Headers(), url };
      },
      readExchangeJson: async (response) => {
        const url = new URL(response.url);
        const coin = url.searchParams.get("coin");
        if (coin === "USDT" && !url.searchParams.has("cursor")) {
          return { retCode: 0, result: { list: [{ productId: "first", coin, status: "Available", estimateApr: "1%" }], nextPageCursor: "page-2" } };
        }
        if (coin === "USDT") {
          return { retCode: 0, result: { list: [{ productId: "second", coin, status: "Available", estimateApr: "2%" }] } };
        }
        return { retCode: 0, result: { list: [] } };
      },
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchPublicRateSnapshot } = load("@/lib/live-rates");
  const result = await fetchPublicRateSnapshot();
  const usdt = result.rates.filter((rate) => rate.identityKey?.startsWith("bybit-global:USDT:flexible:"));

  assert.deepEqual(usdt.map((rate) => rate.externalProductId), ["first", "second"]);
  assert.equal(result.partials.some((entry) => entry.includes("USDT")), false);
  assert.equal(requests.some((url) => url.searchParams.get("cursor") === "page-2"), true);
});

test("Bybit repeated cursor marks product result partial instead of accepting a truncated list", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async (response) => {
        const url = new URL(response.url);
        if (url.searchParams.get("coin") !== "USDT") return { retCode: 0, result: { list: [] } };
        return { retCode: 0, result: { list: [{ productId: url.searchParams.get("cursor") ?? "first", coin: "USDT", estimateApr: "1%" }], nextPageCursor: "repeat" } };
      },
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchPublicRateSnapshot } = load("@/lib/live-rates");
  const result = await fetchPublicRateSnapshot();

  assert.equal(result.partials.includes("Bybit.com USDT 公共 APR"), true);
});

test("Bybit fixed product scan preserves first-page rows but marks a failed next page incomplete", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: !new URL(url).searchParams.has("cursor"), status: new URL(url).searchParams.has("cursor") ? 503 : 200, headers: new Headers(), url }),
      readExchangeJson: async (response) => new URL(response.url).searchParams.has("cursor")
        ? { retCode: 10000, result: { list: [] } }
        : { retCode: 0, result: { list: [{ productId: "first", coin: "USDC", duration: "30d", tieredApyList: [{ min: "0", max: "-1", apy: "3%" }] }], nextPageCursor: "next" } },
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { scanBybitFixedProducts } = load("@/lib/integrations/bybit");
  const scan = await scanBybitFixedProducts("bybit-eu");

  assert.equal(scan.rows.length, 1);
  assert.equal(scan.complete, false);
});

test("Bybit fixed holding scan marks missing or invalid amounts partial without exposing amounts", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async () => ({ retCode: 0, result: { list: [
        { productId: "missing-amount", coin: "USDT", duration: "7d", status: "Active" },
        { productId: "negative-amount", coin: "USDC", duration: "30d", amount: "-1", status: "Active" },
      ] } }),
    },
  });
  const { scanBybitFixedHoldings } = load("@/lib/integrations/bybit");

  const scan = await scanBybitFixedHoldings({
    apiKey: "secret-key",
    apiSecret: "secret-value",
    baseUrls: ["https://api.bybit.com"],
  });

  assert.equal(scan.rowCount, 2);
  assert.equal(scan.complete, false);
  assert.equal(scan.rows.every((row) => row.hasPositiveHolding === false), true);
  assert.equal(scan.rows.every((row) => !Object.hasOwn(row, "amount")), true);
  assert.equal(JSON.stringify(scan).includes("secret-key"), false);
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
            { productId: "shared-id", coin: "USDT", duration: "7d", status: "Available", tieredApyList: [{ min: "0", max: "300", apy: "7%" }] },
            { productId: "shared-id", coin: "USDT", duration: "90d", status: "Available", tieredApyList: [{ min: "0", max: "-1", apy: "4%" }] },
          ] },
        }
        : {
          retCode: 0,
          result: { list: [
            { productId: "shared-id", coin: "USDT", duration: "7d", amount: "12.5", status: "Active" },
            { productId: "shared-id", coin: "USDT", duration: "90d", amount: "34", status: "Active" },
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

  assert.deepEqual(result.rates.map((rate) => rate.externalProductId), ["shared-id@7d", "shared-id@90d"]);
  assert.equal(result.holdings["bybit-global:USDT:fixed:shared-id@7d"], 12.5);
  assert.equal(result.holdings["bybit-global:USDT:fixed:shared-id@90d"], 34);
  assert.equal(result.sync.products, true);
  assert.equal(result.sync.holdings, true);
  assert.equal(result.sync.productStatus, "complete");
  assert.equal(result.sync.holdingStatus, "complete");
  const record = diagnostics.find((entry) => entry.event === "bybit_fixed_rows");
  assert.ok(record);
  assert.deepEqual(record.fields.productRows.map((row) => [row.productId, row.duration]), [
    ["shared-id", "7d"],
    ["shared-id", "90d"],
  ]);
  assert.deepEqual(record.fields.positionRows.map((row) => [row.productId, row.duration, row.hasPositiveHolding]), [
    ["shared-id", "7d", true],
    ["shared-id", "90d", true],
  ]);
  assert.doesNotMatch(JSON.stringify(record), /12\.5|34|secret-key|secret-value/);
});

test("Bybit fixed sync refuses to guess when a repeated product ID has no holding duration", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async (response) => new URL(response.url).pathname.endsWith("/fixed-term/product")
        ? {
          retCode: 0,
          result: { list: [
            { productId: "shared-id", coin: "USDT", duration: "7d", status: "Available", tieredApyList: [{ min: "0", max: "300", apy: "7%" }] },
            { productId: "shared-id", coin: "USDT", duration: "90d", status: "Available", tieredApyList: [{ min: "0", max: "-1", apy: "4%" }] },
          ] },
        }
        : { retCode: 0, result: { list: [{ productId: "shared-id", coin: "USDT", amount: "12.5", status: "Active" }] } },
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchBybitShortFixedSnapshots } = load("@/lib/integrations/bybit");

  const result = await fetchBybitShortFixedSnapshots({
    apiKey: "secret-key",
    apiSecret: "secret-value",
    baseUrls: ["https://api.bybit.com"],
  });

  assert.equal(result.sync.products, true);
  assert.equal(result.sync.holdings, false);
  assert.equal(result.sync.holdingStatus, "partial");
  assert.equal(result.holdings["bybit-global:USDT:fixed:shared-id@7d"], undefined);
  assert.equal(result.holdings["bybit-global:USDT:fixed:shared-id@90d"], undefined);
});

test("Bybit capability probe can check any monitored flexible coin on global and EU public hosts", async () => {
  const requests = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => {
        requests.push(new URL(url));
        return { ok: true, status: 200, headers: new Headers(), url };
      },
      readExchangeJson: async () => ({
        retCode: 0,
        result: { list: [
          {
            productId: "offer-1",
            coin: "USDGO",
            status: "Available",
            estimateApr: "2.15%",
            minStakeAmount: "1",
            maxStakeAmount: "-1",
            tierAprDetails: [{ min: "0", max: "-1", estimateApr: "2.15%" }],
          },
          { productId: "base-only", coin: "USDGO", status: "Available", estimateApr: "0.8%", tierAprDetails: [] },
          { productId: "missing-rate", coin: "USDGO", status: "Available", tierAprDetails: [] },
        ] },
      }),
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { probeBybitFlexibleProducts } = load("@/lib/integrations/bybit");

  const globalRows = await probeBybitFlexibleProducts("bybit-global", "USDGO");
  const euRows = await probeBybitFlexibleProducts("bybit-eu", "USDGO");

  assert.equal(globalRows[0].productId, "offer-1");
  assert.equal(globalRows[0].apr, 2.15);
  assert.equal(globalRows[0].minAmount, 1);
  assert.equal(globalRows[0].maxAmount, null);
  assert.deepEqual(globalRows[0].tiers, [{ min: 0, max: null, apr: 2.15 }]);
  assert.equal(globalRows[1].rateShape, "single_rate");
  assert.equal(globalRows[1].tierCount, 0);
  assert.equal(globalRows[2].rateShape, "no_rate");
  assert.equal(euRows[0].coin, "USDGO");
  assert.deepEqual(requests.map((url) => [url.hostname, url.searchParams.get("coin")]), [
    ["api.bybit.com", "USDGO"],
    ["api.bybit.eu", "USDGO"],
  ]);
});

test("Bybit EU fixed-holding capability probe checks the signed endpoint and returns no amounts", async () => {
  const requests = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url, options) => {
        requests.push({ url: new URL(url), headers: options.headers });
        return { ok: true, status: 200, headers: new Headers(), url };
      },
      readExchangeJson: async () => ({
        retCode: 0,
        result: { list: [
          { productId: "eu-fixed", coin: "USDC", duration: "90d", amount: "23.5", status: "Active" },
          { productId: "unmonitored", coin: "ETH", duration: "30d", amount: "99", status: "Active" },
        ] },
      }),
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { probeBybitFixedHoldings } = load("@/lib/integrations/bybit");
  const rows = await probeBybitFixedHoldings({
    apiKey: "secret-key",
    apiSecret: "secret-value",
    baseUrls: ["https://api.bybit.eu"],
  });

  assert.deepEqual(rows, [{
    productId: "eu-fixed",
    coin: "USDC",
    duration: "90d",
    status: "Active",
    hasPositiveHolding: true,
  }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.hostname, "api.bybit.eu");
  assert.equal(requests[0].url.pathname, "/v5/earn/fixed-term/position");
  assert.equal(requests[0].headers["X-BAPI-API-KEY"], "secret-key");
  assert.equal(JSON.stringify(rows).includes("23.5"), false);
});
