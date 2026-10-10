import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

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
    reportStartupDiagnostic: () => {},
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
      reportStartupDiagnostic: () => {},
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
