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
  assert.equal(result.rates[0].subscriptionMaximum, 1000);
  assert.equal(result.rates[0].subscriptionMaximumStatus, "limited");
  assert.equal(result.rates[0].subscriptionMaximumSource, "api");
  assert.ok(Math.abs(result.rates[0].tiers[0].apr - 6.73) < 1e-9);
  assert.equal(result.holdings["USDT001"], undefined);
  assert.equal(result.holdings["api:binance-global:USDT:USDT001"], 123.45);
  assert.equal(result.holdings[result.rates[0].productId], 123.45);
  assert.equal(result.positions[0].sourceProductId, "api:binance-global:USDT:USDT001");
  assert.equal(result.positions[0].accountId, "binance-global");
  assert.equal(result.productListComplete, true);
  assert.equal(result.positionListComplete, true);
});

test("a Binance locked single-rate product with no returned quota is treated as unlimited", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), path: new URL(url).pathname, text: async () => "{}" }),
      readExchangeJson: async (response) => response.path.endsWith("/locked/list")
        ? { total: 1, rows: [{ projectId: "USDC001", detail: { asset: "USDC", apr: "0.02", duration: 7 } }] }
        : { total: 0, rows: [] },
    },
  });
  const { fetchBinanceLockedSnapshot } = load("@/lib/integrations/binance");
  const result = await fetchBinanceLockedSnapshot({ apiKey: "key", apiSecret: "secret" }, "global", ["USDC"]);

  assert.equal(result.rates[0].rateCoverage, "complete");
  assert.deepEqual(result.rates[0].tiers, [{ min: 0, max: null, apr: 2, maxStatus: "unlimited" }]);
  assert.equal(result.rates[0].subscriptionMaximum, null);
  assert.equal(result.rates[0].subscriptionMaximumStatus, "unlimited");
  assert.equal(result.rates[0].subscriptionMaximumSource, "not_returned");
  assert.equal(result.rates[0].capacitySource, undefined);
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

test("narrow Binance locked-product diagnosis returns APR and quota fields without requesting holdings", async () => {
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
        if (current === 1) return {
          total: 2,
          rows: [
            {
              projectId: "USDT-7D",
              detail: { asset: "USDT", duration: 7, apr: "0.025", status: "PURCHASABLE", isSoldOut: false },
              quota: { minimum: "100", totalPersonalQuota: "500000" },
            },
            { projectId: "OTHER-7D", detail: { asset: "OTHER", duration: 7, apr: "0.03" } },
          ],
        };
        return { total: 2, rows: [] };
      },
    },
  });
  const { diagnoseBinanceLockedProducts } = load("@/lib/integrations/binance");
  const result = await diagnoseBinanceLockedProducts({ apiKey: "key", apiSecret: "secret" }, "global");

  assert.equal(result.status, "returned");
  assert.equal(result.responseComplete, true);
  assert.equal(result.totalRowCount, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].asset, "USDT");
  assert.deepEqual(result.rows[0].apr, { state: "returned", value: "0.025" });
  assert.deepEqual(result.rows[0].apy, { state: "missing" });
  assert.deepEqual(result.rows[0].minimum, { state: "returned", value: "100" });
  assert.deepEqual(result.rows[0].totalPersonalQuota, { state: "returned", value: "500000" });
  assert.equal(result.pagesRead, 1);
  assert.equal(requests.length, 1);
  assert.ok(requests.every((request) => request.pathname === "/sapi/v1/simple-earn/locked/list"));
});

test("narrow Binance locked-product diagnosis does not call an unrecognized row shape empty", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        path: new URL(url).pathname,
        url,
        text: async () => "{}",
      }),
      readExchangeJson: async () => ({
        total: 1,
        rows: [{ projectId: "USDT-7D", product: { asset: "USDT" }, quota: { totalPersonalQuota: "500000" } }],
      }),
    },
  });
  const { diagnoseBinanceLockedProducts } = load("@/lib/integrations/binance");
  const result = await diagnoseBinanceLockedProducts({ apiKey: "key", apiSecret: "secret" }, "global");

  assert.equal(result.responseComplete, true);
  assert.equal(result.status, "partial");
  assert.equal(result.unmappedAssetRowCount, 1);
  assert.equal(result.rows.length, 0);
  assert.ok(result.sampleFieldShapes[0].topLevelFields.includes("product"));
});
