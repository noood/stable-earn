import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { freshHoldingIdsForSave } from "../lib/holding-cache.ts";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { dashboardReadState } = moduleLoader()("@/lib/sync-notice");
const source = ts.createSourceFile("page.tsx", readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ["initialize", "loadPersonalData", "refreshEndpoint", "refreshRates", "persistPortfolio"].includes(node.name?.text)) functions.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(functions.length, 5);
const code = ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const oldTime = "2026-09-08T03:09:00Z";
function payload(state = "fresh", failures = [], updatedAt = oldTime) {
  return { products: [{ id: "api", holdingDataMode: "api" }], rates: [],
    holdingUpdates: { api: 100 }, holdingSourceIds: ["api"], holdingFallbacks: {},
    partial: failures.length > 0, failures, dailyRefreshPending: false,
    cache: { state, updatedAt, lastAttemptAt: oldTime, lastError: null } };
}

async function open({ personalFailure = false, cacheFailure = false, dailyFailure = false, daily = true, result = payload("updated") } = {}) {
  const requests = [], writes = [], phases = [];
  const state = { setOpeningLoading: true, setHoldingsReady: false, setSyncFailures: [] };
  const deps = {
    isDemo: false, holdingsEndpoint: "/holdings", productsEndpoint: "/products", emptyHoldings: {},
    holdingsRef: { current: {} }, productOverridesRef: { current: {} }, manualProductsRef: { current: [] }, hiddenProductIdsRef: { current: [] },
    personalDataReadyRef: { current: false }, personalDataLoadingRef: { current: false },
    dailyRefreshPendingRef: { current: daily }, refreshInFlightRef: { current: false },
    freshHoldingIdsForSave, manualProductPayload: product => product,
    fetch: async (url, options) => {
      requests.push(url);
      if (options?.method === "PUT") {
        writes.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({}) };
      }
      if ((url === "/holdings" && personalFailure) || (url === "/products" && cacheFailure) || (url.endsWith("visit=1") && dailyFailure)) throw new Error("offline");
      const body = url === "/holdings" ? { holdings: { manual: 50 }, overrides: {}, manualProducts: [{ id: "manual" }], hiddenProductIds: [] }
        : url === "/products" ? payload() : url.endsWith("visit=1") ? result : { email: "test@example.test" };
      return { ok: true, json: async () => body };
    },
  };
  function view() {
    return dashboardReadState({ isDemo: false, opening: state.setOpeningLoading,
      requesting: Boolean(state.setLoading || state.setRefreshingExchange), backgroundUpdating: false,
      personalReady: state.setHoldingsReady, personalError: Boolean(state.setPersonalDataError),
      productReady: Boolean(state.setProductSnapshotReady), productReadFailed: state.setSyncFailures.includes("页面数据读取失败"),
      lastUpdated: state.setLastUpdated ?? null });
  }
  for (const [, name] of code.matchAll(/\b(set[A-Z]\w*)\(/g)) deps[name] = value => { state[name] = value; phases.push(view()); };
  const initialize = new Function(...Object.keys(deps), code + "; return initialize;")(...Object.values(deps));
  await initialize();
  return { requests, writes, phases, state, view: view() };
}

for (const personalFailure of [false, true]) for (const cacheFailure of [false, true]) {
  test("real opening flow: personal failure " + personalFailure + ", cache failure " + cacheFailure + ", daily success", async () => {
    const run = await open({ personalFailure, cacheFailure });
    assert.equal(run.requests.filter(url => url === "/products").length, 1);
    assert.equal(run.requests.filter(url => url === "/holdings").length - run.writes.length, 1);
    assert.equal(run.requests.filter(url => url === "/products?visit=1").length, 1);
    assert.ok(run.phases.slice(0, -1).every(phase => phase.updating));
    assert.equal(run.view.updating, false);
    assert.equal(run.view.dataBlocked, personalFailure);
    assert.equal(run.view.canEdit, !personalFailure);
    if (personalFailure) assert.equal(run.writes.length, 0);
    else assert.deepEqual(run.writes[0].holdings, { api: 100 });
  });
}

test("no daily refresh preserves partial cache warnings and performs no holding writes", async () => {
  // A visit that was already claimed simply returns the stored snapshot.
  const result = payload("fresh", ["Bitget（持仓接口未完整返回）"]);
  const run = await open({ result });
  assert.deepEqual(run.state.setSyncFailures, result.failures);
  assert.equal(run.state.setHasSyncFailure, true);
  assert.equal(run.view.dataBlocked, false);
  assert.equal(run.writes.length, 0);
});

test("failed cache and daily reads end in one server error, not empty success or endless loading", async () => {
  const run = await open({ cacheFailure: true, dailyFailure: true });
  assert.equal(run.view.dataBlocked, true);
  assert.equal(run.view.initialLoading, false);
  assert.equal(run.view.updating, false);
  assert.equal(run.writes.length, 0);
  assert.deepEqual(run.state.setManualProducts, [{ id: "manual" }]);
});

test("structured exchange total failure without history is not a server read error", async () => {
  const run = await open({ result: { ...payload("error", ["产品和持仓数据更新失败"], null), products: [], holdingUpdates: {} } });
  assert.equal(run.view.dataBlocked, false);
  assert.equal(run.view.updating, false);
  assert.equal(run.state.setHasSyncFailure, true);
  assert.deepEqual(run.state.setManualProducts, [{ id: "manual" }]);
  assert.equal(run.writes.length, 0);
});
