import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const load = moduleLoader();
const { loadPrivateProductsSnapshot } = load("@/lib/private-products-snapshot");
const { prepareSyncCacheSave } = load("@/lib/sync-cache");

test("cache and daily marker are read in one account-scoped statement", async () => {
  const db = sqliteDb();
  await db.batch([prepareSyncCacheSave(db, "a", "private-products", { value: "a" })]);
  await db.batch([prepareSyncCacheSave(db, "b", "private-products", { value: "b" })]);
  db.sqlite.prepare("INSERT INTO refresh_control (user_id, lease_until, daily_day) VALUES (?, ?, ?)")
    .run("a", 123456, "2026-10-20");
  let reads = 0;
  const snapshot = await loadPrivateProductsSnapshot({ prepare(sql) { reads++; return db.prepare(sql); } }, "a", "private-products");
  assert.equal(reads, 1);
  assert.deepEqual(snapshot.record.payload, { value: "a" });
  assert.equal(snapshot.leaseUntil, 123456);
  assert.equal(snapshot.dailyDay, "2026-10-20");
  assert.equal(snapshot.historyEventCount, 0);
  const other = await loadPrivateProductsSnapshot(db, "b", "private-products");
  assert.deepEqual(other.record.payload, { value: "b" });
  assert.equal(other.dailyDay, null);
});

test("missing rows keep an unknown cache, not an empty successful payload", async () => {
  const snapshot = await loadPrivateProductsSnapshot(sqliteDb(), "new", "private-products");
  assert.deepEqual(snapshot, { record: null, leaseUntil: 0, dailyDay: null, historyEventCount: 0 });
});

test("snapshot diagnostics separate one database call from parsing and retain only supplied metadata", async () => {
  const db = sqliteDb();
  await db.batch([prepareSyncCacheSave(db, "a", "private-products", { value: "private-data" })]);
  let reads = 0;
  const wrapped = { prepare(sql) { return { bind(...args) { return { async all() {
    reads++;
    const result = await db.prepare(sql).bind(...args).all();
    return { ...result, meta: { timings: { sql_duration_ms: 3.5 }, duration: 4.2, total_attempts: 2 } };
  } }; } }; } };
  const phases = [];
  const metrics = {};
  const timing = { enabled: true, async measure(phase, action) { phases.push(phase); return action(); }, record(name, value) { metrics[name] = value; } };
  const snapshot = await loadPrivateProductsSnapshot(wrapped, "a", "private-products", timing);
  assert.deepEqual(snapshot.record.payload, { value: "private-data" });
  assert.equal(reads, 1);
  assert.deepEqual(phases, ["snapshot_query", "snapshot_parse"]);
  assert.deepEqual(metrics, { snapshot_sql: 3.5, snapshot_d1: 4.2, snapshot_attempts: 2 });
  assert.doesNotMatch(JSON.stringify({ phases, metrics }), /private-data/);
  db.sqlite.close();
});

test("history version includes archived products and is isolated to the cache owner", async () => {
  const db = sqliteDb();
  const insert = db.sqlite.prepare(`INSERT INTO product_change_events
    (owner_id,event_id,product_id,change_type,title,observed_at,source,attention)
    VALUES (?,?,?,'rate','test','2026-10-20','手动刷新',0)`);
  insert.run("a", "one", "archived");
  insert.run("a", "two", "active");
  insert.run("b", "three", "active");
  assert.equal((await loadPrivateProductsSnapshot(db, "a", "private-products")).historyEventCount, 2);
  assert.equal((await loadPrivateProductsSnapshot(db, "b", "private-products")).historyEventCount, 1);
  db.sqlite.close();
});

test("unreadable cache preserves metadata without inventing a successful snapshot", async () => {
  const db = sqliteDb();
  db.sqlite.prepare(`INSERT INTO sync_snapshots (owner_id, cache_key, payload, updated_at, last_error)
    VALUES (?, ?, ?, ?, ?)`).run("a", "private-products", "{invalid", "invalid-date", "failed");
  const { record } = await loadPrivateProductsSnapshot(db, "a", "private-products");
  assert.equal(record.payload, null);
  assert.equal(record.updatedAt, null);
  assert.equal(record.lastError, "failed");
});
