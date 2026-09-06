import assert from "node:assert/strict";
import test from "node:test";
import { cachedHoldingTimes, freshHoldingIdsForSave } from "../lib/holding-cache.ts";

const sourceTime = "2026-09-05T00:56:15.064Z";
const firstFailureTime = "2026-09-05T01:00:18.013Z";
const secondFailureTime = "2026-09-05T01:06:18.013Z";

test("first failure uses the last successful snapshot time, including zero holdings", () => {
  assert.deepEqual(cachedHoldingTimes({ bitget: 299.64, binance: 0 }, {}, sourceTime), {
    bitget: sourceTime,
    binance: sourceTime,
  });
});

test("consecutive partial or total failures preserve each holding's original time", () => {
  const holdings = { bitget: 299.64, binance: 100 };
  const first = cachedHoldingTimes(holdings, { bitget: sourceTime }, firstFailureTime);
  const second = cachedHoldingTimes(holdings, first, secondFailureTime);
  assert.deepEqual(second, { bitget: sourceTime, binance: firstFailureTime });
});

test("partial success saves only fresh holdings, including a fresh zero", () => {
  assert.deepEqual(freshHoldingIdsForSave(
    { bitget: 299.64, binance: 0, okx: 100 },
    { bitget: sourceTime },
    "updated",
  ), ["binance", "okx"]);
});

test("an all-fallback response saves nothing", () => {
  assert.deepEqual(freshHoldingIdsForSave(
    { bitget: 299.64 }, { bitget: sourceTime }, "updated",
  ), []);
});

test("cache reads cannot re-save holdings even if no fallback is marked", () => {
  for (const state of ["fresh", "error", "cooldown", "syncing", "stale", undefined]) {
    assert.deepEqual(freshHoldingIdsForSave({ bitget: 299.64 }, {}, state), [], state);
  }
});

test("silent polling never writes holdings", () => {
  assert.deepEqual(freshHoldingIdsForSave({ bitget: 299.64 }, {}, "updated", true), []);
});

test("recovery permits saving even when the holding amount did not change", () => {
  const holdings = { bitget: 299.64 };
  assert.deepEqual(freshHoldingIdsForSave(holdings, {}, "updated"), ["bitget"]);
  assert.deepEqual(cachedHoldingTimes(holdings, {}, secondFailureTime), {
    bitget: secondFailureTime,
  });
});
