import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const slot = Date.parse("2026-09-06T22:00:00Z");
function fixture(users = ["first", "second"]) {
  let now = slot + 30000;
  const records = new Map();
  const logs = [], calls = [], batches = [];
  class Clock extends Date { static now() { return now; } }
  const db = {};
  const load = moduleLoader({
    "@/lib/db": { getDatabase: async () => db },
    "@/lib/sync-cache": { loadSyncCache: async (_db, user) => records.get(user) ?? null },
    "@/app/private/api/products/route": {
      listPrivateSyncUserIds: async () => users,
      refreshPrivateProductsCache: async (_db, user, options) => {
        calls.push({ user, ...options });
        if (user === "success" || (user === "partial" && options.acceptPartial)) {
          records.set(user, { updatedAt: new Date(now).toISOString() });
          return;
        }
        records.set(user, { lastAttemptAt: new Date(now).toISOString(), lastError: options.persistFailure ? "failed" : null });
        throw Error("公开与账户接口均未返回可用数据");
      },
    },
  }, { Date: Clock, console: { info: (r) => logs.push(r), warn: (r) => logs.push(r) } });
  return {
    ...load("@/lib/scheduled-sync"), records, logs, calls, batches,
    queue: { sendBatch: async (batch) => batches.push(batch) },
    step: (ms) => { now += ms; },
  };
}
function message(userId, attempts = 1, scheduledAt = slot) {
  return { body: { userId, scheduledAt }, attempts, acked: false, delay: null,
    ack() { this.acked = true; }, retry({ delaySeconds }) { this.delay = delaySeconds; } };
}
const batch = (msg) => ({ messages: [msg] });

test("cron only enqueues per-user jobs; producer batches at the documented maximum", async () => {
  const f = fixture(Array.from({ length: 205 }, (_, i) => `user-${i}`));
  await f.enqueueScheduledRefresh(f.queue, slot + 32000);
  assert.deepEqual(f.batches.map((b) => b.length), [100, 100, 5]);
  assert.equal(f.batches[0][0].body.scheduledAt, slot);
  assert.equal(f.calls.length, 0);
});

test("three attempts run as separate queue deliveries with 60/300 second delays", async () => {
  const f = fixture();
  for (const attempt of [1, 2, 3]) {
    const msg = message("first", attempt);
    await f.consumeScheduledRefresh(batch(msg));
    assert.equal(msg.delay, attempt === 1 ? 60 : attempt === 2 ? 300 : null);
    assert.equal(msg.acked, attempt === 3);
    f.step(attempt === 1 ? 60000 : 300000);
  }
  assert.deepEqual(f.calls.map((r) => r.acceptPartial), [false, false, true]);
  assert.deepEqual(f.calls.map((r) => r.persistFailure), [false, false, true]);
  assert.equal(new Set(f.calls.map((r) => r.runId)).size, 1);
  const duplicate = message("first", 3);
  await f.consumeScheduledRefresh(batch(duplicate));
  assert.equal(duplicate.acked, true);
  assert.equal(f.calls.length, 3);
});

test("successful users stop immediately, partial users commit only at final attempt", async () => {
  const f = fixture();
  const success = message("success");
  await f.consumeScheduledRefresh(batch(success));
  assert.equal(success.acked, true);
  const duplicate = message("success", 2);
  await f.consumeScheduledRefresh(batch(duplicate));
  assert.equal(f.calls.length, 1);
  for (const attempt of [1, 2, 3]) {
    const msg = message("partial", attempt);
    await f.consumeScheduledRefresh(batch(msg));
    assert.equal(msg.acked, attempt === 3);
    f.step(60000);
  }
  assert.ok(f.records.get("partial").updatedAt);
});

test("new committed manual data stops pending retry, but a failed manual attempt does not", async () => {
  const f = fixture();
  f.records.set("first", { updatedAt: new Date(slot + 10000).toISOString() });
  const msg = message("first", 2);
  await f.consumeScheduledRefresh(batch(msg));
  assert.equal(msg.acked, true);
  assert.equal(f.calls.length, 0);
  const attemptedAt = new Date(slot + 10000).toISOString();
  f.records.set("second", { lastAttemptAt: attemptedAt, lastManualAt: attemptedAt, lastError: "failed" });
  await f.consumeScheduledRefresh(batch(message("second", 2)));
  assert.equal(f.calls.length, 1);
});

test("stale or malformed jobs cannot refresh accounts; multi-user consumer batches are rejected", async () => {
  const f = fixture();
  for (const msg of [message("first", 1, slot - 43200000), message("first", 1, slot + 43200000), message(null)]) {
    await f.consumeScheduledRefresh(batch(msg));
    assert.equal(msg.acked, true);
  }
  await assert.rejects(f.consumeScheduledRefresh({ messages: [message("first"), message("second")] }), /max_batch_size/);
  assert.equal(f.calls.length, 0);
});

test("deployment guarantees one user per invocation and exactly two retries", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const consumer = config.queues.consumers[0];
  assert.equal(consumer.max_batch_size, 1);
  assert.equal(consumer.max_retries, 2);
  assert.equal(consumer.max_concurrency, 1);
  assert.equal(config.queues.producers[0].queue, consumer.queue);
  assert.deepEqual(config.triggers.crons, ["0 22,10 * * *"]);
});
