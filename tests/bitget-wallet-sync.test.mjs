import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const userId = "wallet-test-user";
const walletAddress = `0x${"1".repeat(40)}`;
const holdingTime = "2026-10-29T01:00:00.000Z";
const off = { status: "not_configured", snapshot: null };
const failed = { status: "error", snapshot: null };

const holding = (amount = 123.456789, updatedAt = holdingTime) => ({ status: "synced", snapshot: { amount, updatedAt, blockNumber: "0x1234" } });

function fixture(configured = true) {
  const db = sqliteDb();
  if (configured) db.sqlite.prepare("INSERT INTO wallet_configs VALUES (?,?,?)").run(userId, walletAddress, holdingTime);
  let snapshots = {
    publicSnapshot: { rates: [], failures: [], partials: [] },
    binanceGlobalResult: off, binanceBahrainResult: off,
    bybitGlobalResult: off, bitgetResult: off, okxResult: off,
    walletHoldingResult: configured ? holding() : off,
  };
  const snapshotWallets = [];
  const load = moduleLoader({
    "@/lib/credentials": { loadCredentials: async () => ({}) },
    "./snapshots": { fetchPrivateSnapshots: async (_credentials, wallet) => {
      snapshotWallets.push(wallet);
      return snapshots;
    } },
    "@/lib/sync-diagnostics": {
      syncDiagnostic() {}, diagnosticErrorKind: () => "test",
      withSyncDiagnostics: (_userId, _options, operation) => operation(),
    },
  });
  return {
    db, load, snapshotWallets,
    update(patch) { snapshots = { ...snapshots, ...patch }; },
    async refresh() { return (await load("@/lib/private-sync/service").refreshPrivateProductsCache(db, userId)).payload; },
    savedHolding(id) { return db.sqlite.prepare("SELECT amount, updated_at FROM holdings WHERE user_id=? AND product_id=?").get(userId, id); },
    close() { db.sqlite.close(); },
  };
}

test("a successful RPC holding with missing manual APR is complete and has no API notice or retry", async () => {
  const f = fixture();
  try {
    const payload = await f.refresh();
    assert.equal(payload.partial, false);
    assert.deepEqual(payload.failures, []);
    assert.equal(payload.products.length, 1);
    const product = payload.products[0];
    assert.equal(product.accountId, "bitget-wallet-morph");
    assert.equal(product.productDataMode, "manual");
    assert.equal(product.holdingDataMode, "api");
    assert.equal(product.source.kind, "manual");
    assert.equal(product.capacityStatus, "unavailable");
    assert.equal(product.tierStructureStatus, "complete");
    assert.equal(product.rateCoverage, "unavailable");
    assert.equal(product.aprStatus, "unavailable");
    assert.equal(product.tiers[0].max, null);
    assert.equal(product.tiers[0].maxStatus, undefined);
    assert.equal(payload.holdingUpdates[product.id], 123.456789);
    assert.equal(payload.holdingSyncStates[product.id], "synced");
    assert.equal(payload.holdingFetchedAt[product.id], holdingTime);
    assert.equal(payload.holdingFallbacks[product.id], undefined);
    assert.equal(f.savedHolding(product.id).amount, 123.456789);
    assert.equal(f.savedHolding(product.id).updated_at, holdingTime);
    assert.deepEqual(payload.apiFieldNotices, []);
    const cached = await f.load("@/lib/sync-cache").loadSyncCache(f.db, userId, "private-products");
    const candidate = await f.load("@/lib/private-sync/payload").buildPrivatePayload(f.db, userId, cached);
    assert.equal(candidate.retryable, false);
  } finally { f.close(); }
});

test("consecutive RPC failures keep the old holding and its original chain time", async () => {
  const f = fixture();
  try {
    const first = await f.refresh();
    const id = first.products[0].id;
    f.update({ walletHoldingResult: failed });
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = await f.refresh();
      assert.equal(next.partial, true);
      assert.deepEqual(next.failures, ["Bitget Wallet · Morph（持仓接口读取失败）"]);
      assert.equal(next.holdingUpdates[id], 123.456789);
      assert.equal(next.holdingSyncStates[id], "error");
      assert.equal(next.holdingFallbacks[id], holdingTime);
      assert.equal(next.holdingFetchedAt[id], holdingTime);
      assert.equal(next.rates[0].apr, 0);
      assert.equal(next.rates[0].rateCoverage, "unavailable");
      assert.equal(next.rates[0].productDataMode, "manual");
      assert.equal(f.savedHolding(id).updated_at, holdingTime);
      assert.equal(f.savedHolding(id).amount, 123.456789);
    }
  } finally { f.close(); }
});

