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
                productId: "partial-finite-limit",
                coin,
                status: "Available",
                estimateApr: "2%",
                maxStakeAmount: "2000",
                tierAprDetails: [{ min: "0", max: "1000", estimateApr: "7%" }],
              }, {
                productId: "partial-unlimited-limit",
                coin,
                status: "Available",
                estimateApr: "2%",
                maxStakeAmount: "-1",
                tierAprDetails: [{ min: "0", max: "1000", estimateApr: "7%" }],
              }, {
                productId: "partial-unreadable-limit",
                coin,
                status: "Available",
                estimateApr: "2%",
                maxStakeAmount: "unknown",
                tierAprDetails: [{ min: "0", max: "1000", estimateApr: "7%" }],
              }, {
                productId: "unknown-cap",
                coin,
                status: "Available",
                tierAprDetails: [{ min: "0", estimateApr: "7%" }],
              }, {
                productId: "unreadable-product-cap",
                coin,
                status: "Available",
                estimateApr: "2%",
                maxStakeAmount: "unknown",
                tierAprDetails: [{ min: "0", estimateApr: "7%" }],
              }, {
                productId: "malformed-product-cap",
                coin,
                status: "Available",
                estimateApr: "2%",
                maxStakeAmount: "1000abc",
              }, {
                productId: "malformed-product-apr",
                coin,
                status: "Available",
                estimateApr: "2%oops",
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
  assert.equal(unknown.rateCoverage, "complete");
  assert.deepEqual(unknown.tiers, [{ min: 0, max: null, apr: 7, maxStatus: "unlimited" }]);
  const unreadableCap = result.rates.find((item) => item.externalProductId === "unreadable-product-cap");
  assert.equal(unreadableCap.rateCoverage, "partial");
  assert.deepEqual(unreadableCap.tiers, [{ min: 0, max: null, apr: 7 }]);
  assert.equal(unreadableCap.aprStatus, "available");
  assert.equal(unreadableCap.capacityStatus, "unavailable");
  const malformedCap = result.rates.find((item) => item.externalProductId === "malformed-product-cap");
  assert.equal(malformedCap.rateCoverage, "partial");
  assert.equal(malformedCap.subscriptionMaximum, null);
  assert.equal(malformedCap.subscriptionMaximumStatus, "unreadable");
  assert.deepEqual(malformedCap.tiers, [{ min: 0, max: null, apr: 2 }]);
  const malformedApr = result.rates.find((item) => item.externalProductId === "malformed-product-apr");
  assert.equal(malformedApr.rateCoverage, "unavailable");
  assert.equal(malformedApr.catalog.asset, "USDC");
  assert.equal(result.partials.includes("Bybit Global USDC 公共 APR"), false);
  assert.ok(result.fieldNotices.some((notice) => notice.productName.includes("malformed-product-apr") && notice.fields.includes("APR 未获取")));
  assert.equal(rate.capacitySource, "live");
  assert.ok(rate.capacityFetchedAt);
  for (const productId of ["partial-finite-limit", "partial-unlimited-limit", "partial-unreadable-limit"]) {
    const partialRate = result.rates.find((item) => item.externalProductId === productId);
    assert.equal(partialRate.rateCoverage, "partial");
    assert.deepEqual(partialRate.tiers, [{ min: 0, max: 1000, apr: 7 }]);
  }
  assert.ok(result.rates.find((item) => item.identityKey === "bybit-eu:USDT:flexible:eu-usdt"));
});

test("Bybit treats null tier boundaries as omitted, but rejects malformed APR text", () => {
  const load = moduleLoader();
  const { parseBybitFlexibleTiers } = load("@/lib/integrations/bybit");

  const open = parseBybitFlexibleTiers([{ min: "0", max: null, estimateApr: "7%" }]);
  assert.equal(open.complete, true);
  assert.deepEqual(open.tiers, [{ min: 0, max: null, apr: 7, maxStatus: "unlimited", maxSource: "api" }]);

  const malformed = parseBybitFlexibleTiers([{ min: "0", max: "-1", estimateApr: "7%oops" }]);
  assert.equal(malformed.complete, false);
  assert.equal(malformed.aprStatus, "unavailable");
  assert.deepEqual(malformed.tiers, [{ min: 0, max: null, maxStatus: "unlimited", maxSource: "api" }]);
});

