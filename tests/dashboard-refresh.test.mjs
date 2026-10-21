import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { formatStartupRequestTiming } = moduleLoader()("@/lib/startup-timing-format");

// Exercise the actual refresh and PUT-body construction inside Dashboard,
// with React state setters and network boundaries replaced by test doubles.
const source = ts.createSourceFile("dashboard.tsx", readFileSync(new URL("../app/components/dashboard/dashboard.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ["refreshEndpoint", "refreshRates", "persistPortfolio"].includes(node.name?.text)) functions.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(functions.length, 3);
const code = ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("daily opening and manual refresh use POST; ordinary cache polling stays GET", async () => {
  const requests = [], methods = [];
  const deps = {
    productsEndpoint: "/products", isDemo: false,
    lastProductRequestAtRef: { current: null },
    reportStartupDiagnostic: () => {},
    formatStartupRequestTiming,
    dailyRefreshPendingRef: { current: true }, refreshInFlightRef: { current: false },
    hiddenProductIdsRef: { current: [] },
    fetch: async (url, options) => {
      requests.push(url);
      methods.push(options?.method ?? "GET");
      return { ok: true, json: async () => ({
        dailyRefreshPending: requests.length === 1,
        products: [], rates: [], holdingUpdates: {},
        cache: { state: requests.length === 1 ? "syncing" : "fresh" },
      }) };
    },
  };
  for (const [, name] of code.matchAll(/\b(set[A-Z]\w*)\(/g)) deps[name] = () => {};
  const refresh = new Function(...Object.keys(deps), `${code}; return refreshRates;`)(...Object.values(deps));
  await refresh({});
  await refresh({}, { silent: true });
  await refresh({}, { silent: true });
  await refresh({}, { manual: true });
  assert.deepEqual(requests, ["/products?visit=1", "/products?visit=1", "/products", "/products?refresh=1"]);
  assert.deepEqual(methods, ["POST", "POST", "GET", "POST"]);
  assert.equal(deps.dailyRefreshPendingRef.current, false);
});

test("startup diagnostics distinguish a daily refresh request from a later cache poll", async () => {
  const diagnostics = [];
  let requests = 0;
  const deps = {
    productsEndpoint: "/products?diagnostics=1", isDemo: false,
    lastProductRequestAtRef: { current: null },
    reportStartupDiagnostic: (...entry) => diagnostics.push(entry),
    formatStartupRequestTiming,
    dailyRefreshPendingRef: { current: true }, refreshInFlightRef: { current: false },
    hiddenProductIdsRef: { current: [] },
    fetch: async () => {
      requests += 1;
      return { ok: true, status: 200, headers: { get: () => "app;dur=10" }, json: async () => ({
        dailyRefreshPending: false,
        dailyRefreshDiagnostic: { state: "skipped", reason: "already_attempted_today" },
        products: [], rates: [], holdingUpdates: {}, cache: { state: "fresh" },
      }) };
    },
  };
  for (const [, name] of code.matchAll(/\b(set[A-Z]\w*)\(/g)) deps[name] = () => {};
  const refresh = new Function(...Object.keys(deps), `${code}; return refreshRates;`)(...Object.values(deps));
  await refresh({});
  await refresh({}, { silent: true });

  assert.equal(requests, 2);
  assert.equal(diagnostics.findLast(([key]) => key === "daily-refresh")[1], "每日刷新请求");
  assert.match(diagnostics.findLast(([key]) => key === "daily-refresh")[2], /今天的刷新尝试已处理，本次只读取缓存/);
  assert.equal(diagnostics.findLast(([key]) => key === "product-poll")[1], "产品缓存轮询");
});

for (const scenario of [
  { name: "completed today", marker: { day: "2026-10-20", completed: true }, pending: false },
  { name: "not committed today", marker: { day: "2026-10-20", completed: false }, pending: true },
  { name: "missing marker", marker: undefined, pending: true },
  { name: "malformed marker", marker: { completed: true }, pending: true },
  { name: "failed cache read", readError: true, pending: true },
  { name: "saved final failure without a successful cache", marker: { day: "2026-10-20", completed: true }, finalFailure: true, pending: false },
]) {
  test(`opening cache controls the daily request safely: ${scenario.name}`, async () => {
    const requests = [], diagnostics = [];
    const deps = {
      productsEndpoint: "/products", isDemo: false,
      lastProductRequestAtRef: { current: null },
      reportStartupDiagnostic: (...entry) => diagnostics.push(entry), formatStartupRequestTiming,
      dailyRefreshPendingRef: { current: true }, refreshInFlightRef: { current: false },
      hiddenProductIdsRef: { current: [] },
      fetch: async (url, options) => {
        requests.push(options?.method ?? "GET");
        if (scenario.readError) throw Error("network");
        return { ok: !scenario.finalFailure, status: scenario.finalFailure ? 502 : 200, json: async () => ({
          products: [], rates: [], dailyRefresh: scenario.marker, dailyRefreshPending: false,
          cache: { state: scenario.finalFailure ? "error" : "fresh", updatedAt: null },
        }) };
      },
    };
    for (const [, name] of code.matchAll(/\b(set[A-Z]\w*)\(/g)) deps[name] = () => {};
    const refresh = new Function(...Object.keys(deps), `${code}; return refreshRates;`)(...Object.values(deps));
    await refresh({}, { cacheOnly: true });
    assert.equal(deps.dailyRefreshPendingRef.current, scenario.pending);
    assert.equal(diagnostics.some(([key, , message]) => key === "daily-refresh" && message.includes("无需请求")), !scenario.pending);
    if (deps.dailyRefreshPendingRef.current) await refresh({});
    assert.deepEqual(requests, scenario.pending ? ["GET", "POST"] : ["GET"]);
  });
}

for (const scenario of [
  { name: "partial result", state: "updated", fallbacks: { bitget: "2026-09-05T00:56:15.064Z" } },
  { name: "ordinary cache read", state: "fresh", fallbacks: {} },
  { name: "opening cache read preserves daily opportunity without writing holdings", state: "fresh", fallbacks: {}, daily: true, cacheOnly: true },
  { name: "total failure carrying old synced flags", state: "error", fallbacks: {} },
  { name: "silent cache polling", state: "updated", fallbacks: {}, silent: true },
  { name: "daily refresh resumed after background wait", state: "updated", fallbacks: {}, silent: true, daily: true },
  { name: "recovery with unchanged amount", state: "updated", fallbacks: {} },
  { name: "personal data unavailable", state: "updated", fallbacks: {}, personalReady: false },
]) {
  test(`dashboard displays API holdings without a second browser save: ${scenario.name}`, async () => {
    const writes = [];
    let displayed;
    const data = {
      products: ["bitget", "binance"].map((id) => ({ id, holdingDataMode: "api" })),
      holdingUpdates: { bitget: 299.64, binance: 0 }, holdingFallbacks: scenario.fallbacks,
      holdingSyncStates: { bitget: "synced", binance: "partial" }, cache: { state: scenario.state }, rates: [],
    };
    const deps = {
      isDemo: false, productsEndpoint: "/products", holdingsEndpoint: "/holdings",
      lastProductRequestAtRef: { current: null },
      reportStartupDiagnostic: () => {},
      formatStartupRequestTiming,
      hiddenProductIdsRef: { current: [] }, productOverridesRef: { current: {} }, manualProductsRef: { current: [] },
      personalDataReadyRef: { current: scenario.personalReady !== false },
      holdingsRef: { current: {} },
      refreshInFlightRef: { current: false }, dailyRefreshPendingRef: { current: Boolean(scenario.daily) },
      manualProductPayload: (product) => product,
      fetch: async (_url, options) => {
        if (options?.method === "PUT") writes.push(JSON.parse(options.body));
        return { ok: true, json: async () => options?.method === "PUT" ? {} : data };
      },
    };
    for (const [, name] of code.matchAll(/\b(set[A-Z]\w*)\(/g)) deps[name] = () => {};
    deps.setHoldings = (value) => { displayed = value; };
    const refresh = new Function(...Object.keys(deps), `${code}; return refreshRates;`)(...Object.values(deps));
    const read = await refresh({}, { silent: scenario.silent, cacheOnly: scenario.cacheOnly });
    assert.equal(read, true);
    if (scenario.cacheOnly) assert.equal(deps.dailyRefreshPendingRef.current, true);
    assert.deepEqual(displayed, data.holdingUpdates);
    assert.deepEqual(writes, []);
  });
}
