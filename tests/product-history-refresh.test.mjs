import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const load = moduleLoader();
const { loadProductChangeEventPage } = load("@/lib/product-change-events");
const { mergeProductHistoryEvents, mergeNewProductHistoryEvents } = load("@/lib/product-history-state");
const source = ts.createSourceFile("product-history.tsx", readFileSync(new URL("../app/components/product-history.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let requestFunction;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "requestHistoryPage") {
    requestFunction = node.initializer.arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(requestFunction);
const code = ts.transpileModule(`const request = ${requestFunction};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const timestamp = (minute) => new Date(Date.UTC(2026, 0, 1) + minute * 60_000).toISOString();

function fixture(t, { sameTimestamp = false } = {}) {
  const db = sqliteDb();
  t.after(() => db.sqlite.close());
  const writer = db.sqlite.prepare(`INSERT INTO product_change_events
    (owner_id,event_id,product_id,change_type,title,observed_at,source,attention)
    VALUES ('owner',?,'product','rate',?,?,'手动刷新',0)`);
  function insert(id, minute) { writer.run(id, id, sameTimestamp ? timestamp(1) : timestamp(minute)); }
  for (let n = 1; n <= 150; n++) insert(`e${String(n).padStart(3, "0")}`, n);
  const state = { loaded: null, nextCursor: null, loadedRevision: null, revision: "count:150", loading: false,
    error: false, initialComplete: false, initialSnapshotIds: null };
  const requestId = { current: 0 }, requestedRevision = { current: null }, failedCursor = { current: null };
  const cursors = [];
  const controls = { beforePage: null };
  async function invoke(cursor) {
    const deps = {
      loadPage: async (next) => {
        cursors.push(next);
        if (controls.beforePage) await controls.beforePage(next);
        return loadProductChangeEventPage(db, "owner", "product", next);
      },
      historyRequestIdRef: requestId, requestedRevisionRef: requestedRevision, eventsRevision: state.revision,
      document: { activeElement: null }, HTMLElement: class {}, restorePopoverFocusAfterLoadRef: { current: false },
      popoverRef: { current: null }, events: [], initialSnapshotIds: state.initialSnapshotIds,
      loadedHistoryEvents: state.loaded, nextCursor: state.nextCursor,
      setHistoryLoading: (value) => { state.loading = value; },
      setInitialSnapshotIds: (update) => { state.initialSnapshotIds = update(state.initialSnapshotIds); },
      setLoadedHistoryEvents: (update) => { state.loaded = update(state.loaded); },
      setNextCursor: (value) => { state.nextCursor = value; },
      setHistoryError: (value) => { state.error = value; },
      setLoadedRevision: (value) => { state.loadedRevision = value; },
      failedCursorRef: failedCursor,
      setInitialHistoryLoadComplete: (value) => { state.initialComplete = value; },
      mergeProductHistoryEvents, mergeNewProductHistoryEvents,
    };
    await new Function(...Object.keys(deps), `${code}\nreturn request;`)(...Object.values(deps))(cursor);
  }
  return {
    db, state, cursors, controls, insert, failedCursor,
    first: () => invoke(null), more: () => invoke(state.nextCursor),
    refresh: () => {
      state.revision = `count:${db.sqlite.prepare("SELECT event_count FROM product_history_state WHERE owner_id = 'owner'").get().event_count}`;
      return invoke(null);
    },
  };
}

function loadedIds(f) { return f.state.loaded?.map((event) => event.id) ?? []; }
function assertAllHistoryLoaded(f) {
  const actual = loadedIds(f);
  const expected = f.db.sqlite.prepare("SELECT event_id FROM product_change_events WHERE owner_id = 'owner' AND product_id = 'product' ORDER BY observed_at DESC,event_id DESC").all().map((row) => row.event_id);
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
}
async function finish(f) {
  for (let guard = 0; f.state.nextCursor !== null; guard++) {
    assert.ok(guard < 20, "pagination must terminate");
    const before = loadedIds(f).length;
    await f.more();
    assert.ok(loadedIds(f).length > before, "load more must advance rather than fetch an already loaded page");
  }
  assertAllHistoryLoaded(f);
}

test("summary refresh preserves a deep cursor and the next load-more request advances immediately", async (t) => {
  const f = fixture(t);
  await f.first(); await f.more();
  assert.equal(loadedIds(f).length, 100);
  const deepCursor = f.state.nextCursor;
  f.insert("e151", 151);
  await f.refresh();
  assert.equal(loadedIds(f).length, 101);
  assert.equal(f.state.nextCursor, deepCursor);
  await finish(f);
  assert.equal(loadedIds(f).length, 151);
});

test("more than one page of new events is fully reconciled before the old deep cursor is reused", async (t) => {
  const f = fixture(t);
  await f.first(); await f.more();
  const deepCursor = f.state.nextCursor;
  for (let n = 151; n <= 275; n++) f.insert(`e${n}`, n);
  f.cursors.length = 0;
  await f.refresh();
  assert.ok(f.cursors.length >= 5, "catch-up must traverse the gap instead of reading only the newest page");
  assert.equal(loadedIds(f).length, 225);
  assert.equal(f.state.nextCursor, deepCursor);
  assert.ok(loadedIds(f).includes("e175"));
  await finish(f);
});

for (const sameTimestamp of [false, true]) {
  test(`backdated entries inside and below the loaded boundary remain reachable (timestamp ties: ${sameTimestamp})`, async (t) => {
    const f = fixture(t, { sameTimestamp });
    await f.first(); await f.more();
    const deepCursor = f.state.nextCursor;
    f.insert("e120a", 120.5);
    f.insert("e025a", 25.5);
    f.insert("e151", 151);
    await f.refresh();
    assert.equal(f.state.nextCursor, deepCursor);
    assert.ok(loadedIds(f).includes("e120a"), "new backdated entries within the displayed range must be reconciled");
    assert.ok(!loadedIds(f).includes("e025a"), "older unseen entries remain for the user's normal pagination");
    await finish(f);
    assert.equal(loadedIds(f).length, 153);
  });
}

test("a previously fully loaded history also picks up newly backdated tail events", async (t) => {
  const f = fixture(t);
  await f.first(); await finish(f);
  f.insert("new-head", 151);
  f.insert("new-middle", 120.5);
  f.insert("new-tail", 0.5);
  await f.refresh();
  assert.equal(f.state.nextCursor, null);
  assert.equal(loadedIds(f).length, 153);
  assertAllHistoryLoaded(f);
});

test("a failed catch-up page leaves prior events, cursor and confirmed revision intact until a full retry succeeds", async (t) => {
  const f = fixture(t);
  await f.first(); await f.more();
  const before = { events: loadedIds(f), cursor: f.state.nextCursor, revision: f.state.loadedRevision };
  f.insert("e151", 151);
  let pages = 0;
  f.controls.beforePage = async () => { if (++pages === 2) throw new Error("intermediate page failed"); };
  await f.refresh();
  assert.deepEqual(loadedIds(f), before.events);
  assert.equal(f.state.nextCursor, before.cursor);
  assert.equal(f.state.loadedRevision, before.revision, "incomplete catch-up cannot enable read acknowledgements for the new revision");
  assert.equal(f.state.error, true);
  assert.equal(f.failedCursor.current, null, "catch-up retries restart at the newest page");
  f.controls.beforePage = null;
  await f.first();
  assert.equal(f.state.loadedRevision, "count:151");
  assert.equal(f.state.error, false);
  await finish(f);
});

test("superseded catch-up cannot commit partial data or overwrite the newer request's deep cursor", async (t) => {
  const f = fixture(t);
  await f.first(); await f.more();
  f.insert("e151", 151);
  let entered, release;
  const paused = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { entered = resolve; });
  let blocked = false;
  f.controls.beforePage = async (cursor) => {
    if (cursor !== null && !blocked) { blocked = true; entered(); await paused; }
  };
  const stale = f.refresh();
  await reached;
  assert.equal(loadedIds(f).length, 100, "partial catch-up pages must not appear or become eligible for acknowledgement");
  assert.equal(f.state.loadedRevision, "count:150");
  assert.equal(f.state.loading, true);
  f.insert("e152", 152);
  try { await f.refresh(); } finally { release(); }
  const latest = { events: loadedIds(f), cursor: f.state.nextCursor, revision: f.state.loadedRevision };
  await stale;
  assert.deepEqual(loadedIds(f), latest.events);
  assert.equal(f.state.nextCursor, latest.cursor);
  assert.equal(f.state.loadedRevision, latest.revision);
  assert.equal(latest.revision, "count:152");
  await finish(f);
});
