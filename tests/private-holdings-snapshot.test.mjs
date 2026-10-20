import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const load = moduleLoader();
const { loadPrivateHoldingsSnapshot } = load("@/lib/private-holdings-snapshot");
const { loadCatalogProducts, loadCatalogRows } = load("@/lib/product-catalog");

function seed(db, owner = "a") {
  const product = {
    id: "catalog", identityKey: "catalog-key", accountId: "binance-global", asset: "USDT",
    productDataMode: "manual", holdingDataMode: "manual", productType: "flexible",
    source: { kind: "manual", label: "手动录入" }, tiers: [{ id: "tier", min: 0, max: null, apr: 8 }],
  };
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id,product_id,canonical_product_id,identity_key,payload,status,first_seen_at,last_seen_at)
    VALUES (?, 'catalog','catalog-key','catalog-key',?,'active','2026-10-01','2026-10-01')`)
    .run(owner, JSON.stringify(product));
  db.sqlite.prepare("INSERT INTO holdings VALUES (?,'catalog',100,'2026-10-01')").run(owner);
  db.sqlite.prepare(`INSERT INTO user_products VALUES
    (?,'manual-test','binance-global','USDT','fixed',7,'2026-10-01','2026-10-01')`).run(owner);
  db.sqlite.prepare(`INSERT INTO product_overrides
    (user_id,product_id,confirmed_apr,purchase_date,product_kind_override,updated_at)
    VALUES (?,'catalog',8,'2026-10-01','fixed','2026-10-01')`).run(owner);
  db.sqlite.prepare("INSERT INTO product_override_limits VALUES (?,'catalog',300,'2026-10-01')").run(owner);
  db.sqlite.prepare("INSERT INTO product_override_terms VALUES (?,'catalog',7,'2026-10-01')").run(owner);
  db.sqlite.prepare("INSERT INTO hidden_seed_products VALUES (?,'catalog','2026-10-01')").run(owner);
  db.sqlite.prepare("INSERT INTO hidden_products VALUES (?,'manual-test','2026-10-01')").run(owner);
  for (const [key, amount] of [["one", 10], ["two", 20]]) db.sqlite.prepare(`INSERT INTO holding_positions
    (user_id,product_id,position_key,amount,source,updated_at) VALUES (?,'catalog',?,?,'api','2026-10-01')`).run(owner, key, amount);
  return product;
}

test("holdings use one read-only batch with eight scoped statements and joined settings", async () => {
  const db = sqliteDb();
  seed(db);
  seed(db, "b");
  db.sqlite.prepare("UPDATE product_overrides SET confirmed_apr = 99 WHERE user_id = 'b'").run();
  db.sqlite.prepare("UPDATE product_override_limits SET first_tier_limit = 999 WHERE user_id = 'b'").run();
  db.sqlite.prepare("UPDATE product_override_terms SET term_days = 99 WHERE user_id = 'b'").run();
  const queries = [];
  let batches = 0;
  const snapshot = await loadPrivateHoldingsSnapshot({
    prepare(sql) { queries.push(sql); return db.prepare(sql); },
    batch(statements) { batches++; return db.batch(statements); },
  }, "a");
  assert.equal(batches, 1);
  assert.equal(queries.length, 8);
  assert.equal(queries.every((sql) => /^\s*SELECT\b/.test(sql)), true);
  assert.deepEqual(snapshot.catalogProducts.map((p) => p.id), ["catalog"]);
  assert.deepEqual(snapshot.manualProducts.map((p) => p.id), ["manual-test"]);
  assert.deepEqual(snapshot.holdingRows.map((r) => ({ ...r })), [{ product_id: "catalog", amount: 100 }]);
  assert.deepEqual(snapshot.positionRows.map((r) => ({ ...r })), [{ product_id: "catalog", amount: 30 }]);
  assert.deepEqual({ ...snapshot.overrideRows[0] }, {
    product_id: "catalog", confirmed_apr: 8, purchase_date: "2026-10-01", product_kind_override: "fixed",
    updated_at: "2026-10-01", first_tier_limit: 300, term_days: 7,
  });
  assert.deepEqual(snapshot.hiddenSeedRows.map((r) => r.product_id), ["catalog"]);
  assert.deepEqual(snapshot.hiddenCatalogRows.map((r) => r.product_id), ["manual-test"]);
  assert.equal((await loadPrivateHoldingsSnapshot(db, "b")).overrideRows[0].confirmed_apr, 99);
  assert.deepEqual((await loadPrivateHoldingsSnapshot(db, "missing")).holdingRows, []);
  db.sqlite.close();
});

test("cache projection returns only holding guard fields, not the product/rate payload", async () => {
  const db = sqliteDb();
  const needed = { holdingUpdates: { catalog: 50 }, holdingSyncStates: { catalog: "synced" }, holdingFallbacks: { another: "2026-10-01" } };
  const full = { ...needed, products: [{ privateDataNotNeeded: "x".repeat(100_000) }], rates: [{ apr: 8 }] };
  db.sqlite.prepare("INSERT INTO sync_snapshots (owner_id,cache_key,payload) VALUES ('a','private-products',?)").run(JSON.stringify(full));
  const snapshot = await loadPrivateHoldingsSnapshot(db, "a");
  assert.deepEqual(JSON.parse(snapshot.syncSnapshotPayload), needed);
  assert.ok(snapshot.syncSnapshotPayload.length < 300);
  db.sqlite.prepare("INSERT INTO sync_snapshots (owner_id,cache_key,payload) VALUES ('b','private-products',?)").run(JSON.stringify({ holdingUpdates: { catalog: 999 } }));
  assert.equal(JSON.parse((await loadPrivateHoldingsSnapshot(db, "a")).syncSnapshotPayload).holdingUpdates.catalog, 50);
  for (const payload of [null, "{broken", "[]", "null", "7", '"text"', "{}", '{"holdingUpdates":true}']) {
    db.sqlite.prepare("UPDATE sync_snapshots SET payload = ? WHERE owner_id = 'a'").run(payload);
    const value = (await loadPrivateHoldingsSnapshot(db, "a")).syncSnapshotPayload;
    if (payload === null || payload === "{broken") assert.equal(value, null);
    else assert.doesNotThrow(() => JSON.parse(value));
  }
  db.sqlite.close();
});

test("active catalog reads exclude archived payloads, while full sync reads retain archived identities", async () => {
  const db = sqliteDb();
  const product = seed(db);
  for (const [id, status, payload] of [
    ["archived", "archived", JSON.stringify({ ...product, id: "archived", large: "x".repeat(100_000) })],
    ["malformed", "active", "{broken"],
    ["legacy", "active", JSON.stringify({ ...product, id: "legacy", productDataMode: undefined })],
  ]) db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id,product_id,canonical_product_id,identity_key,payload,status,first_seen_at,last_seen_at)
    VALUES ('a',?,?,?, ?,?,'2026-10-01','2026-10-01')`).run(id, id, id, payload, status);
  let returnedBytes = 0;
  const observed = { ...db, batch: async (statements) => {
    const results = await db.batch(statements);
    returnedBytes = JSON.stringify(results[0].results).length;
    return results;
  } };
  const active = (await loadPrivateHoldingsSnapshot(observed, "a")).catalogProducts;
  assert.deepEqual(active.map((p) => p.id), ["catalog", "legacy"]);
  assert.deepEqual(active, await loadCatalogProducts(db, "a"));
  assert.equal(active[1].productDataMode, "manual");
  assert.ok(returnedBytes < 2000);
  assert.equal((await loadCatalogRows(db, "a")).length, 4);
  db.sqlite.close();
});

test("missing settings remain null and batch failures cannot masquerade as empty account data", async () => {
  const db = sqliteDb();
  seed(db);
  db.sqlite.prepare("DELETE FROM product_override_limits WHERE user_id = 'a'").run();
  db.sqlite.prepare("DELETE FROM product_override_terms WHERE user_id = 'a'").run();
  const snapshot = await loadPrivateHoldingsSnapshot(db, "a");
  assert.equal(snapshot.overrideRows[0].first_tier_limit, null);
  assert.equal(snapshot.overrideRows[0].term_days, null);
  for (const broken of [[], Array.from({ length: 8 }, () => ({ success: false, results: [] })),
    Array.from({ length: 8 }, () => ({ success: true }))]) {
    await assert.rejects(loadPrivateHoldingsSnapshot({ ...db, batch: async () => broken }, "a"), /snapshot unavailable/);
  }
  await assert.rejects(loadPrivateHoldingsSnapshot({ ...db, batch: async () => { throw Error("database unavailable"); } }, "a"), /database unavailable/);
  db.sqlite.close();
});
