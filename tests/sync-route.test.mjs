import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

function fixture() {
  const logs = [];
  let time = Date.parse("2026-09-05T00:56:15.064Z");
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  let mode = "success";
  let pause = null;
  const storage = sqliteDb();
  const record = () => storage.sqlite.prepare("SELECT * FROM sync_snapshots WHERE owner_id = 'test-user' AND cache_key = 'private-products'").get() ?? null;
  const db = {
    ...storage,
    prepare(sql) {
      return { bind(...args) {
        const statement = storage.prepare(sql).bind(...args);
        return {
          ...statement,
          async first() {
            if (mode === "readback-error" && sql.includes("FROM sync_snapshots") && record()?.payload) throw Error("readback failed");
            return statement.first();
          },
        };
      } };
    },
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
      if (pause) await pause;
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
  }, { Date: Clock, console: { info: (record) => logs.push(record), warn: (record) => logs.push(record) } });
  const route = load("@/app/private/api/products/route");
  return {
    route, db, load, logs,
    now: () => new Clock().toISOString(),
    step(nextMode) { time += 60000; mode = nextMode; },
    setTime(value) { time = Date.parse(value); },
    pause() { let resume; pause = new Promise((resolve) => { resume = resolve; }); return () => { pause = null; resume(); }; },
    refresh: (options) => route.refreshPrivateProductsCache(db, "test-user", options),
    async read(query = "") { return (await route.GET(new Request(`http://test/private/api/products${query}`))).json(); },
    record,
  };
}

test("sync logs preserve platform outcomes before total failure and correlate scheduled retries", async () => {
  const f = fixture();
  f.step("error");
  await assert.rejects(f.refresh({ trigger: "scheduled", attempt: 3, runId: "scheduled-run" }));
  const statuses = f.logs.find((r) => r.event === "sync_platforms");
  assert.equal(statuses.binanceGlobal, "error");
  assert.equal(statuses.bitget, "error");
  assert.equal(statuses.publicOutcome, "no_usable_rates");
  const end = f.logs.at(-1);
  assert.equal(end.event, "sync_finished");
  assert.equal(end.outcome, "error");
  assert.equal(end.committed, false);
  assert.equal(end.attempt, 3);
  assert.ok(f.logs.every((r) => r.runId === "scheduled-run" && r.userRef === end.userRef));
  f.step("partial");
  await f.refresh({ manual: true });
  assert.equal(f.logs.at(-1).trigger, "manual");
  assert.equal(f.logs.at(-1).outcome, "partial");
  assert.equal(f.logs.at(-1).committed, true);
  const partial = f.logs.findLast((r) => r.event === "sync_platforms");
  assert.equal(partial.bitgetProducts, true);
  assert.equal(partial.bitgetHoldings, false);
});

test("first opening is one refresh per Shanghai day across devices, separate from manual cooldown", async () => {
  const f = fixture();
  const first = await f.read("?visit=1");
  assert.equal(first.cache.state, "updated");
  assert.equal(first.dailyRefreshPending, false);
  assert.equal(f.logs.filter((r) => r.event === "sync_started").length, 1);
  assert.equal(f.logs.at(-1).trigger, "daily");
  assert.equal((await f.read("?visit=1")).cache.state, "fresh");
  assert.equal(f.logs.filter((r) => r.event === "sync_started").length, 1);
  await f.read("?refresh=1");
  assert.equal(f.logs.at(-1).trigger, "manual");
  assert.equal((await f.read("?refresh=1")).cache.state, "cooldown");
  f.setTime("2026-09-05T16:00:00Z"); // midnight in Shanghai, not UTC
  assert.equal((await f.read("?visit=1")).cache.state, "updated");
  assert.equal(f.logs.filter((r) => r.event === "sync_started").length, 3);
});

test("failed daily opening consumes the day; ordinary polling never starts initial exchange requests", async () => {
  const f = fixture();
  assert.equal((await f.read()).cache.state, "fresh");
  assert.equal(f.logs.length, 0);
  f.step("error");
  const first = await f.read("?visit=1");
  assert.equal(first.cache.state, "error");
  assert.equal(first.dailyRefreshPending, false);
  await f.read("?visit=1");
  await f.read();
  assert.equal(f.logs.filter((r) => r.event === "sync_started").length, 1);
});

