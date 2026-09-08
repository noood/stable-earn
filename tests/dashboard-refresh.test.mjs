import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { freshHoldingIdsForSave } from "../lib/holding-cache.ts";

// Exercise the actual refresh and PUT-body construction inside Dashboard,
// with React state setters and network boundaries replaced by test doubles.
const source = ts.createSourceFile("page.tsx", readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ["refreshEndpoint", "refreshRates", "persistPortfolio"].includes(node.name?.text)) functions.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(functions.length, 3);
const code = ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("page resumes a deferred daily opening, then returns to cache-only polling", async () => {
  const urls = [];
  const deps = {
    productsEndpoint: "/products", isDemo: false,
    dailyRefreshPendingRef: { current: true }, refreshInFlightRef: { current: false },
    hiddenProductIdsRef: { current: [] },
    fetch: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({
        dailyRefreshPending: urls.length === 1,
        products: [], rates: [], holdingUpdates: {},
        cache: { state: urls.length === 1 ? "syncing" : "fresh" },
      }) };
    },
  };
  for (const [, name] of code.matchAll(/\b(set[A-Z]\w*)\(/g)) deps[name] = () => {};
  const refresh = new Function(...Object.keys(deps), `${code}; return refreshRates;`)(...Object.values(deps));
  await refresh({});
  await refresh({}, { silent: true });
  await refresh({}, { silent: true });
  assert.deepEqual(urls, ["/products?visit=1", "/products?visit=1", "/products"]);
  assert.equal(deps.dailyRefreshPendingRef.current, false);
});

for (const scenario of [
  { name: "partial result", state: "updated", fallbacks: { bitget: "2026-09-05T00:56:15.064Z" }, saved: ["binance"] },
  { name: "ordinary cache read", state: "fresh", fallbacks: {}, saved: [] },
  { name: "total failure carrying old synced flags", state: "error", fallbacks: {}, saved: [] },
  { name: "silent cache polling", state: "updated", fallbacks: {}, silent: true, saved: [] },
  { name: "daily refresh resumed after background wait", state: "updated", fallbacks: {}, silent: true, daily: true, saved: ["bitget", "binance"] },
  { name: "recovery with unchanged amount", state: "updated", fallbacks: {}, saved: ["bitget", "binance"] },
  { name: "personal data unavailable", state: "updated", fallbacks: {}, personalReady: false, saved: [] },
]) {
  test(`dashboard saves only fresh holdings: ${scenario.name}`, async () => {
    const writes = [];
    let displayed;
    const data = {
      products: ["bitget", "binance"].map((id) => ({ id, holdingDataMode: "api" })),
      holdingUpdates: { bitget: 299.64, binance: 0 }, holdingFallbacks: scenario.fallbacks,
      holdingSyncStates: { bitget: "synced", binance: "partial" }, cache: { state: scenario.state }, rates: [],
    };
    const deps = {
      freshHoldingIdsForSave, isDemo: false, productsEndpoint: "/products", holdingsEndpoint: "/holdings",
      hiddenProductIdsRef: { current: [] }, productOverridesRef: { current: {} }, manualProductsRef: { current: [] },
      personalDataReadyRef: { current: scenario.personalReady !== false },
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
    await refresh({}, { silent: scenario.silent });
    assert.deepEqual(displayed, data.holdingUpdates);
    assert.deepEqual(writes.flatMap((body) => Object.keys(body.holdings)), scenario.saved);
    assert.deepEqual(writes.flatMap((body) => body.changedHoldingProductIds), scenario.saved);
  });
}
