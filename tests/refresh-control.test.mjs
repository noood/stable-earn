import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

test("daily refresh is completed only by an atomic result commit and abandoned leases recover", async () => {
  const db = sqliteDb();
  let now = Date.parse("2026-09-08T15:59:59Z");
  class Clock extends Date { static now() { return now; } }
  const control = moduleLoader({}, { Date: Clock })("@/lib/refresh-control");
  const [one, two] = await Promise.all([control.acquireRefresh(db, "a"), control.acquireRefresh(db, "a")]);
  assert.ok(one);
  assert.equal(two, null);
  assert.ok(await control.acquireRefresh(db, "b"));
  const day = control.refreshDay(now);
  assert.equal(await control.dailyRefreshCompleted(db, "a", day), false);
  await control.releaseRefresh(db, "a", "wrong-token");
  assert.equal(await control.refreshIsLocked(db, "a"), true);
  now += 16 * 60000;
  const next = await control.acquireRefresh(db, "a");
  assert.ok(next);
  assert.notEqual(next, one);
  assert.equal(await control.renewRefresh(db, "a", one), false);
  assert.equal(await control.renewRefresh(db, "a", next), true);
  await control.releaseRefresh(db, "a", one);
  assert.equal(await control.refreshIsLocked(db, "a"), true);
  assert.equal(await control.dailyRefreshCompleted(db, "a", day), false);
  await db.batch([
    control.prepareRefreshCommitGuard(db, "a", next),
    control.prepareDailyRefreshCommit(db, "a", next, day),
  ]);
  assert.equal(await control.dailyRefreshCompleted(db, "a", day), true);
  assert.equal(await control.dailyRefreshCompleted(db, "a", "2026-09-09"), false);
  assert.equal(control.refreshDay(now), "2026-09-09");
  await control.releaseRefresh(db, "a", next);
  assert.equal(await control.refreshIsLocked(db, "a"), false);
});
