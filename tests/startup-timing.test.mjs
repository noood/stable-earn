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

test("request timing formats actual navigation intervals and ignores unrecognised header contents", () => {
  const formatted = formatStartupRequestTiming('app;dur=50.0,auth;dur=10.0;desc="start=2.0",other;dur=40.0,secret;dur=5;desc="account-secret"', 100, 180);
  assert.match(formatted, /浏览器 80ms · 导航后 100→180ms · 服务端 50ms/);
  assert.match(formatted, /登录校验 10ms（接口内 2→12ms）/);
  assert.match(formatted, /其余处理 40ms/);
  assert.doesNotMatch(formatted, /secret/);
});
