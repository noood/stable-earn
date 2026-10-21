import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { schemaStatements } = moduleLoader()("@/db/schema");

function loadDb(db) {
  const runtime = { DB: db };
  const { getDatabase } = moduleLoader({
    "cloudflare:workers": { env: runtime },
    jose: { createRemoteJWKSet: () => { throw Error("unexpected public-key request"); }, customFetch: Symbol("customFetch"), jwtVerify: () => { throw Error("unexpected auth"); } },
  })("@/lib/db");
  return { getDatabase, runtime };
}

function database({ ready = false, emptyMeta = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  if (ready) for (const sql of schemaStatements) sqlite.exec(sql);
  else if (emptyMeta) sqlite.exec("CREATE TABLE product_history_meta (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)");
  const calls = { reads: 0, batches: [], prepared: [] };
  const db = {
    prepare(sql) {
      calls.prepared.push(sql);
      const statement = {
        bind() { return statement; },
        async first() { calls.reads++; return sqlite.prepare(sql).get() ?? null; },
        async run() { sqlite.exec(sql); return { success: true, results: [] }; },
      };
      return statement;
    },
    async batch(statements) {
      calls.batches.push(statements.length);
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  return { db, sqlite, calls, ...loadDb(db) };
}

test("a migrated cold binding checks its marker once without executing DDL", async () => {
  const f = database({ ready: true });
  assert.equal(await f.getDatabase(), f.db);
  assert.equal(await f.getDatabase(), f.db);
  assert.equal(f.calls.reads, 1);
  assert.deepEqual(f.calls.batches, []);
  assert.match(f.calls.prepared[0], /^SELECT version FROM product_history_meta WHERE singleton = 1$/);
  f.sqlite.close();
});

for (const emptyMeta of [false, true]) test(`fresh bootstrap is one complete atomic batch; empty meta table ${emptyMeta}`, async () => {
  const f = database({ emptyMeta });
  assert.equal(await f.getDatabase(), f.db);
  assert.equal(f.sqlite.prepare("SELECT version FROM product_history_meta WHERE singleton = 1").get().version, 1);
  assert.deepEqual(f.calls.batches, [schemaStatements.length]);
  assert.equal(f.calls.reads, 1);
  await f.getDatabase();
  assert.equal(f.calls.reads, 1);
  f.sqlite.close();
});

test("concurrent cold callers share one marker read and one bootstrap", async () => {
  const f = database();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.getDatabase()));
  assert.ok(results.every((result) => result === f.db));
  assert.equal(f.calls.reads, 1);
  assert.deepEqual(f.calls.batches, [schemaStatements.length]);
  f.sqlite.close();
});

test("a failed atomic bootstrap rolls back and a later caller can retry", async () => {
  const f = database();
  const originalBatch = f.db.batch;
  let first = true;
  f.db.batch = async (statements) => {
    if (first) {
      first = false;
      return originalBatch([...statements.slice(0, 2), { run: async () => { throw Error("bootstrap interrupted"); } }]);
    }
    return originalBatch(statements);
  };
  await assert.rejects(f.getDatabase(), /bootstrap interrupted/);
  assert.equal(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='product_history_meta'").get(), undefined);
  await f.getDatabase();
  assert.equal(f.calls.reads, 2);
  assert.equal(f.sqlite.prepare("SELECT version FROM product_history_meta WHERE singleton = 1").get().version, 1);
  f.sqlite.close();
});

test("failed/incomplete batch result arrays never mark the binding initialized", async () => {
  for (const badResults of [[], Array.from({ length: schemaStatements.length }, () => ({ success: false })),
    Array.from({ length: schemaStatements.length }, () => ({ results: [] }))]) {
    const f = database({ emptyMeta: true });
    const original = f.db.batch;
    f.db.batch = async () => badResults;
    await assert.rejects(f.getDatabase(), /initialization failed/);
    f.db.batch = original;
    await f.getDatabase();
    assert.equal(f.calls.reads, 2);
    f.sqlite.close();
  }
});

test("network, quota, and unrelated SQL errors propagate without schema writes; read failures are retryable", async () => {
  for (const message of ["network unavailable", "D1_ERROR: exceeded database read quota", "D1_ERROR: no such table: other_table: SQLITE_ERROR",
    "no such column: version", "permission denied", "no such table: product_history_meta_extra"]) {
    const calls = { reads: 0, writes: 0 };
    const error = new Error(message);
    let fail = true;
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => { calls.reads++; if (fail) throw error; return { version: 1 }; } }) }),
      batch: async () => { calls.writes++; return []; },
    };
    const { getDatabase } = loadDb(db);
    await assert.rejects(getDatabase(), (actual) => actual === error);
    assert.equal(calls.writes, 0);
    fail = false;
    assert.equal(await getDatabase(), db);
    assert.equal(calls.reads, 2);
  }
});

test("D1's wrapped error for the precise missing meta table permits bootstrap", async () => {
  const f = database();
  const prepare = f.db.prepare;
  f.db.prepare = (sql) => sql.startsWith("SELECT version")
    ? { bind: () => ({ first: async () => { throw new Error("D1_ERROR", { cause: new Error("no such table: main.product_history_meta: SQLITE_ERROR") }); } }) }
    : prepare(sql);
  await f.getDatabase();
  assert.deepEqual(f.calls.batches, [schemaStatements.length]);
  f.sqlite.close();
});

test("a present unsupported version is rejected without writes or silent downgrade", async () => {
  for (const version of [0, 2, 99, "unknown"]) {
    const f = database({ emptyMeta: true });
    f.sqlite.prepare("INSERT INTO product_history_meta VALUES (1,?)").run(version);
    await assert.rejects(f.getDatabase(), /Unsupported database schema version/);
    assert.deepEqual(f.calls.batches, []);
    assert.equal(f.sqlite.prepare("SELECT version FROM product_history_meta").get().version, version);
    f.sqlite.close();
  }
});

test("a missing DB binding fails closed and distinct bindings initialize separately", async () => {
  await assert.rejects(loadDb(undefined).getDatabase(), /DB is not configured/);
  const a = database({ ready: true }), b = database({ ready: true });
  await a.getDatabase();
  a.runtime.DB = b.db;
  assert.equal(await a.getDatabase(), b.db);
  assert.equal(a.calls.reads, 1);
  assert.equal(b.calls.reads, 1);
  a.sqlite.close(); b.sqlite.close();
});
