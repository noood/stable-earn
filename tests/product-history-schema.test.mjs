import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const load = moduleLoader();
const { historySchemaStatements } = load("@/lib/product-history-schema");
const { schemaStatements } = load("@/db/schema");
const historySql = historySchemaStatements.join(";\n") + ";";
const migrationSql = readFileSync(new URL("../drizzle/0021_product_history_summaries.sql", import.meta.url), "utf8");

function database(t, initialize = false) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const sql of schemaStatements) {
    if (!historySchemaStatements.includes(sql)) db.exec(sql);
  }
  if (initialize) apply(db, historySql);
  return db;
}

function apply(db, sql) {
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function rows(db, sql, ...args) {
  return db.prepare(sql).all(...args).map((row) => ({ ...row }));
}

function state(db, owner = "a") {
  return rows(db, "SELECT revision, event_count FROM product_history_state WHERE owner_id = ?", owner)[0] ?? null;
}

function insert(db, { owner = "a", product = "p", id = "e", attention = 0, readAt = null } = {}) {
  // This is the INSERT used by pre-migration application code: no summary writes.
  return db.prepare(`INSERT OR IGNORE INTO product_change_events
    (owner_id, event_id, product_id, change_type, title, observed_at, source, attention, read_at)
    VALUES (?, ?, ?, 'holding', 'changed', '2026-10-21T00:00:00Z', '每日首次打开', ?, ?)`)
    .run(owner, id, product, attention, readAt);
}

function assertCounts(db) {
  assert.deepEqual(rows(db, `SELECT * FROM product_history_summaries ORDER BY owner_id, product_id`),
    rows(db, `SELECT owner_id, product_id, COUNT(*) AS event_count,
      SUM(CASE WHEN attention = 1 AND read_at IS NULL THEN 1 ELSE 0 END) AS unread_count
      FROM product_change_events GROUP BY owner_id, product_id ORDER BY owner_id, product_id`));
  for (const owner of rows(db, "SELECT owner_id, event_count FROM product_history_state")) {
    assert.equal(owner.event_count, db.prepare("SELECT COUNT(*) AS n FROM product_change_events WHERE owner_id = ?").get(owner.owner_id).n);
  }
}

test("migration and cold-start initialization use equivalent SQL", () => {
  const normalize = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  assert.equal(normalize(migrationSql), normalize(historySql));
  assert.deepEqual(schemaStatements.slice(-historySchemaStatements.length), historySchemaStatements);
});

for (const [name, sql] of [["migration", migrationSql], ["cold start", historySql]]) {
  test(`${name} backfills existing accounts and products without changing event read states`, (t) => {
    const db = database(t);
    insert(db, { id: "old-unread", attention: 1 });
    insert(db, { id: "old-read", attention: 1, readAt: "2026-10-20T12:00:00Z" });
    insert(db, { product: "q", id: "ordinary" });
    insert(db, { owner: "b", id: "other-user", attention: 1 });
    const before = rows(db, "SELECT * FROM product_change_events ORDER BY owner_id, event_id");
    apply(db, sql);
    assertCounts(db);
    assert.deepEqual(rows(db, "SELECT * FROM product_change_events ORDER BY owner_id, event_id"), before);
    assert.deepEqual(state(db), { revision: 1, event_count: 3 });
    assert.deepEqual(state(db, "b"), { revision: 1, event_count: 1 });
    assert.equal(state(db, "no-history"), null);
    assert.deepEqual(rows(db, "SELECT * FROM product_history_meta"), [{ singleton: 1, version: 1 }]);
    assert.deepEqual(rows(db, "SELECT * FROM product_history_cache"), []);
    insert(db, { owner: "new-user", id: "first", attention: 1 });
    assert.deepEqual(state(db, "new-user"), { revision: 1, event_count: 1 });
    assertCounts(db);
  });
}

test("legacy inserts maintain isolated summaries and duplicate INSERT OR IGNORE leaves revisions alone", (t) => {
  const db = database(t, true);
  assert.deepEqual(rows(db, "SELECT * FROM product_history_summaries"), []);
  insert(db, { attention: 1 });
  assert.deepEqual(state(db), { revision: 1, event_count: 1 });
  insert(db, { attention: 0 });
  assert.deepEqual(state(db), { revision: 1, event_count: 1 });
  insert(db, { product: "q", id: "second" });
  insert(db, { owner: "b", attention: 1 });
  assert.deepEqual(state(db), { revision: 2, event_count: 2 });
  assert.deepEqual(state(db, "b"), { revision: 1, event_count: 1 });
  assertCounts(db);
});

test("actual read/attention changes adjust unread counts and revision; no-op updates do not", (t) => {
  const db = database(t, true);
  insert(db, { attention: 1 });
  insert(db, { owner: "b", attention: 1 });
  const update = (sql) => db.exec(`${sql} WHERE owner_id = 'a' AND event_id = 'e'`);
  update("UPDATE product_change_events SET read_at = '2026-10-21T01:00:00Z'");
  assert.deepEqual(state(db), { revision: 2, event_count: 1 });
  assertCounts(db);
  update("UPDATE product_change_events SET read_at = read_at, attention = attention");
  assert.deepEqual(state(db), { revision: 2, event_count: 1 });
  update("UPDATE product_change_events SET attention = 0");
  update("UPDATE product_change_events SET read_at = NULL");
  update("UPDATE product_change_events SET attention = 1");
  assert.deepEqual(state(db), { revision: 5, event_count: 1 });
  assert.equal(db.prepare("SELECT unread_count FROM product_history_summaries WHERE owner_id = 'a'").get().unread_count, 1);
  update("UPDATE product_change_events SET title = 'corrected'");
  assert.deepEqual(state(db), { revision: 6, event_count: 1 });
  assert.deepEqual(state(db, "b"), { revision: 1, event_count: 1 });
  assertCounts(db);
});

test("event identities are immutable, including UPDATE OR IGNORE", (t) => {
  const db = database(t, true);
  insert(db);
  for (const field of ["owner_id", "product_id", "event_id"]) {
    assert.throws(() => db.exec(`UPDATE OR IGNORE product_change_events SET ${field} = 'other'`), /identity is immutable/);
  }
  db.exec("UPDATE product_change_events SET owner_id = owner_id, product_id = product_id, event_id = event_id");
  assert.deepEqual(state(db), { revision: 1, event_count: 1 });
  assertCounts(db);
});

test("deletes remove empty product summaries and invalidate caches through a monotonic account revision", (t) => {
  const db = database(t, true);
  insert(db, { attention: 1 });
  insert(db, { id: "second" });
  insert(db, { product: "q", id: "third", attention: 1 });
  db.exec("INSERT INTO product_history_cache VALUES ('a', 2000, 3, 'cached')");
  db.exec("DELETE FROM product_change_events WHERE event_id = 'e'");
  assert.deepEqual(state(db), { revision: 4, event_count: 2 });
  assertCounts(db);
  db.exec("DELETE FROM product_change_events WHERE product_id = 'p'");
  assert.deepEqual(rows(db, "SELECT product_id FROM product_history_summaries"), [{ product_id: "q" }]);
  db.exec("DELETE FROM product_change_events");
  assert.deepEqual(state(db), { revision: 6, event_count: 0 });
  assert.deepEqual(rows(db, "SELECT * FROM product_history_summaries"), []);
  assert.equal(db.prepare("SELECT revision FROM product_history_cache").get().revision, 3);
  insert(db);
  assert.deepEqual(state(db), { revision: 7, event_count: 1 });
  assertCounts(db);
});

test("transaction rollback restores events, derived counters and cache revisions together", (t) => {
  const db = database(t, true);
  insert(db, { attention: 1 });
  const before = rows(db, "SELECT * FROM product_change_events");
  assert.throws(() => apply(db, `UPDATE product_change_events SET read_at = 'read';
    INSERT INTO product_change_events SELECT owner_id, 'extra', product_id, change_type, title,
      before_value, after_value, observed_at, source, attention, read_at FROM product_change_events;
    DELETE FROM product_change_events WHERE event_id = 'e';
    SELECT no_such_function();`), /no such function/);
  assert.deepEqual(rows(db, "SELECT * FROM product_change_events"), before);
  assert.deepEqual(state(db), { revision: 1, event_count: 1 });
  assertCounts(db);
});

test("backfill and ready marker roll back if initialization is interrupted before completion", (t) => {
  const db = database(t);
  insert(db, { attention: 1 });
  const interrupted = historySchemaStatements.slice(0, -1).join(";\n") + "; SELECT no_such_function();";
  assert.throws(() => apply(db, interrupted), /no such function/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'product_history_%'").get().n, 0);
  apply(db, historySql);
  assertCounts(db);
});

test("repeated migration and initialization preserve revisions, read states and cached payloads", (t) => {
  const db = database(t, true);
  insert(db, { attention: 1 });
  db.exec("UPDATE product_change_events SET read_at = 'already-read'");
  db.exec("INSERT INTO product_history_cache VALUES ('a', 2000, 2, 'cached')");
  const before = ["product_history_state", "product_history_summaries", "product_history_cache", "product_change_events"]
    .map((table) => rows(db, `SELECT * FROM ${table}`));
  for (const sql of [migrationSql, schemaStatements.join(";\n") + ";", historySql]) apply(db, sql);
  assert.deepEqual(["product_history_state", "product_history_summaries", "product_history_cache", "product_change_events"]
    .map((table) => rows(db, `SELECT * FROM ${table}`)), before);
  assertCounts(db);
});

test("ready marker prevents entering either historical backfill scan on later cold starts", (t) => {
  const db = database(t, true);
  insert(db);
  let scans = 0;
  db.function("history_scan_probe", () => { scans += 1; return -1; });
  // LIMIT forces a runtime callback when SQLite enters the source view at all,
  // rather than merely counting returned rows after the marker predicate.
  db.exec(`ALTER TABLE product_change_events RENAME TO history_source;
    CREATE VIEW product_change_events AS SELECT * FROM history_source LIMIT history_scan_probe()`);
  apply(db, historySql);
  apply(db, migrationSql);
  assert.equal(scans, 0);
  db.exec("DELETE FROM product_history_meta");
  for (const sql of historySchemaStatements.filter((sql) => sql.startsWith("INSERT INTO product_history_summaries") || sql.startsWith("INSERT INTO product_history_state"))) db.exec(sql);
  assert.equal(scans, 2, "positive control: each uninitialized backfill enters the historical source");
});
