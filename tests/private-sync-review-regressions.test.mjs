import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const off = { status: "not_configured", snapshot: null };
const observedAt = "2026-10-21T00:00:00.000Z";

function fixture() {
  const db = sqliteDb();
  let snapshots = {
    publicSnapshot: { rates: [], failures: [] },
    binanceGlobalResult: off, binanceBahrainResult: off,
    bybitGlobalResult: off, bitgetResult: off, okxResult: off,
  };
  const load = moduleLoader({
    "@/lib/credentials": { loadCredentials: async () => ({}) },
    "./snapshots": { fetchPrivateSnapshots: async () => snapshots },
    "@/lib/sync-diagnostics": {
      syncDiagnostic() {}, diagnosticErrorKind: () => "test",
      withSyncDiagnostics: (_userId, _options, operation) => operation(),
    },
  });
  return {
    db, load,
    update(patch) { snapshots = { ...snapshots, ...patch }; },
    async refresh() {
      return (await load("@/lib/private-sync/service").refreshPrivateProductsCache(db, "review-user")).payload;
    },
    close() { db.sqlite.close(); },
  };
}

function binance(account, amount, positionId, statuses = {}, dates = true) {
  const accountId = `binance-${account}`;
  const identityKey = `${accountId}:USDT:fixed:review-project`;
  return {
    status: "synced",
    snapshot: {
      rates: [{
        productId: identityKey, identityKey, externalProductId: "review-project",
        productType: "fixed", termDays: 7, apr: 8,
        tiers: [{ min: 0, max: 1000, apr: 8 }], rateCoverage: "complete",
        fetchedAt: observedAt, sourceLabel: "API",
        catalog: { accountId, exchange: "binance", region: account, asset: "USDT",
          holdingDataMode: "api", apiAccess: "authenticated" },
      }],
      holdings: { [identityKey]: amount },
      positions: amount > 0 ? [{ sourceProductId: identityKey, accountId, positionId, amount,
        ...(dates ? { purchaseAt: observedAt, redeemAt: "2026-10-28T00:00:00.000Z" } : {}) }] : [],
      apiStatuses: { flexibleProducts: "complete", flexibleHoldings: "complete",
        fixedProducts: "complete", fixedHoldings: "complete", ...statuses },
    },
  };
}

for (const [account, resultKey] of [["global", "binanceGlobalResult"], ["bahrain", "binanceBahrainResult"]]) {
  test(`${account}: complete locked holdings replace old positions despite flexible failure and persist their amount`, async () => {
    const f = fixture();
    try {
      f.update({ [resultKey]: binance(account, 100, "redeemed") });
      const first = await f.refresh();
      const productId = first.products[0].id;
      f.update({ [resultKey]: binance(account, 50, "new", { flexibleProducts: "error", flexibleHoldings: "error" }) });
      const next = await f.refresh();
      assert.equal(next.partial, true);
      assert.ok(next.failures.some((value) => value.includes("活期")));
      assert.equal(next.holdingSyncStates[productId], "synced");
      assert.deepEqual(next.holdingPositions.map((p) => [p.positionId, p.amount]), [["new", 50]]);
      assert.equal(f.db.sqlite.prepare("SELECT amount FROM holdings WHERE user_id = ? AND product_id = ?")
        .get("review-user", productId).amount, 50);
      const { summarizeHoldingTiming, hasCompletePurchaseTiming } = f.load("@/lib/holding-timing");
      assert.equal(hasCompletePurchaseTiming(summarizeHoldingTiming(next.holdingPositions), 50), true);
      assert.ok(next.holdingUpdates[productId] === 50);
    } finally { f.close(); }
  });
}

