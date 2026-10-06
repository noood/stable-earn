import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("Bitget keeps separate offers and assigns holdings by productId", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        url,
        text: async () => "",
      }),
      readExchangeText: async (response) => {
        const parsed = new URL(response.url);
        if (parsed.pathname.endsWith("/savings/assets")) {
          return JSON.stringify({ code: "00000", data: { resultList: [
            { productId: "bg-usdt-standard", productCoin: "USDT", periodType: "flexible", holdAmount: "300", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "8.06" }] },
            { productId: "bg-usdt-open", productCoin: "USDT", periodType: "flexible", holdAmount: "0", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "8" }, { minApy: "300", currentApy: "3" }] },
            { productId: "bg-usdt-promo", productCoin: "USDT", periodType: "flexible", holdAmount: "0", productLevel: "normal", apy: [{ minApy: "0", maxApy: "100000", currentApy: "10" }] },
            { productId: "bg-usdt-vip-held", productCoin: "USDT", periodType: "flexible", holdAmount: "25", productLevel: "VIP", apy: [{ minApy: "0", maxApy: "1000", currentApy: "9" }] },
            { productId: "bg-usdt-vip-empty", productCoin: "USDT", periodType: "flexible", holdAmount: "0", productLevel: "VIP", apy: [{ minApy: "0", maxApy: "1000", currentApy: "9" }] },
            { productId: "bg-usdt-vip-no-rate", productCoin: "USDT", periodType: "flexible", holdAmount: "7", productLevel: "VIP", apy: [] },
            { productId: "USDC-shared", productCoin: "USDC", periodType: "flexible", holdAmount: "0", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "6" }] },
            { productId: "USDGO-default", productCoin: "USDGO", periodType: "flexible", holdAmount: "0", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "6" }] },
          ] } });
        }
        const coin = parsed.searchParams.get("coin");
        const rows = coin === "USDT"
          ? [
            { productId: "bg-usdt-standard", coin: "USDT", periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "8.06" }] },
            { productId: "bg-usdt-open", coin: "USDT", periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "8" }, { minStepVal: "300", currentApy: "3" }] },
            { productId: "bg-usdt-promo", coin: "USDT", periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "100000", currentApy: "10" }] },
            { productId: "bg-usdt-vip-held", coin: "USDT", periodType: "flexible", status: "available", productLevel: "VIP", apyList: [{ minStepVal: "0", maxStepVal: "1000", currentApy: "9" }] },
            { productId: "bg-usdt-vip-empty", coin: "USDT", periodType: "flexible", status: "available", productLevel: "VIP", apyList: [{ minStepVal: "0", maxStepVal: "1000", currentApy: "9" }] },
          ]
          : coin === "USDC"
            ? [
              { productId: "USDC-shared", coin: "USDC", periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "8" }] },
              { productId: "USDC-shared", coin: "USDC", periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "100000", currentApy: "10" }] },
            ]
          : [{ productId: `${coin}-default`, coin, periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "6" }] }];
        return JSON.stringify({ code: "00000", data: rows });
      },
      readExchangeJson: async () => ({ code: "00000", data: { serverTime: "1" } }),
      logExchangePayload: () => {},
    },
  });
  const { fetchBitgetSavingsSnapshot } = load("@/lib/integrations/bitget");
  const result = await fetchBitgetSavingsSnapshot({ apiKey: "key", apiSecret: "secret", passphrase: "pass" });

  const usdtRates = result.rates.filter((rate) => rate.catalog?.asset === "USDT");
  assert.equal(usdtRates.length, 5);
  assert.deepEqual(usdtRates.map((rate) => rate.externalProductId).sort(), ["bg-usdt-open", "bg-usdt-promo", "bg-usdt-standard", "bg-usdt-vip-held", "bg-usdt-vip-no-rate"]);
  const openEndedRate = usdtRates.find((rate) => rate.externalProductId === "bg-usdt-open");
  assert.equal(openEndedRate.rateCoverage, "complete");
  assert.deepEqual(openEndedRate.tiers, [
    { min: 0, max: 300, apr: 8 },
    { min: 300, max: null, apr: 3, maxStatus: "unlimited" },
  ]);
  const vipRate = usdtRates.find((rate) => rate.externalProductId === "bg-usdt-vip-held");
  assert.equal(vipRate.eligibilityRequired, true);
  assert.equal(vipRate.eligibilityStatus, "unknown");
  assert.equal(vipRate.rateCoverage, "complete");
  const vipWithoutApr = usdtRates.find((rate) => rate.externalProductId === "bg-usdt-vip-no-rate");
  assert.deepEqual(vipWithoutApr.tiers, []);
  assert.equal(vipWithoutApr.rateCoverage, "unavailable");
  assert.equal(usdtRates.some((rate) => rate.externalProductId === "bg-usdt-vip-empty"), false);
  const usdcRates = result.rates.filter((rate) => rate.catalog?.asset === "USDC");
  assert.equal(usdcRates.length, 1);
  assert.equal(usdcRates[0].tiers.length, 1);
  assert.equal(result.holdings["bitget-global:USDT:flexible:bg-usdt-standard"], 300);
  assert.equal(result.holdings["bitget-global:USDT:flexible:bg-usdt-promo"], 0);
  assert.equal(result.holdings["bitget-global:USDT:flexible:bg-usdt-vip-held"], 25);
  assert.equal(result.holdings["bitget-global:USDT:flexible:bg-usdt-vip-no-rate"], 7);
  assert.equal(result.sync.products, true);
  assert.equal(result.sync.holdings, true);
  assert.equal(result.sync.productStatus, "complete");
  assert.equal(result.sync.holdingStatus, "complete");
});