test("Bybit can use a returned product maximum only to fill a missing final tier boundary", () => {
  const load = moduleLoader();
  const { parseBybitFlexibleTiers } = load("@/lib/integrations/bybit");
  const tiers = [
    { min: "0", max: "200", estimateApr: "7%" },
    { min: "200", estimateApr: "2%" },
  ];

  assert.deepEqual(parseBybitFlexibleTiers(tiers, 1000), {
    tiers: [
      { min: 0, max: 200, apr: 7, maxSource: "api" },
      { min: 200, max: 1000, apr: 2, maxSource: "product_limit" },
    ],
    complete: true,
    hasTiers: true,
    aprStatus: "available",
    capacityStatus: "available",
    tierStructureStatus: "complete",
  });
  assert.deepEqual(parseBybitFlexibleTiers(tiers), {
    tiers: [
      { min: 0, max: 200, apr: 7, maxSource: "api" },
      { min: 200, max: null, apr: 2, maxStatus: "unlimited", maxSource: "api" },
    ],
    complete: true,
    hasTiers: true,
    aprStatus: "available",
    capacityStatus: "available",
    tierStructureStatus: "complete",
  });
  assert.equal(parseBybitFlexibleTiers(tiers, 100).complete, false);
  assert.equal(parseBybitFlexibleTiers(tiers, undefined, true).complete, false);

  const finiteKnownTiers = [
    { min: "0", max: "300", estimateApr: "8%" },
    { min: "300", max: "1000", estimateApr: "3%" },
  ];
  for (const productMaximum of [2000, -1]) {
    const schedule = parseBybitFlexibleTiers(finiteKnownTiers, productMaximum);
    assert.equal(schedule.complete, false);
    assert.deepEqual(schedule.tiers.map(({ min, max, apr }) => ({ min, max, apr })), [
      { min: 0, max: 300, apr: 8 },
      { min: 300, max: 1000, apr: 3 },
    ]);
  }
  assert.equal(parseBybitFlexibleTiers([
    { min: "0", max: "300", estimateApr: "8%" },
    { min: "300", max: "-1", estimateApr: "3%" },
  ], -1).complete, true);

});

test("Bybit fixed scan marks known tiers partial when the product limit extends beyond them", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async () => ({ retCode: 0, result: { list: [
        { productId: "fixed-finite-limit", coin: "USDT", duration: "7d", maxStakeAmount: "2000", tieredApyList: [{ min: "0", max: "1000", apy: "7%" }] },
        { productId: "fixed-unlimited-limit", coin: "USDC", duration: "7d", maxStakeAmount: "-1", tieredApyList: [{ min: "0", max: "1000", apy: "7%" }] },
        { productId: "fixed-unreadable-limit", coin: "USDGO", duration: "7d", maxStakeAmount: "unknown", tieredApyList: [{ min: "0", max: "1000", apy: "7%" }] },
        { productId: "fixed-covered", coin: "BTC", duration: "7d", maxStakeAmount: "-1", tieredApyList: [{ min: "0", max: "-1", apy: "7%" }] },
        { productId: "fixed-no-limit", coin: "USDGO", duration: "30d", tieredApyList: [{ min: "0", apy: "6%" }] },
        { productId: "fixed-fill-from-total", coin: "USDT", duration: "30d", maxStakeAmount: "2000", tieredApyList: [{ min: "0", max: "500", apy: "8%" }, { min: "500", apy: "3%" }] },
        { productId: "fixed-unreadable-open-limit", coin: "USDC", duration: "30d", maxStakeAmount: "unknown", tieredApyList: [{ min: "0", apy: "6%" }] },
        { productId: "fixed-bad-tier-bound", coin: "BTC", duration: "30d", tieredApyList: [{ min: "0", max: "not-a-number", apy: "6%" }] },
      ] } }),
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { scanBybitFixedProducts } = load("@/lib/integrations/bybit");
  const result = await scanBybitFixedProducts("bybit-global");

  assert.equal(result.rows.find((row) => row.externalProductId === "fixed-finite-limit@7d").rateCoverage, "partial");
  assert.equal(result.rows.find((row) => row.externalProductId === "fixed-unlimited-limit@7d").rateCoverage, "partial");
  assert.equal(result.rows.find((row) => row.externalProductId === "fixed-unreadable-limit@7d").rateCoverage, "partial");
  assert.deepEqual(result.rows.find((row) => row.externalProductId === "fixed-unreadable-limit@7d").tiers, [{ min: 0, max: 1000, apy: 7 }]);
  assert.equal(result.rows.find((row) => row.externalProductId === "fixed-covered@7d").rateCoverage, "complete");
  const noLimit = result.rows.find((row) => row.externalProductId === "fixed-no-limit@30d");
  assert.equal(noLimit.rateCoverage, "complete");
  assert.deepEqual(noLimit.tiers, [{ min: 0, max: null, apy: 6, maxStatus: "unlimited" }]);
  const filledFromTotal = result.rows.find((row) => row.externalProductId === "fixed-fill-from-total@30d");
  assert.equal(filledFromTotal.rateCoverage, "complete");
  assert.deepEqual(filledFromTotal.tiers, [{ min: 0, max: 500, apy: 8 }, { min: 500, max: 2000, apy: 3 }]);
  const unreadableOpenLimit = result.rows.find((row) => row.externalProductId === "fixed-unreadable-open-limit@30d");
  assert.equal(unreadableOpenLimit.rateCoverage, "partial");
  assert.deepEqual(unreadableOpenLimit.tiers, [{ min: 0, max: null, apy: 6 }]);
  const badTierBound = result.rows.find((row) => row.externalProductId === "fixed-bad-tier-bound@30d");
  assert.equal(badTierBound.rateCoverage, "partial");
  assert.deepEqual(badTierBound.tiers, [{ min: 0, max: null, apy: 6 }]);
});

