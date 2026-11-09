import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { withStartupServerTiming } = moduleLoader()("@/lib/startup-timing");
const { formatStartupRequestTiming } = moduleLoader()("@/lib/startup-timing-format");

test("server timing is omitted unless private startup diagnostics are enabled", async () => {
  const response = await withStartupServerTiming(
    new Request("https://app.example/private/api/holdings"),
    async () => new Response("ok", { headers: { "Cache-Control": "private" } }),
  );

  assert.equal(response.headers.get("server-timing"), null);
  assert.equal(response.headers.get("cache-control"), "private");
  assert.equal(await response.text(), "ok");
});

test("diagnostics timing preserves the response and exposes only a duration header", async () => {
  const response = await withStartupServerTiming(
    new Request("https://app.example/private/api/products?visit=1&diagnostics=1"),
    async () => new Response(JSON.stringify({ products: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "private" },
    }),
  );

  assert.match(response.headers.get("server-timing") ?? "", /^app;dur=\d+(?:\.\d+)?$/);
  assert.equal(response.headers.get("cache-control"), "private");
  assert.deepEqual(await response.json(), { products: [] });
});

test("overlapping stages retain their offsets and do not double-count the unmeasured remainder", async () => {
  let now = 0;
  const { withStartupServerTiming: timed } = moduleLoader({}, { performance: { now: () => now } })("@/lib/startup-timing");
  const response = await timed(new Request("https://app.example/private/api/products?diagnostics=1"), async (timing) => {
    let finishHistory;
    const history = timing.measure("history", () => new Promise((resolve) => { finishHistory = resolve; }));
    now = 2;
    await timing.measure("lock_release", async () => { now = 8; });
    now = 10;
    finishHistory();
    await history;
    now = 12;
    return new Response("ok");
  });
  assert.equal(response.headers.get("server-timing"), 'app;dur=12.0,history;dur=10.0;desc="start=0.0",lock_release;dur=6.0;desc="start=2.0",other;dur=2.0');
});

test("disabled diagnostics execute each operation once and add no timing fields", async () => {
  let calls = 0;
  const response = await withStartupServerTiming(new Request("https://app.example/private/api/products"), async (timing) => {
    const result = await timing.measure("auth", async () => { calls += 1; return "ok"; });
    return new Response(result);
  });
  assert.equal(calls, 1);
  assert.equal(await response.text(), "ok");
  assert.equal(response.headers.get("server-timing"), null);
});

test("a slow cache read records concurrent pending stages without account or request data", async () => {
  let now = 0;
  let watchdog;
  let cleared = false;
  const records = [];
  const { withStartupServerTiming: timed } = moduleLoader({}, {
    performance: { now: () => now },
    crypto: { randomUUID: () => "random-correlation-id" },
    setTimeout: (callback, delay) => { assert.equal(delay, 5000); watchdog = callback; return 1; },
    clearTimeout: () => { cleared = true; },
    console: { warn: (record) => records.push(record), info: (record) => records.push(record) },
  })("@/lib/startup-timing");
  let finishSnapshot;
  let finishHistory;
  const snapshotGate = new Promise((resolve) => { finishSnapshot = resolve; });
  const historyGate = new Promise((resolve) => { finishHistory = resolve; });
  const pending = timed(new Request("https://app.example/private/api/products?private=account-value"), async (timing) => {
    await timing.measure("auth", async () => { now = 10; });
    timing.record("snapshot_sql", 3.5);
    timing.record("history_summary_rows", 123);
    await Promise.all([
      timing.measure("snapshot_read", async () => { await snapshotGate; }),
      timing.measure("history", async () => { await historyGate; }),
    ]);
    await timing.measure("maturities", async () => {});
    timing.record("history_summary_d1", 4.2);
    return new Response("ok");
  }, { watchSlowProductRead: true });
  await new Promise((resolve) => setImmediate(resolve));
  now = 5000;
  watchdog();
  assert.equal(records[0].event, "product_cache_read_slow");
  assert.equal(records[0].requestId, "random-correlation-id");
  assert.deepEqual(records[0].active.map((item) => item.phase), ["snapshot_read", "history"]);
  assert.deepEqual(records[0].completed.map((item) => [item.phase, item.outcome]), [["auth", "ok"]]);
  assert.deepEqual(records[0].metrics, { snapshot_sql: 3.5 });
  assert.doesNotMatch(JSON.stringify(records), /account-value|app\.example|private=/);
  finishSnapshot();
  finishHistory();
  now = 5100;
  const response = await pending;
  assert.equal(await response.text(), "ok");
  assert.equal(response.headers.get("server-timing"), null);
  assert.deepEqual(records.filter((record) => record.event === "product_cache_read_phase").map((record) => [record.phase, record.state]), [["snapshot_read", "ok"], ["history", "ok"], ["maturities", "started"], ["maturities", "ok"]]);
  assert.deepEqual(records.filter((record) => record.event === "product_cache_read_metric").map(({ metric, value }) => [metric, value]), [["history_summary_d1", 4.2]]);
  assert.equal(records.at(-1).event, "product_cache_read_finished");
  assert.equal(records.at(-1).status, 200);
  assert.equal(cleared, true);
});

test("fast cache reads do not emit slow diagnostics", async () => {
  const records = [];
  let cleared = false;
  const { withStartupServerTiming: timed } = moduleLoader({}, {
    crypto: { randomUUID: () => "id" },
    setTimeout: () => 1,
    clearTimeout: () => { cleared = true; },
    console: { warn: (record) => records.push(record), info: (record) => records.push(record) },
  })("@/lib/startup-timing");
  const response = await timed(new Request("https://app.example/private/api/products"), async (timing) => {
    await timing.measure("snapshot_read", async () => {});
    return new Response("ok");
  }, { watchSlowProductRead: true });
  assert.equal(await response.text(), "ok");
  assert.equal(cleared, true);
  assert.deepEqual(records, []);
});

test("slow stage errors keep their original behavior without logging exception details", async () => {
  let watchdog;
  let rejectQuery;
  const records = [];
  const { withStartupServerTiming: timed } = moduleLoader({}, {
    crypto: { randomUUID: () => "id" },
    setTimeout: (callback) => { watchdog = callback; return 1; },
    clearTimeout: () => {},
    console: { warn: (record) => records.push(record), info: (record) => records.push(record) },
  })("@/lib/startup-timing");
  const query = new Promise((_, reject) => { rejectQuery = reject; });
  const pending = timed(new Request("https://app.example/private/api/products"), async (timing) => {
    await timing.measure("snapshot_query", () => query);
    return new Response("unexpected");
  }, { watchSlowProductRead: true });
  watchdog();
  const error = new TypeError("private account and database details");
  rejectQuery(error);
  await assert.rejects(pending, (caught) => caught === error);
  assert.equal(records.find((record) => record.event === "product_cache_read_phase" && record.state === "error").errorKind, "type_error");
  assert.equal(records.at(-1).outcome, "error");
  assert.doesNotMatch(JSON.stringify(records), /private account|database details/);
});

test("request timing formats actual navigation intervals and ignores unrecognised header contents", () => {
  const formatted = formatStartupRequestTiming('app;dur=50.0,auth;dur=10.0;desc="start=2.0",other;dur=40.0,secret;dur=5;desc="account-secret"', 100, 180);
  assert.match(formatted, /浏览器 80ms · 导航后 100→180ms · 服务端 50ms/);
  assert.match(formatted, /登录校验 10ms（接口内 2→12ms）/);
  assert.match(formatted, /其余处理 40ms/);
  assert.doesNotMatch(formatted, /secret/);
});
