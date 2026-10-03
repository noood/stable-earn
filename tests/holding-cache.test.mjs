import assert from "node:assert/strict";
import test from "node:test";
import { cachedHoldingTimes, freshHoldingIdsForSave, mergeHoldingPositions } from "../lib/holding-cache.ts";

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

test("a complete empty position snapshot clears only that account's cached positions", () => {
  const oldPositions = [
    { productId: "bn-global-fixed", accountId: "binance-global", positionId: "g-1", amount: 100, source: "api", updatedAt: sourceTime },
    { productId: "bn-bahrain-fixed", accountId: "binance-bahrain", positionId: "b-1", amount: 250, source: "api", updatedAt: sourceTime },
  ];
  const afterGlobalSync = mergeHoldingPositions(oldPositions, [], new Set(["binance-global"]), {});
  assert.deepEqual(afterGlobalSync.map((position) => position.productId), ["bn-bahrain-fixed"]);
  assert.deepEqual(mergeHoldingPositions(oldPositions, [], new Set(), {}).map((position) => position.productId), [
    "bn-global-fixed", "bn-bahrain-fixed",
  ]);
});

test("complete sync clears legacy cached positions using the catalog account mapping", () => {
  const oldPosition = { productId: "legacy-fixed", positionId: "p-1", amount: 100, source: "api", updatedAt: sourceTime };
  assert.deepEqual(mergeHoldingPositions([oldPosition], [], new Set(["binance-global"]), {
    "legacy-fixed": "binance-global",
  }), []);
});