test("daily opening waits for the scheduled retry window, then refreshes once after final partial or failure", async () => {
  for (const mode of ["partial", "error"]) {
    const f = fixture();
    f.setTime("2026-09-04T22:59:00Z");
    await f.refresh();
    f.setTime("2026-09-04T23:00:00Z");
    const waiting = await f.read("?visit=1");
    assert.equal(waiting.dailyRefreshPending, true);
    assert.equal(waiting.cache.state, "syncing");
    f.step(mode);
    await assert.rejects(f.refresh({ trigger: "scheduled", acceptPartial: false, persistFailure: false }));
    assert.equal((await f.read("?visit=1")).dailyRefreshPending, true);
    f.setTime("2026-09-04T23:04:00Z");
    await f.refresh({ trigger: "scheduled" }).catch(() => {});
    f.step("success");
    const result = await f.read("?visit=1");
    assert.equal(result.dailyRefreshPending, false);
    assert.equal(result.cache.state, "updated");
    assert.equal(f.logs.filter((r) => r.event === "sync_started" && r.trigger === "daily").length, 1);
  }
});

test("simultaneous opening and manual requests cannot overlap exchange work", async () => {
  const f = fixture();
  const resume = f.pause();
  const first = f.read("?visit=1");
  while (!f.logs.some((r) => r.event === "sync_started")) await new Promise(setImmediate);
  const otherDevice = await f.read("?visit=1");
  assert.equal(otherDevice.dailyRefreshPending, true);
  assert.equal(otherDevice.cache.state, "syncing");
  assert.equal((await f.read("?refresh=1")).cache.state, "syncing");
  assert.equal((await f.read()).cache.state, "syncing");
  assert.equal(f.logs.filter((r) => r.event === "sync_started").length, 1);
  resume();
  await first;
  assert.equal((await f.read("?visit=1")).dailyRefreshPending, false);
  assert.equal(f.logs.filter((r) => r.event === "sync_started").length, 1);
});

test("an expired request cannot replace a newer owner's saved result or failure state", async () => {
  const f = fixture();
  await f.refresh();
  f.step("success");
  const resume = f.pause();
  const opening = f.read("?visit=1");
  while (!f.logs.some((r) => r.event === "sync_started" && r.trigger === "daily")) await new Promise(setImmediate);
  f.setTime("2026-09-05T01:20:00Z");
  const control = f.load("@/lib/refresh-control");
  const newToken = await control.acquireRefresh(f.db, "test-user");
  assert.ok(newToken);
  f.db.sqlite.prepare("UPDATE sync_snapshots SET updated_at = ?, last_attempt_at = ?, last_error = NULL")
    .run(f.now(), f.now());
  resume();
  await opening;
  assert.equal(f.record().updated_at, f.now());
  assert.equal(f.record().last_error, null);
  assert.equal(f.logs.at(-1).errorKind, "refresh_superseded");
  assert.equal(f.logs.at(-1).committed, false);
  assert.equal(await control.refreshIsLocked(f.db, "test-user"), true);
});

test("a partial daily refresh also consumes the day without running a second exchange attempt", async () => {
  const f = fixture();
  f.step("partial");
  assert.equal((await f.read("?visit=1")).partial, true);
  f.step("success");
  const again = await f.read("?visit=1");
  assert.equal(again.partial, true);
  assert.equal(again.dailyRefreshPending, false);
  assert.equal(f.logs.filter((r) => r.event === "sync_started").length, 1);
});

test("a failed readback after a successful commit is not logged as an uncommitted refresh", async () => {
  const f = fixture();
  f.step("readback-error");
  await assert.rejects(f.refresh());
  assert.ok(f.record().payload);
  assert.equal(f.logs.at(-1).event, "sync_finished");
  assert.equal(f.logs.at(-1).outcome, "error");
  assert.equal(f.logs.at(-1).committed, true);
});

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