test("complete empty locked holdings remove redeemed dates even when product reads fail", async () => {
  const f = fixture();
  try {
    f.update({ binanceGlobalResult: binance("global", 100, "redeemed") });
    const first = await f.refresh();
    const productId = first.products[0].id;
    f.update({ binanceGlobalResult: binance("global", 0, null, { fixedProducts: "error", flexibleProducts: "error" }) });
    const next = await f.refresh();
    assert.deepEqual(next.holdingPositions, []);
    assert.equal(next.holdingUpdates[productId], 0);
    assert.equal(next.holdingSyncStates[productId], "synced");
    assert.equal(f.db.sqlite.prepare("SELECT amount FROM holdings WHERE product_id = ?").get(productId).amount, 0);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM holding_positions").get().n, 0);
  } finally { f.close(); }
});

test("complete locked snapshots never fill missing dates from the previous position", async () => {
  const f = fixture();
  try {
    f.update({ binanceGlobalResult: binance("global", 100, "same-id") });
    await f.refresh();
    f.update({ binanceGlobalResult: binance("global", 100, "same-id", { flexibleProducts: "error" }, false) });
    const next = await f.refresh();
    assert.equal(next.holdingPositions.length, 1);
    assert.equal(next.holdingPositions[0].purchaseAt, undefined);
    assert.equal(next.holdingPositions[0].redeemAt, undefined);
    const { summarizeHoldingTiming, hasCompletePurchaseTiming } = f.load("@/lib/holding-timing");
    assert.equal(hasCompletePurchaseTiming(summarizeHoldingTiming(next.holdingPositions), 100), false);
  } finally { f.close(); }
});

for (const status of ["partial", "error"]) {
  test(`an actually ${status} locked holding read preserves cached positions without affecting the other account`, async () => {
    const f = fixture();
    try {
      f.update({ binanceGlobalResult: binance("global", 100, "g-old"), binanceBahrainResult: binance("bahrain", 200, "b-old") });
      const first = await f.refresh();
      const oldProductId = first.products.find((p) => p.accountId === "binance-global").id;
      const broken = binance("global", 0, null, { fixedHoldings: status });
      broken.snapshot.holdings = {};
      f.update({ binanceGlobalResult: broken, binanceBahrainResult: binance("bahrain", 50, "b-new") });
      const next = await f.refresh();
      assert.deepEqual(next.holdingPositions.map((p) => p.positionId).sort(), ["b-new", "g-old"]);
      assert.equal(next.holdingSyncStates[oldProductId], status);
      assert.equal(next.holdingUpdates[oldProductId], 100);
      assert.ok(next.holdingFallbacks[oldProductId]);
    } finally { f.close(); }
  });
}

for (const invalidAssets of [["USDC"], []]) {
  test(`OKX incomplete balances always produce a visible scoped failure (${invalidAssets.join(",") || "unknown row"})`, async () => {
    const f = fixture();
    try {
      f.update({ okxResult: { status: "synced", snapshot: {
        holdings: { "okx-usdt": 100 }, invalidAssets, snapshotComplete: false,
      } } });
      const next = await f.refresh();
      assert.equal(next.partial, true);
      assert.equal(next.holdingSyncStates["okx-usdt"], "partial");
      const { syncFailureSummary } = f.load("@/lib/sync-notice");
      assert.match(syncFailureSummary(next.failures), /OKX.*持仓部分数据未返回/);
      if (invalidAssets.length) assert.match(syncFailureSummary(next.failures), /USDC/);
      assert.match(next.note, /OKX/);
    } finally { f.close(); }
  });
}

test("OKX partial notices sanitize diagnostics and do not relabel complete responses as failures", async () => {
  const { buildFailures } = moduleLoader()("@/lib/private-sync/status");
  const statuses = { binanceGlobal: "not_configured", binanceBahrain: "not_configured", bybitGlobal: "not_configured", bitget: "not_configured", okx: "partial" };
  assert.deepEqual(buildFailures(statuses, { okx: "unreadable_balance:USDC,private-value,USDC" }, []), ["OKX USDC 持仓部分数据未返回"]);
  assert.deepEqual(buildFailures({ ...statuses, okx: "synced" }, {}, []), []);
});
