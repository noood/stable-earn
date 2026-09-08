import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("page.tsx", readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ["loadPersonalData", "retryPersonalData", "initialize"].includes(node.name?.text)) functions.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(functions.length, 3);
const code = ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(fetch) {
  const state = { setHoldings: { manual: 100 }, setHoldingsReady: false };
  const reads = [];
  const deps = {
    fetch, holdingsEndpoint: "/holdings", productsEndpoint: "/products", emptyHoldings: {}, isDemo: false,
    holdingsRef: { current: state.setHoldings },
    productOverridesRef: { current: { manual: { apr: 8 } } },
    manualProductsRef: { current: [{ id: "manual" }] }, hiddenProductIdsRef: { current: ["hidden"] },
    personalDataReadyRef: { current: false }, personalDataLoadingRef: { current: false },
    refreshRates: async (...args) => { reads.push(args); },
    refreshEndpoint: () => "/products?visit=1",
  };
  for (const [, name] of code.matchAll(/\b(set[A-Z]\w*)\(/g)) deps[name] = (value) => { state[name] = value; };
  return {
    ...new Function(...Object.keys(deps), `${code}; return { loadPersonalData, retryPersonalData, initialize };`)(...Object.values(deps)),
    state, deps, reads,
  };
}

test("initial personal read failure remains visible even when the product request succeeds", async () => {
  const h = harness(async (url) => ({ ok: url !== "/holdings", json: async () => ({ email: "demo@example.test", products: [] }) }));
  await h.initialize();
  assert.equal(h.state.setPersonalDataError, true);
  assert.equal(h.state.setHoldingsReady, false);
  assert.equal(h.deps.personalDataReadyRef.current, false);
  assert.equal(h.reads.length, 1);
  assert.equal((await h.reads[0][1].response).ok, true);
});

for (const [name, response] of [
  ["network failure", async () => { throw new Error("offline"); }],
  ["HTTP failure", async () => ({ ok: false })],
  ["invalid JSON", async () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } })],
]) {
  test(`personal data ${name} preserves saved values and blocks readiness`, async () => {
    const h = harness(response);
    await h.retryPersonalData();
    assert.equal(h.state.setPersonalDataError, true);
    assert.equal(h.state.setPersonalDataLoading, false);
    assert.equal(h.state.setHoldingsReady, false);
    assert.deepEqual(h.state.setHoldings, { manual: 100 });
    assert.deepEqual(h.deps.manualProductsRef.current, [{ id: "manual" }]);
    assert.deepEqual(h.deps.productOverridesRef.current, { manual: { apr: 8 } });
    assert.deepEqual(h.deps.hiddenProductIdsRef.current, ["hidden"]);
    assert.equal(h.reads.length, 0);
  });
}

test("personal data retry restores all saved fields and only reads the product cache", async () => {
  let failed = true;
  const payload = { holdings: { manual: 120 }, overrides: { manual: { apr: 9 } }, manualProducts: [{ id: "manual" }], hiddenProductIds: ["hidden"] };
  const h = harness(async () => ({ ok: !failed, json: async () => payload }));
  await h.retryPersonalData();
  failed = false;
  await h.retryPersonalData();
  assert.equal(h.state.setPersonalDataError, false);
  assert.equal(h.state.setHoldingsReady, true);
  assert.deepEqual(h.state.setHoldings, payload.holdings);
  assert.deepEqual(h.state.setProductOverrides, payload.overrides);
  assert.deepEqual(h.state.setManualProducts, payload.manualProducts);
  assert.deepEqual(h.state.setHiddenProductIds, payload.hiddenProductIds);
  assert.deepEqual(h.reads, [[payload.holdings]]); // No manual:true / exchange refresh.
});

test("an actually empty personal portfolio is successful, not a read failure", async () => {
  const h = harness(async () => ({ ok: true, json: async () => ({ holdings: {}, found: false }) }));
  await h.retryPersonalData();
  assert.equal(h.state.setPersonalDataError, false);
  assert.equal(h.state.setHoldingsReady, true);
  assert.deepEqual(h.state.setHoldings, {});
});

test("concurrent personal-data retries share the in-flight guard", async () => {
  let finish;
  let calls = 0;
  const h = harness(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const first = h.retryPersonalData();
  await h.retryPersonalData();
  assert.equal(calls, 1);
  finish({ ok: true, json: async () => ({ holdings: {} }) });
  await first;
  assert.equal(h.deps.personalDataLoadingRef.current, false);
});