test("Bitget reports a failed product request separately from a successful empty holdings list", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/savings/product")) throw new Error("request failed");
        return { ok: true, status: 200, headers: new Headers(), url, text: async () => "" };
      },
      readExchangeText: async () => JSON.stringify({ code: "00000", data: { resultList: [], endId: "" } }),
      readExchangeJson: async () => ({ code: "00000", data: {} }),
      logExchangePayload: () => {},
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchBitgetSavingsSnapshot } = load("@/lib/integrations/bitget");
  const result = await fetchBitgetSavingsSnapshot({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }, ["USDT"]);

  assert.equal(result.sync.productStatus, "error");
  assert.equal(result.sync.holdingStatus, "complete");
  assert.equal(result.sync.products, false);
  assert.equal(result.sync.holdings, true);
});

test("Bitget follows assets endId pagination before treating an absent offer as zero", async () => {
  const assetQueries = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        url,
        text: async () => "",
      }),
      readExchangeText: async (response) => {
        const parsed = new URL(response.url);
        if (parsed.pathname.endsWith("/savings/assets")) {
          assetQueries.push(Object.fromEntries(parsed.searchParams.entries()));
          const cursor = parsed.searchParams.get("idLessThan");
          if (!cursor) {
            const filler = Array.from({ length: 99 }, (_, index) => ({
              productId: `filler-${index}`,
              productCoin: "USDGO",
              periodType: "flexible",
              holdAmount: "0",
              productLevel: "normal",
              apy: [{ minApy: "0", maxApy: "300", currentApy: "1" }],
            }));
            return JSON.stringify({ code: "00000", data: {
              resultList: [
                { productId: "bg-usdt-standard", productCoin: "USDT", periodType: "flexible", holdAmount: "300", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "8" }] },
                ...filler,
              ],
              endId: "100",
            } });
          }
          return JSON.stringify({ code: "00000", data: {
            resultList: [{ productId: "bg-usdc", productCoin: "USDC", periodType: "flexible", holdAmount: "0", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "6" }] }],
          } });
        }
        const coin = parsed.searchParams.get("coin");
        const rows = coin === "USDT"
          ? [
            { productId: "bg-usdt-standard", coin: "USDT", periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "8" }] },
            { productId: "bg-usdt-promo", coin: "USDT", periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "100000", currentApy: "10" }] },
          ]
          : coin === "USDC"
            ? [{ productId: "bg-usdc", coin: "USDC", periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "6" }] }]
            : [{ productId: "bg-usdgo", coin, periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "1" }] }];
        return JSON.stringify({ code: "00000", data: rows });
      },
      readExchangeJson: async () => ({ code: "00000", data: { serverTime: "1" } }),
      logExchangePayload: () => {},
    },
  });
  const { fetchBitgetSavingsSnapshot } = load("@/lib/integrations/bitget");
  const result = await fetchBitgetSavingsSnapshot({ apiKey: "key", apiSecret: "secret", passphrase: "pass" });

  assert.equal(assetQueries.length, 2);
  assert.equal(assetQueries[0].limit, "100");
  assert.equal(assetQueries[0].periodType, "flexible");
  assert.equal(assetQueries[1].idLessThan, "100");
  assert.equal(result.sync.holdings, true);
  assert.equal(result.holdings["bitget-global:USDT:flexible:bg-usdt-standard"], 300);
  assert.equal(result.holdings["bitget-global:USDT:flexible:bg-usdt-promo"], 0);
});