test("obsolete automatic BGW APY is removed instead of restoring a cached rate or source", async () => {
  const f = fixture();
  try {
    const first = await f.refresh();
    const id = first.products[0].id;
    const oldTime = "2026-10-28T08:00:00.000Z";
    const automaticRate = { ...first.rates[0], rateBasis: "apy", productDataMode: "api", apr: 6.73,
      tiers: [{ min: 0, max: null, apr: 6.73 }], rateCoverage: "complete", aprStatus: "available",
      rateShape: "single_rate", fetchedAt: oldTime, sourceLabel: "Dune 参考 APY（含奖励）" };
    const automaticProduct = { ...first.products[0], rateBasis: "apy", productDataMode: "api", apiAccess: "public",
      tiers: [{ id: `${id}-tier-0`, min: 0, max: null, apr: 6.73 }],
      source: { kind: "live", label: automaticRate.sourceLabel, fetchedAt: oldTime },
      rateCoverage: "complete", aprStatus: "available", aprSource: "cache", aprFetchedAt: oldTime };
    const oldPayload = { ...first, rates: [automaticRate], products: [automaticProduct] };
    f.db.sqlite.prepare("UPDATE product_catalog SET payload=? WHERE owner_id=? AND product_id=?")
      .run(JSON.stringify(automaticProduct), userId, id);
    f.db.sqlite.prepare("UPDATE sync_snapshots SET payload=? WHERE owner_id=? AND cache_key='private-products'")
      .run(JSON.stringify(oldPayload), userId);
    f.update({ walletHoldingResult: holding(123.47, "2026-10-29T03:00:00.000Z") });
    const next = await f.refresh();
    const product = next.products.find((item) => item.id === id);
    const currentRate = next.rates.find((item) => item.productId === id);
    assert.equal(next.partial, false);
    assert.deepEqual(next.failures, []);
    assert.equal(product.productDataMode, "manual");
    assert.equal(product.source.kind, "manual");
    assert.equal(product.rateCoverage, "unavailable");
    assert.equal(product.tiers[0].apr, 0);
    assert.equal(product.aprSource, undefined);
    assert.equal(product.aprFetchedAt, undefined);
    assert.equal(currentRate.productDataMode, "manual");
    assert.equal(currentRate.apr, 0);
    assert.equal(currentRate.aprSource, undefined);
    assert.doesNotMatch(JSON.stringify(next), /Dune/);
    assert.equal(next.holdingUpdates[id], 123.47);
  } finally { f.close(); }
});

test("refresh updates only the chain holding and preserves a saved manual overall APR", async () => {
  const f = fixture();
  try {
    const first = await f.refresh();
    const id = first.products[0].id;
    f.db.sqlite.prepare(`INSERT INTO product_overrides
      (user_id, product_id, confirmed_apr, updated_at) VALUES (?,?,?,?)`)
      .run(userId, id, 6.72, holdingTime);
    for (const holdingResult of [holding(125), failed, holding(0)]) {
      f.update({ walletHoldingResult: holdingResult });
      const payload = await f.refresh();
      const override = f.db.sqlite.prepare("SELECT confirmed_apr, updated_at FROM product_overrides WHERE user_id=? AND product_id=?").get(userId, id);
      assert.equal(override.confirmed_apr, 6.72);
      assert.equal(override.updated_at, holdingTime);
      const product = payload.products.find((item) => item.id === id);
      const resolved = f.load("@/lib/product-overrides").applyProductOverride(product, { apr: override.confirmed_apr });
      assert.equal(f.load("@/lib/domain").effectiveApr(resolved, 1000), 6.72);
      assert.equal(f.load("@/lib/opportunity-policy").highestProductApr(resolved), 6.72);
    }
  } finally { f.close(); }
});

