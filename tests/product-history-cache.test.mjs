import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const { loadProductChangeEvents, markProductChangeEventsRead } = moduleLoader()("@/lib/product-change-events");
const isHistoryRead = (sql) => /\bFROM\s+product_change_events\b/i.test(sql);
const isCacheStore = (sql) => /\bINSERT\s+INTO\s+product_history_cache\b/i.test(sql);

function fixture(t) {
  const source = sqliteDb();
  t.after(() => source.sqlite.close());
  const calls = [];
  const controls = { denyHistoryReads: false, failStore: false, beforeStore: null };
  const db = {
    prepare(sql) {
      return { bind(...args) {
        const statement = source.prepare(sql).bind(...args);
        return Object.fromEntries(["first", "all", "run"].map((method) => [method, async () => {
          calls.push({ sql, args, method });
          if (controls.denyHistoryReads && isHistoryRead(sql)) throw new Error("unexpected history scan");
          if (method === "run" && isCacheStore(sql)) {
            if (controls.failStore) throw new Error("simulated derivative cache write failure");
            if (controls.beforeStore) await controls.beforeStore(args);
          }
          return statement[method]();
        }]));
      } };
    },
    batch: (statements) => source.batch(statements),
  };
  return { db, sqlite: source.sqlite, calls, controls };
}

function insert(f, id, { owner = "a", product = "p", attention = 0, at = "2026-10-21T00:00:00Z" } = {}) {
  f.sqlite.prepare(`INSERT OR IGNORE INTO product_change_events
    (owner_id, event_id, product_id, change_type, title, observed_at, source, attention)
    VALUES (?, ?, ?, 'rate', 'APR changed', ?, '手动刷新', ?)`)
    .run(owner, id, product, at, attention);
}

function stored(f, owner = "a", limit = 2000) {
  return f.sqlite.prepare("SELECT revision, payload FROM product_history_cache WHERE owner_id = ? AND limit_value = ?")
    .get(owner, limit);
}

const ids = (events) => events.map((event) => event.id);

test("legacy history cold build reads events once; subsequent warm reads do not touch the event table", async (t) => {
  const f = fixture(t);
  insert(f, "ordinary");
  insert(f, "alert", { attention: 1 });
  const cold = await loadProductChangeEvents(f.db, "a");
  assert.deepEqual(new Set(ids(cold)), new Set(["ordinary", "alert"]));
  assert.equal(f.calls.filter(({ sql }) => isHistoryRead(sql)).length, 2);
  assert.deepEqual(JSON.parse(stored(f).payload), cold);
  f.calls.length = 0;
  f.controls.denyHistoryReads = true;
  assert.deepEqual(await loadProductChangeEvents(f.db, "a"), cold);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "first");
  assert.match(f.calls[0].sql, /product_history_cache/);
});

test("empty accounts return empty history from metadata without a historical scan", async (t) => {
  const f = fixture(t);
  insert(f, "other", { owner: "other" });
  f.controls.denyHistoryReads = true;
  assert.deepEqual(await loadProductChangeEvents(f.db, "new-account"), []);
  assert.equal(f.calls.length, 1);
  assert.equal(stored(f, "new-account"), undefined);
});