test("Bybit flexible scan keeps a complete request when one identified product lacks APR", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async () => ({ retCode: 0, result: { list: [
        { productId: "without-apr", coin: "USDT", status: "Available" },
      ] } }),
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { scanBybitFlexibleProducts } = load("@/lib/integrations/bybit");
  const result = await scanBybitFlexibleProducts("bybit-global", "USDT");
  assert.equal(result.complete, true);
  assert.equal(result.rows[0].rateShape, "no_rate");
});

test("Bybit fixed product with missing APR remains API-managed while the request succeeds", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async (response) => new URL(response.url).pathname.endsWith("/fixed-term/product")
        ? { retCode: 0, result: { list: [{ productId: "without-apr", coin: "USDT", duration: "7d", status: "Available" }] } }
        : { retCode: 0, result: { list: [{ productId: "without-apr", coin: "USDT", duration: "7d", amount: "12" }] } },
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchBybitShortFixedSnapshots } = load("@/lib/integrations/bybit");
  const result = await fetchBybitShortFixedSnapshots({ apiKey: "key", apiSecret: "secret", baseUrls: ["https://api.bybit.com"] });
  assert.equal(result.sync.productStatus, "complete");
  assert.equal(result.rates[0].productDataMode, undefined);
  assert.equal(result.rates[0].rateCoverage, "unavailable");
  assert.equal(result.holdings[result.rates[0].productId], 12);
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

test("Bybit fixed APY uses the product coin only and never sums other reward coins", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async () => ({ retCode: 0, result: { list: [
        {
          productId: "usdt-own-coin",
          coin: "USDT",
          duration: "7d",
          status: "Available",
          maxStakeAmount: "1000",
          tieredApyList: [],
          interestCoinApyList: [{ coin: "USDT", apy: "2%" }, { coin: "BTC", apy: "50%" }],
        },
        {
          productId: "usdc-other-coin-only",
          coin: "USDC",
          duration: "7d",
          status: "Available",
          tieredApyList: [],
          interestCoinApyList: [{ coin: "BTC", apy: "50%" }],
        },
      ] } }),
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { scanBybitFixedProducts } = load("@/lib/integrations/bybit");
  const scan = await scanBybitFixedProducts("bybit-global");

  assert.equal(scan.complete, true);
  assert.equal(scan.rows.find((row) => row.coin === "USDT").apy, 2);
  assert.deepEqual(scan.rows.find((row) => row.coin === "USDT").tiers, [{ min: 0, max: 1000, apy: 2 }]);
  assert.equal(scan.rows.find((row) => row.coin === "USDC").rateShape, "no_rate");
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

  assert.equal(result.partials.includes("Bybit Global USDT 公共 APR"), true);
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
  assert.deepEqual(globalRows[0].tiers, [{ min: 0, max: null, apr: 2.15, maxStatus: "unlimited", maxSource: "api" }]);
  assert.equal(globalRows[0].maxAmountStatus, "unlimited");
  assert.equal(globalRows[0].maxAmountSource, "api");
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
