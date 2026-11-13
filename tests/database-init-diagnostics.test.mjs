import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function harness(db) {
  const records = [];
  let watchdog;
  let now = 0;
  const load = moduleLoader({
    "cloudflare:workers": { env: { DB: db } },
    jose: { createRemoteJWKSet: () => {}, customFetch: Symbol("fetch"), jwtVerify: () => {} },
  }, {
    performance: { now: () => now },
    crypto: { randomUUID: () => "correlation-id" },
    setTimeout: (callback, delay) => { assert.equal(delay, 5000); watchdog = callback; return 1; },
    clearTimeout: () => {},
    console: { warn: (record) => records.push(record), info: (record) => records.push(record) },
  });
  const { getDatabase } = load("@/lib/db");
  const { withStartupServerTiming } = load("@/lib/startup-timing");
  return {
    records,
    reportSlow: () => { now = 5000; watchdog(); },
    run: (kind) => withStartupServerTiming(new Request("https://app.example/private/api/products?secret=private"),
      async (timing) => {
        await timing.measure("database", () => getDatabase());
        return new Response("ok");
      }, kind === "holdings" ? { watchSlowHoldingsRead: true } : { watchSlowProductRead: true }),
  };
}

test("a pending marker check is reported for the actual request and does not cancel it", async () => {
  let finish;
  const db = { prepare: () => ({ bind: () => ({ first: () => new Promise((resolve) => { finish = resolve; }) }) }) };
  const h = harness(db);
  const pending = h.run("holdings");
  h.reportSlow();
  assert.equal(h.records[0].event, "holdings_read_slow");
  assert.deepEqual(h.records[0].active.map(({ phase }) => phase), ["database", "database_init_wait", "database_init_marker"]);
  finish({ version: 1 });
  assert.equal((await pending).status, 200);
  assert.ok(h.records.some((entry) => entry.phase === "database_init_marker" && entry.state === "ok"));
  assert.equal(h.records.at(-1).event, "holdings_read_finished");
  assert.doesNotMatch(JSON.stringify(h.records), /private|app\.example|secret/);
});

test("a pending schema batch is distinguished from a completed marker check", async () => {
  let finish;
  const db = {
    prepare: () => ({ bind: () => ({ first: async () => null }) }),
    batch: (statements) => new Promise((resolve) => { finish = () => resolve(statements.map(() => ({ success: true }))); }),
  };
  const h = harness(db);
  const pending = h.run("product");
  await new Promise((resolve) => setImmediate(resolve));
  h.reportSlow();
  assert.ok(h.records[0].active.some(({ phase }) => phase === "database_init_schema"));
  assert.ok(h.records[0].completed.some(({ phase, outcome }) => phase === "database_init_marker" && outcome === "ok"));
  finish();
  assert.equal((await pending).status, 200);
});

test("fast initialization failures produce a safe category without exposing the exception", async () => {
  const error = new TypeError("private database details");
  const db = { prepare: () => ({ bind: () => ({ first: async () => { throw error; } }) }) };
  const h = harness(db);
  await assert.rejects(h.run("product"), (caught) => caught === error);
  assert.deepEqual(h.records, [{ event: "database_init_failed", source: "product_cache_read", requestId: "correlation-id", phase: "database_init_marker", durationMs: 0, errorKind: "type_error" }]);
  assert.doesNotMatch(JSON.stringify(h.records), /private|database details/);
});

test("a missing marker table is an expected bootstrap path and fast success produces no logs", async () => {
  const db = {
    prepare: (sql) => sql.startsWith("SELECT version")
      ? { bind: () => ({ first: async () => { throw new Error("no such table: product_history_meta"); } }) }
      : {},
    batch: async (statements) => statements.map(() => ({ success: true })),
  };
  const h = harness(db);
  assert.equal((await h.run("product")).status, 200);
  assert.deepEqual(h.records, []);
});

test("unsupported versions and incomplete bootstrap results have distinct safe categories", async () => {
  const version = harness({ prepare: () => ({ bind: () => ({ first: async () => ({ version: 9 }) }) }) });
  await assert.rejects(version.run("product"), /Unsupported database schema version/);
  assert.equal(version.records[0].phase, "database_init_marker");
  assert.equal(version.records[0].errorKind, "unsupported_schema_version");
  const schema = harness({ prepare: () => ({ bind: () => ({ first: async () => null }) }), batch: async () => [] });
  await assert.rejects(schema.run("holdings"), /Database schema initialization failed/);
  assert.equal(schema.records[0].phase, "database_init_schema");
  assert.equal(schema.records[0].errorKind, "schema_initialization_incomplete");
  assert.equal(schema.records[0].source, "holdings_read");
});