test("cached payloads are isolated by owner and recent-event limit", async (t) => {
  const f = fixture(t);
  insert(f, "a-old", { at: "2026-10-20T00:00:00Z" });
  insert(f, "a-new");
  insert(f, "b-only", { owner: "b", product: "private-b" });
  assert.deepEqual(ids(await loadProductChangeEvents(f.db, "a", 1)), ["a-new"]);
  assert.deepEqual(ids(await loadProductChangeEvents(f.db, "a", 2)), ["a-new", "a-old"]);
  assert.deepEqual(ids(await loadProductChangeEvents(f.db, "b", 1)), ["b-only"]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM product_history_cache").get().n, 3);
  f.controls.denyHistoryReads = true;
  assert.deepEqual(ids(await loadProductChangeEvents(f.db, "a", 1)), ["a-new"]);
  assert.deepEqual(ids(await loadProductChangeEvents(f.db, "a", 2)), ["a-new", "a-old"]);
  assert.deepEqual(ids(await loadProductChangeEvents(f.db, "b", 1)), ["b-only"]);
});

test("legacy payload preserves old unread alerts beyond the recent limit and deduplicates recent unread rows", async (t) => {
  const f = fixture(t);
  insert(f, "old-alert", { attention: 1, at: "2020-01-01T00:00:00Z" });
  insert(f, "old-ordinary", { at: "2021-01-01T00:00:00Z" });
  insert(f, "recent-ordinary", { at: "2026-10-20T00:00:00Z" });
  insert(f, "recent-alert", { attention: 1 });
  const result = await loadProductChangeEvents(f.db, "a", 2);
  assert.deepEqual(ids(result), ["recent-alert", "recent-ordinary", "old-alert"]);
  assert.equal(result.filter((event) => event.id === "recent-alert").length, 1);
  f.controls.denyHistoryReads = true;
  assert.deepEqual(await loadProductChangeEvents(f.db, "a", 2), result);
});

test("appended and backdated events invalidate cache; marking an old alert read rebuilds the legacy union", async (t) => {
  const f = fixture(t);
  insert(f, "initial");
  await loadProductChangeEvents(f.db, "a", 1);
  const firstRevision = stored(f, "a", 1).revision;
  insert(f, "newer", { at: "2026-10-21T01:00:00Z" });
  assert.deepEqual(ids(await loadProductChangeEvents(f.db, "a", 1)), ["newer"]);
  assert.equal(stored(f, "a", 1).revision, firstRevision + 1);
  insert(f, "backdated-alert", { attention: 1, at: "2020-01-01T00:00:00Z" });
  assert.deepEqual(ids(await loadProductChangeEvents(f.db, "a", 1)), ["newer", "backdated-alert"]);
  assert.equal(stored(f, "a", 1).revision, firstRevision + 2);
  await markProductChangeEventsRead(f.db, "a", "p", ["backdated-alert"], "2026-10-21T02:00:00Z");
  assert.deepEqual(ids(await loadProductChangeEvents(f.db, "a", 1)), ["newer"]);
  assert.equal(stored(f, "a", 1).revision, firstRevision + 3);
  assert.equal(f.calls.filter(({ sql }) => isHistoryRead(sql)).length, 8);
});

test("mark-read updates remain visible when the alert is also in the cached recent page", async (t) => {
  const f = fixture(t);
  insert(f, "alert", { attention: 1 });
  assert.equal((await loadProductChangeEvents(f.db, "a"))[0].readAt, undefined);
  await markProductChangeEventsRead(f.db, "a", "p", ["alert"], "2026-10-21T02:00:00Z");
  const updated = await loadProductChangeEvents(f.db, "a");
  assert.equal(updated[0].readAt, "2026-10-21T02:00:00Z");
  f.controls.denyHistoryReads = true;
  assert.deepEqual(await loadProductChangeEvents(f.db, "a"), updated);
});

test("duplicate event inserts and no-op mark-read calls preserve a warm cache", async (t) => {
  const f = fixture(t);
  insert(f, "alert", { attention: 1 });
  await markProductChangeEventsRead(f.db, "a", "p", ["alert"], "already-read");
  const original = await loadProductChangeEvents(f.db, "a");
  const revision = stored(f).revision;
  insert(f, "alert", { attention: 0, product: "ignored-duplicate-product" });
  await markProductChangeEventsRead(f.db, "a", "p", ["alert"], "later-attempt");
  f.controls.denyHistoryReads = true;
  assert.deepEqual(await loadProductChangeEvents(f.db, "a"), original);
  assert.equal(stored(f).revision, revision);
});

for (const corrupt of ["invalid-json", "{}", "[]", "[{}]"]) {
  test(`corrupt cache ${corrupt} rebuilds real history instead of returning a false empty result`, async (t) => {
    const f = fixture(t);
    insert(f, "real");
    const original = await loadProductChangeEvents(f.db, "a");
    f.sqlite.prepare("UPDATE product_history_cache SET payload = ?").run(corrupt);
    f.calls.length = 0;
    assert.deepEqual(await loadProductChangeEvents(f.db, "a"), original);
    assert.equal(f.calls.filter(({ sql }) => isHistoryRead(sql)).length, 2);
    assert.deepEqual(JSON.parse(stored(f).payload), original);
  });
}

test("cache store failure keeps valid history readable and records only a cache failure metric", async (t) => {
  const f = fixture(t);
  insert(f, "still-readable", { attention: 1 });
  f.controls.failStore = true;
  const metrics = [];
  const timing = { measure: (_name, task) => task(), record: (name, value) => metrics.push([name, value]) };
  const result = await loadProductChangeEvents(f.db, "a", 2000, timing);
  assert.deepEqual(ids(result), ["still-readable"]);
  assert.equal(stored(f), undefined);
  assert.ok(metrics.some(([name, value]) => name === "history_cache_store_failed" && value === 1));
});

test("oversize payloads preserve all unread events without attempting to store an oversized cache row", async (t) => {
  const f = fixture(t);
  insert(f, "large-alert", { attention: 1 });
  const title = "测".repeat(340_000);
  f.sqlite.prepare("UPDATE product_change_events SET title = ?").run(title);
  const result = await loadProductChangeEvents(f.db, "a");
  assert.equal(result.length, 1);
  assert.equal(result[0].title, title);
  assert.equal(f.calls.some(({ sql }) => isCacheStore(sql)), false);
  assert.equal(stored(f), undefined);
});

test("missing or unsupported ready marker fails clearly instead of claiming an empty history", async (t) => {
  const f = fixture(t);
  insert(f, "existing");
  await loadProductChangeEvents(f.db, "a");
  f.sqlite.exec("DELETE FROM product_history_meta");
  await assert.rejects(loadProductChangeEvents(f.db, "a"), /summaries not initialized/);
  f.sqlite.exec("INSERT INTO product_history_meta VALUES (1, 2)");
  await assert.rejects(loadProductChangeEvents(f.db, "a"), /summaries not initialized/);
});

test("a slow older cache write cannot overwrite a newer history revision", async (t) => {
  const f = fixture(t);
  insert(f, "first");
  let releaseOlder;
  let reachedOlderStore;
  const olderBlocked = new Promise((resolve) => { releaseOlder = resolve; });
  const olderReachedStore = new Promise((resolve) => { reachedOlderStore = resolve; });
  f.controls.beforeStore = async (args) => {
    if (args[2] === 1) {
      reachedOlderStore();
      await olderBlocked;
    }
  };
  const older = loadProductChangeEvents(f.db, "a");
  await olderReachedStore;
  insert(f, "second", { at: "2026-10-21T01:00:00Z" });
  let newer;
  try {
    newer = await loadProductChangeEvents(f.db, "a");
    assert.deepEqual(ids(newer), ["second", "first"]);
    assert.equal(stored(f).revision, 2);
  } finally {
    releaseOlder();
  }
  assert.deepEqual(ids(await older), ["first"], "the older read retains its own transaction-consistent snapshot");
  assert.equal(stored(f).revision, 2);
  assert.deepEqual(JSON.parse(stored(f).payload), newer);
  f.controls.denyHistoryReads = true;
  assert.deepEqual(await loadProductChangeEvents(f.db, "a"), newer);
});
