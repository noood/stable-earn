import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const load = moduleLoader();
const { withStartupServerTiming } = load("@/lib/startup-timing");
const { formatStartupRequestTiming } = load("@/lib/startup-timing-format");
const { loadProductChangeEvents } = load("@/lib/product-change-events");

test("one response contains both history call spans and D1 metadata, without event contents", async () => {
  const db = sqliteDb();
  db.sqlite.prepare(`INSERT INTO product_change_events
    (owner_id,event_id,product_id,change_type,title,observed_at,source,attention)
    VALUES ('private-owner','private-event','private-product','rate','private-title','2026-10-20T00:00:00Z','手动刷新',1)`).run();
  const wrapped = {
    prepare: (sql) => ({ bind: (...args) => ({ ...db.prepare(sql).bind(...args), sql }) }),
    batch: async (statements) => (await db.batch(statements)).map((result, index) => ({ ...result, meta: {
      duration: 5, timings: { sql_duration_ms: statements[index].sql.includes("LIMIT") ? 3.9 : 1.2 },
      total_attempts: statements[index].sql.includes("LIMIT") ? 2 : 1, rows_read: 760,
    } })),
  };
  const response = await withStartupServerTiming(new Request("https://app.example/private/api/products?diagnostics=1"), async (timing) => {
    const events = await timing.measure("history", () => loadProductChangeEvents(wrapped, "private-owner", 2000, timing));
    assert.equal(events.length, 1);
    assert.equal(events[0].id, "private-event");
    return Response.json({ ok: true });
  });
  const header = response.headers.get("server-timing");
  assert.match(header, /history_cache;dur=/);
  assert.match(header, /history_legacy_build;dur=/);
  assert.match(header, /history_merge;dur=/);
  assert.match(header, /history_recent_sql;desc="value=3.9"/);
  assert.match(header, /history_unread_attempts;desc="value=1"/);
  assert.match(header, /history_recent_rows;desc="value=1"/);
  assert.doesNotMatch(header, /private-|product_change_events/);
  const text = formatStartupRequestTiming(header, 0, 100);
  assert.match(text, /最近历史 SQL 执行（末次尝试） 3.9ms/);
  assert.match(text, /最近历史执行尝试 2次/);
  db.sqlite.close();
});

test("missing D1 SQL/retry metadata stays unknown, never silently becomes zero or one", async () => {
  const db = sqliteDb();
  db.sqlite.prepare(`INSERT INTO product_change_events
    (owner_id,event_id,product_id,change_type,title,observed_at,source,attention)
    VALUES ('private-owner','event','product','rate','title','2026-10-20T00:00:00Z','手动刷新',1)`).run();
  const response = await withStartupServerTiming(new Request("https://app.example/private/api/products?diagnostics=1"), async (timing) => {
    await loadProductChangeEvents(db, "private-owner", 2000, timing);
    timing.record("history_recent_sql", NaN);
    timing.record("history_recent_attempts", -1);
    return Response.json({ ok: true });
  });
  const header = response.headers.get("server-timing");
  assert.doesNotMatch(header, /history_recent_sql;|history_recent_attempts;/);
  assert.match(formatStartupRequestTiming(header, 0, 10), /D1 未提供独立 SQL 耗时/);
  db.sqlite.close();
});
