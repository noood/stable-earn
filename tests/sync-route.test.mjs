import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function fixture() {
  let time = Date.parse("2026-09-05T00:56:15.064Z");
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  let row = null;
  let mode = "success";
  const db = {
    prepare(sql) {
      return { bind(...args) {
        const statement = {
          async first() { return row; },
          async run() {
            if (sql.includes("SET last_error = ?")) row.last_error = args[0];
            else if (sql.includes("payload = excluded.payload")) {
              row = { ...row, payload: args[2], updated_at: args[3], last_attempt_at: args[4], last_error: null };
            } else {
              row = { payload: null, updated_at: null, last_manual_at: null, ...row,
                last_attempt_at: args[2], last_manual_at: args[3] ?? row?.last_manual_at ?? null, last_error: null };
            }
          },
        };
        return statement;
      } };
    },
    async batch(statements) { for (const statement of statements) await statement.run(); },
  };
  const products = ["bg-usdc", "bn-g-usdt"].map((id) => ({
    id, accountId: id === "bg-usdc" ? "bitget-global" : "binance-global",
    holdingDataMode: "api", productDataMode: "api", source: { kind: "live" },
  }));
  const rate = (productId) => ({ productId, apr: 6, fetchedAt: new Clock().toISOString() });
  const load = moduleLoader({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/db": { getDatabase: async () => db, getUserIdentity: async () => ({ userId: "test-user" }) },
    "@/lib/credentials": { loadCredentials: async () => ({ "binance-global": {}, "bitget-global": { passphrase: "test" } }) },
    "@/lib/local-preview": { isLocalPreviewRequest: () => false },
    "@/lib/user-settings": { loadManualRefreshCooldown: async () => 30, manualRefreshCooldownMs: (minutes) => minutes * 60000 },
    "@/lib/live-rates": { fetchPublicRateSnapshot: async () => ({ rates: [], failures: [] }), summarizePublicFailures: (failures) => failures },
    "@/lib/integrations/binance": { fetchBinanceFlexibleSnapshot: async () => {
      if (mode === "error") throw Error("timeout");
      return { rates: mode === "rate-missing" ? [] : [rate("bn-g-usdt")], holdings: { "bn-g-usdt": 0 } };
    } },
    "@/lib/integrations/bitget": { fetchBitgetSavingsSnapshot: async () => {
      if (mode === "error") throw Error("timeout");
      return { rates: [rate("bg-usdc")], holdings: ["partial", "sparse"].includes(mode) ? {} : { "bg-usdc": 299.64 }, sync: { products: true, holdings: mode !== "partial" } };
    } },
    "@/lib/integrations/bybit": {}, "@/lib/integrations/okx": {},
    "@/lib/product-catalog": {
      prepareProductCatalogSync: async (_db, _id, rates) => ({ products, rates, productIds: {}, statements: [] }),
      resolveCatalogProductIds: async () => ({}),
    },
  }, { Date: Clock });
  const route = load("@/app/private/api/products/route");
  return {
    route, db, load,
    now: () => new Clock().toISOString(),
    step(nextMode) { time += 60000; mode = nextMode; },
    refresh: (options) => route.refreshPrivateProductsCache(db, "test-user", options),
    async read(query = "") { return (await route.GET(new Request(`http://test/private/api/products${query}`))).json(); },
    record: () => row,
  };
}

test("real sync route: success → partial → partial → total failure → recovery", async () => {
  const f = fixture();
  const originalTime = f.now();
  await f.refresh();
  f.step("partial");
  await f.refresh();
  let response = await f.read();
  assert.equal(response.holdingUpdates["bg-usdc"], 299.64);
  assert.equal(response.holdingFallbacks["bg-usdc"], originalTime);
  assert.equal(response.holdingFallbacks["bn-g-usdt"], undefined);
  assert.notEqual(response.cache.updatedAt, originalTime);
  f.step("partial");
  await f.refresh();
  assert.equal((await f.read()).holdingFallbacks["bg-usdc"], originalTime);
  f.step("error");
  await assert.rejects(f.refresh());
  response = await f.read();
  assert.equal(response.cache.state, "error");
  assert.equal(response.holdingFallbacks["bg-usdc"], originalTime);
  assert.deepEqual(response.failures, ["产品和持仓数据更新失败"]);
  assert.equal(response.holdingSyncStates["bg-usdc"], "error");
  f.step("success");
  await f.refresh();
  response = await f.read();
  assert.deepEqual(response.holdingFallbacks, {});
  assert.deepEqual(response.failures, []);
  assert.equal(response.holdingUpdates["bg-usdc"], 299.64);
});

test("scheduled retry keeps the saved directory and does not commit intermediate failures", async () => {
  const f = fixture();
  await f.refresh();
  const saved = f.record().payload;
  f.step("partial");
  await assert.rejects(f.refresh({ acceptPartial: false, persistFailure: false }));
  assert.equal(f.record().payload, saved);
  const response = await f.read();
  assert.equal(response.cache.state, "syncing");
  assert.equal(response.products.length, 2);
  assert.equal(response.holdingUpdates["bg-usdc"], 299.64);
  assert.deepEqual(response.failures, []);
});

test("first scheduled attempt has syncing state without a successful cache", async () => {
  const f = fixture();
  f.step("error");
  await assert.rejects(f.refresh({ acceptPartial: false, persistFailure: false }));
  const response = await f.read();
  assert.equal(response.cache.state, "syncing");
  assert.deepEqual(response.products, []);
  assert.deepEqual(response.failures, []);
});

test("manual cooldown must not hide the previous total failure", async () => {
  const f = fixture();
  await f.refresh();
  f.step("error");
  await assert.rejects(f.refresh({ manual: true }));
  const response = await f.read("?refresh=1");
  assert.equal(response.cache.state, "cooldown");
  assert.deepEqual(response.failures, ["产品和持仓数据更新失败"]);
  assert.ok(response.holdingFallbacks["bg-usdc"]);
});

test("successful sparse Bitget response cannot turn an absent holding into zero", async () => {
  const f = fixture();
  const sourceTime = f.now();
  await f.refresh();
  f.step("sparse");
  await f.refresh();
  const response = await f.read();
  assert.equal(response.holdingUpdates["bg-usdc"], 299.64);
  assert.equal(response.holdingFallbacks["bg-usdc"], sourceTime);
  assert.deepEqual(response.failures, []);
});

test("product APR cache keeps its own timestamp even without a matching failure label", async () => {
  const f = fixture();
  const sourceTime = f.now();
  await f.refresh();
  for (let i = 0; i < 2; i++) {
    f.step("rate-missing");
    await f.refresh();
    const response = await f.read();
    assert.equal(response.rates.find((rate) => rate.productId === "bn-g-usdt").fetchedAt, sourceTime);
    assert.equal(response.rateFallbacks["bn-g-usdt"], sourceTime);
    assert.equal(response.holdingFallbacks["bn-g-usdt"], undefined);
  }
});