test("a successful zero RPC amount replaces persisted holdings and removes prior holding fallback", async () => {
  const f = fixture();
  try {
    const first = await f.refresh();
    const id = first.products[0].id;
    f.update({ walletHoldingResult: failed });
    const failedRefresh = await f.refresh();
    assert.equal(failedRefresh.holdingFallbacks[id], holdingTime);
    const zeroTime = "2026-10-29T04:00:00.000Z";
    f.update({ walletHoldingResult: holding(0, zeroTime) });
    const next = await f.refresh();
    assert.equal(next.partial, false);
    assert.equal(next.holdingUpdates[id], 0);
    assert.equal(next.holdingSyncStates[id], "synced");
    assert.equal(next.holdingFallbacks[id], undefined);
    assert.equal(f.savedHolding(id).amount, 0);
    assert.equal(f.savedHolding(id).updated_at, zeroTime);
  } finally { f.close(); }
});

test("without wallet configuration an empty snapshot does not create a BGW product", async () => {
  const f = fixture(false);
  try {
    const payload = await f.refresh();
    assert.equal(f.snapshotWallets.length, 1);
    assert.equal(f.snapshotWallets[0], null);
    assert.deepEqual(payload.products, []);
    assert.deepEqual(payload.rates, []);
    assert.deepEqual(payload.holdingUpdates, {});
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_catalog").get().n, 0);
  } finally { f.close(); }
});

test("the real snapshot orchestrator only reads a configured wallet and has no yield request", async () => {
  let walletRequests = 0;
  const unexpectedWalletRequest = async () => { walletRequests++; throw Error("unexpected wallet read"); };
  const load = moduleLoader({
    "@/lib/live-rates": { fetchPublicRateSnapshot: async () => ({ rates: [], failures: [] }) },
    "@/lib/integrations/binance": {},
    "@/lib/integrations/bitget": {},
    "@/lib/integrations/bybit": {},
    "@/lib/integrations/okx": {},
    "@/lib/integrations/bitget-wallet": { fetchBitgetWalletHolding: unexpectedWalletRequest },
    "@/lib/sync-diagnostics": { syncDiagnostic() {}, diagnosticErrorKind: () => "test", withSyncPlatform: (_scope, operation) => operation() },
  });
  const result = await load("@/lib/private-sync/snapshots").fetchPrivateSnapshots({}, null);
  assert.equal(walletRequests, 0);
  assert.deepEqual(result.walletHoldingResult, off);
  assert.equal(Object.hasOwn(result, "walletRateResult"), false);
  const connected = await load("@/lib/private-sync/snapshots").fetchPrivateSnapshots({}, { address: walletAddress });
  assert.equal(walletRequests, 1);
  assert.deepEqual(connected.walletHoldingResult.status, "error");
  assert.equal(Object.hasOwn(connected, "walletRateResult"), false);
});

test("switching wallets cannot restore the prior wallet holding or manual APR from an archived catalog row", async () => {
  const f = fixture();
  try {
    const first = await f.refresh();
    const id = first.products[0].id;
    const control = f.load("@/lib/refresh-control");
    const token = await control.supersedeRefreshForCredentialChange(f.db, userId);
    await f.load("@/lib/wallet-config").saveWalletConfig(f.db, userId, `0x${"2".repeat(40)}`, token);
    await control.releaseRefresh(f.db, userId, token);
    assert.equal(f.savedHolding(id), undefined);
    f.update({ walletHoldingResult: holding(25, "2026-10-29T05:00:00.000Z") });
    const next = await f.refresh();
    assert.equal(next.products.length, 1);
    assert.equal(next.products[0].id, id);
    assert.equal(next.products[0].rateCoverage, "unavailable");
    assert.equal(next.products[0].aprSource, undefined);
    assert.equal(next.products[0].aprFetchedAt, undefined);
    assert.equal(next.products[0].tiers[0].apr, 0);
    assert.equal(next.holdingUpdates[id], 25);
    assert.equal(next.holdingFallbacks[id], undefined);
  } finally { f.close(); }
});
