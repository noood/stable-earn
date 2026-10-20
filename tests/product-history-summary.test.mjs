import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const load = moduleLoader();
const { loadProductHistorySummaries, markProductChangeEventsRead, loadProductChangeEventPage } = load("@/lib/product-change-events");
const { mergeProductHistorySummaries } = load("@/lib/product-history-state");
const { withStartupServerTiming } = load("@/lib/startup-timing");
const { formatStartupRequestTiming } = load("@/lib/startup-timing-format");

function insert(db, owner, product, id, attention = 0, observedAt = "2026-10-20T00:00:00Z") {
  db.sqlite.prepare(`INSERT INTO product_change_events
    (owner_id,event_id,product_id,change_type,title,observed_at,source,attention)
    VALUES (?,?,?,'rate','private event contents',?,'手动刷新',?)`)
    .run(owner, id, product, observedAt, attention);
}

test("one grouped query returns small owner-scoped summaries, including old unread alerts beyond the latest page", async () => {
  const db = sqliteDb();
  insert(db, "a", "p", "old-unread", 1, "2020-01-01T00:00:00Z");
  for (let i = 0; i < 2100; i++) insert(db, "a", "p", `ordinary-${i}`);
  insert(db, "a", "q", "q-alert", 1);
  insert(db, "b", "p", "other-owner", 1);
  let queries = 0;
  const summaries = await loadProductHistorySummaries({ prepare(sql) { queries++; return db.prepare(sql); } }, "a");
  assert.equal(queries, 1);
  assert.deepEqual(summaries, [
    { productId: "p", eventCount: 2101, unreadCount: 1 },
    { productId: "q", eventCount: 1, unreadCount: 1 },
  ]);
  assert.ok(JSON.stringify(summaries).length < 150);
  assert.equal((await loadProductChangeEventPage(db, "a", "p")).events.length, 50);
  await markProductChangeEventsRead(db, "a", "p", ["ordinary-0"]);
  assert.equal((await loadProductHistorySummaries(db, "a"))[0].unreadCount, 1);
  await markProductChangeEventsRead(db, "a", "p", ["old-unread"]);
  assert.deepEqual(await loadProductHistorySummaries(db, "a", undefined, "p"), [{ productId: "p", eventCount: 2101, unreadCount: 0 }]);
  assert.equal((await loadProductHistorySummaries(db, "b"))[0].unreadCount, 1);
  assert.deepEqual(await loadProductHistorySummaries(db, "new"), []);
  insert(db, "a", "p", "backdated-maturity", 1, "2021-01-01T00:00:00Z");
  assert.deepEqual((await loadProductHistorySummaries(db, "a"))[0], { productId: "p", eventCount: 2102, unreadCount: 1 });
  db.sqlite.close();
});

test("out-of-order snapshots and read acknowledgements cannot restore read dots or clear newer alerts", () => {
  const summary = (eventCount, unreadCount) => ({ productId: "p", eventCount, unreadCount });
  assert.deepEqual(mergeProductHistorySummaries([summary(10, 0)], [summary(10, 1)]), [summary(10, 0)]);
  assert.deepEqual(mergeProductHistorySummaries([summary(11, 1)], [summary(10, 0)]), [summary(11, 1)]);
  assert.deepEqual(mergeProductHistorySummaries([summary(10, 0)], [summary(11, 1)]), [summary(11, 1)]);
  assert.deepEqual(mergeProductHistorySummaries([summary(11, 2)], [summary(11, 1)]), [summary(11, 1)]);
});

test("summary timing uses the same response's D1 metadata and never exposes event contents", async () => {
  const db = sqliteDb();
  insert(db, "private-owner", "private-product", "private-event", 1);
  const wrapped = { prepare(sql) { return { bind(...args) {
    const statement = db.prepare(sql).bind(...args);
    return { ...statement, all: async () => ({ ...await statement.all(), meta: {
      duration: 4, timings: { sql_duration_ms: 3 }, total_attempts: 1, rows_read: 1,
    } }) };
  } }; } };
  const response = await withStartupServerTiming(new Request("https://example.test/private/api/products?diagnostics=1"), async (timing) => {
    await loadProductHistorySummaries(wrapped, "private-owner", timing);
    return Response.json({ ok: true });
  });
  const header = response.headers.get("server-timing");
  assert.match(header, /history_summary;dur=/);
  assert.match(header, /history_summary_rows;desc="value=1"/);
  assert.doesNotMatch(header, /private-|private event/);
  assert.match(formatStartupRequestTiming(header, 0, 20), /历史摘要 SQL 执行（末次尝试） 3ms/);
  db.sqlite.close();
});