test("Bitget labels single APY offers correctly and rejects a ladder with a missing range", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeText: async (response) => {
        const parsed = new URL(response.url);
        if (parsed.pathname.endsWith("/savings/assets")) {
          return JSON.stringify({ code: "00000", data: { resultList: [], endId: "" } });
        }
        return JSON.stringify({ code: "00000", data: [
          { productId: "single", coin: "USDT", periodType: "flexible", apyType: "single", status: "available", apyList: [{ rateLevel: "0", minStepVal: "0", maxStepVal: "1000", currentApy: "8" }] },
          { productId: "gap", coin: "USDT", periodType: "flexible", apyType: "ladder", status: "available", apyList: [
            { rateLevel: "0", minStepVal: "0", maxStepVal: "300", currentApy: "8" },
            { rateLevel: "1", minStepVal: "400", maxStepVal: "1000", currentApy: "3" },
          ] },
          { productId: "open", coin: "USDT", periodType: "flexible", apyType: "ladder", status: "available", apyList: [
            { rateLevel: "0", minStepVal: "0", maxStepVal: "300", currentApy: "8" },
            { rateLevel: "1", minStepVal: "300", currentApy: "3" },
          ] },
          { productId: "explicit-open", coin: "USDT", periodType: "flexible", apyType: "ladder", status: "available", apyList: [
            { rateLevel: "0", minStepVal: "0", maxStepVal: "-1", currentApy: "3" },
          ] },
          { productId: "bad-bound", coin: "USDT", periodType: "flexible", apyType: "ladder", status: "available", apyList: [
            { rateLevel: "0", minStepVal: "0", maxStepVal: "not-a-number", currentApy: "3" },
          ] },
        ] });
      },
      readExchangeJson: async () => ({ code: "00000", data: { serverTime: "1" } }),
      logExchangePayload: () => {},
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { probeBitgetAssets } = load("@/lib/integrations/bitget");
  const [result] = await probeBitgetAssets({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }, ["USDT"]);

  assert.equal(result.productApi.status, "returned");
  assert.equal(result.productApi.rows.find((row) => row.productId === "single").rateShape, "single_rate");
  assert.deepEqual(result.productApi.rows.find((row) => row.productId === "single").tiers, [{ min: 0, max: 1000, apr: 8 }]);
  assert.deepEqual(result.productApi.rows.find((row) => row.productId === "gap").tiers, []);
  assert.deepEqual(result.productApi.rows.find((row) => row.productId === "open").tiers, [
    { min: 0, max: 300, apr: 8 },
    { min: 300, max: null, apr: 3, maxStatus: "unlimited" },
  ]);
  assert.deepEqual(result.productApi.rows.find((row) => row.productId === "explicit-open").tiers, [
    { min: 0, max: null, apr: 3, maxStatus: "unlimited" },
  ]);
  assert.deepEqual(result.productApi.rows.find((row) => row.productId === "bad-bound").tiers, []);
});

test("Bitget keeps a complete query separate from an unreadable APY schedule", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeText: async (response) => {
        const parsed = new URL(response.url);
        if (parsed.pathname.endsWith("/savings/assets")) {
          return JSON.stringify({ code: "00000", data: { resultList: [], endId: "" } });
        }
        return JSON.stringify({ code: "00000", data: [
          { productId: "shape-mismatch", coin: "USDT", periodType: "flexible", apyType: "single", status: "available", apyList: [
            { rateLevel: "0", minStepVal: "0", maxStepVal: "300", currentApy: "8" },
            { rateLevel: "1", minStepVal: "300", maxStepVal: "1000", currentApy: "3" },
          ] },
        ] });
      },
      readExchangeJson: async () => ({ code: "00000", data: { serverTime: "1" } }),
      logExchangePayload: () => {},
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { probeBitgetAssets } = load("@/lib/integrations/bitget");
  const [result] = await probeBitgetAssets({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }, ["USDT"]);

  assert.equal(result.productApi.status, "returned");
  const product = result.productApi.rows.find((row) => row.productId === "shape-mismatch");
  assert.equal(product.rateShape, "no_rate");
  assert.deepEqual(product.tiers, []);
});

test("Bitget treats null APR as missing and rejects numeric prefixes", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url, text: async () => "" }),
      readExchangeText: async (response) => {
        const parsed = new URL(response.url);
        if (parsed.pathname.endsWith("/savings/assets")) {
          return JSON.stringify({ code: "00000", data: { resultList: [], endId: "" } });
        }
        return JSON.stringify({ code: "00000", data: [
          { productId: "null-apr", coin: "USDT", periodType: "flexible", apyType: "single", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "1000", currentApy: null }] },
          { productId: "malformed-apr", coin: "USDT", periodType: "flexible", apyType: "single", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "1000", currentApy: "8abc" }] },
          { productId: "null-open-boundary", coin: "USDT", periodType: "flexible", apyType: "ladder", status: "available", apyList: [{ minStepVal: "0", maxStepVal: null, currentApy: "3" }] },
        ] });
      },
      readExchangeJson: async () => ({ code: "00000", data: { serverTime: "1" } }),
      logExchangePayload: () => {},
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { probeBitgetAssets } = load("@/lib/integrations/bitget");
  const [result] = await probeBitgetAssets({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }, ["USDT"]);

  assert.equal(result.productApi.status, "returned");
  assert.deepEqual(result.productApi.rows.find((row) => row.productId === "null-apr").tiers, []);
  assert.deepEqual(result.productApi.rows.find((row) => row.productId === "malformed-apr").tiers, []);
  assert.deepEqual(result.productApi.rows.find((row) => row.productId === "null-open-boundary").tiers, [
    { min: 0, max: null, apr: 3, maxStatus: "unlimited" },
  ]);
});
