import assert from "node:assert/strict";
import test from "node:test";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

function fixture(t) {
  const db = sqliteDb();
  t.after(() => db.sqlite.close());
  db.sqlite.exec("CREATE TABLE helper_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
  return db;
}

test("batch reads return rows and report zero changes even after an earlier write", async (t) => {
  const db = fixture(t);
  db.sqlite.prepare("INSERT INTO helper_probe VALUES (1, 7)").run();
  const results = await db.batch([
    db.prepare("-- leading comment\n SELECT value FROM helper_probe WHERE id = ?").bind(1),
    db.prepare("WITH item AS (SELECT value FROM helper_probe) SELECT value FROM item").bind(),
    db.prepare("SELECT value FROM helper_probe WHERE id = ?").bind(999),
  ]);
  assert.deepEqual(results.map((result) => result.results.map((row) => row.value)), [[7], [7], []]);
  assert.ok(results.every((result) => result.success && result.meta.changes === 0));
});

test("batch writes execute exactly once and preserve direct-write counts", async (t) => {
  const db = fixture(t);
  const results = await db.batch([
    db.prepare("INSERT INTO helper_probe VALUES (?, ?)").bind(1, 7),
    db.prepare("UPDATE helper_probe SET value = value + 1 WHERE id = ?").bind(1),
    db.prepare("INSERT OR IGNORE INTO helper_probe VALUES (?, ?)").bind(1, 99),
    db.prepare("UPDATE helper_probe SET value = 99 WHERE id = ?").bind(999),
    db.prepare("SELECT value FROM helper_probe").bind(),
  ]);
  assert.deepEqual(results.map((result) => result.meta.changes), [1, 1, 0, 0, 0]);
  assert.deepEqual(results.slice(0, 4).map((result) => result.results), [[], [], [], []]);
  assert.equal(results[0].meta.lastInsertRowid, 1);
  assert.equal(results[4].results[0].value, 8);
});

test("CTE writes with RETURNING return rows without double writes or counting trigger writes as direct changes", async (t) => {
  const db = fixture(t);
  db.sqlite.exec(`CREATE TABLE helper_audit (value INTEGER);
    CREATE TRIGGER helper_after_insert AFTER INSERT ON helper_probe BEGIN
      INSERT INTO helper_audit VALUES (NEW.value);
    END`);
  const result = await db.prepare(`WITH item(value) AS (SELECT ?)
    INSERT INTO helper_probe (value) SELECT value FROM item RETURNING id, value`).bind(9).run();
  assert.equal(result.success, true);
  assert.deepEqual(result.results.map((row) => ({ ...row })), [{ id: 1, value: 9 }]);
  assert.equal(result.meta.changes, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM helper_probe").get().n, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM helper_audit").get().n, 1);
});

test("a failed mixed read/write batch rolls back and later batches still work", async (t) => {
  const db = fixture(t);
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO helper_probe VALUES (1, 7)").bind(),
    db.prepare("SELECT value FROM helper_probe").bind(),
    db.prepare("INSERT INTO helper_absent VALUES (1)").bind(),
  ]), /no such table/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM helper_probe").get().n, 0);
  const [insert, read] = await db.batch([
    db.prepare("INSERT INTO helper_probe VALUES (1, 8)").bind(),
    db.prepare("SELECT value FROM helper_probe").bind(),
  ]);
  assert.equal(insert.meta.changes, 1);
  assert.equal(read.meta.changes, 0);
  assert.equal(read.results[0].value, 8);
});
