import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { compareTableProducts } = moduleLoader()("@/lib/product-table-sort");
const product = (id, options = {}) => ({
  id, exchange: "bitget", region: "global", productType: "flexible", rateCoverage: "complete",
  tiers: [{ min: 0, max: 100, apr: 6 }], ...options,
});

test("platform first, flexible and limited before fixed, then displayed first-tier APR", () => {
  const input = [
    product("fixed-high", { productType: "fixed", tiers: [{ min: 0, max: 100, apr: 99 }] }),
    product("flex-low", { tiers: [{ min: 0, max: 100, apr: 6 }] }),
    product("limited-high", { manualKind: "limited", tiers: [{ min: 0, max: 100, apr: 12 }] }),
    product("unknown-type", { productTypeStatus: "unrecognized", tiers: [{ min: 0, max: 100, apr: 99 }] }),
    product("other-platform", { exchange: "binance", tiers: [{ min: 0, max: 100, apr: 1 }] }),
    product("fixed-low", { productType: "fixed", tiers: [{ min: 0, max: 100, apr: 5 }] }),
  ];
  assert.deepEqual(input.sort(compareTableProducts).map(({ id }) => id), [
    "other-platform", "limited-high", "flex-low", "fixed-high", "fixed-low", "unknown-type",
  ]);
});

test("missing or maximum-only APR sorts after known zero and cached APR; ties use stable IDs", () => {
  const input = [
    product("missing", { aprStatus: "unavailable", tiers: [{ min: 0, max: 100, apr: 99 }] }),
    product("highest-only", { rateCoverage: "max_only", tiers: [{ min: 0, max: 100, apr: 99 }] }),
    product("unavailable", { rateCoverage: "unavailable", tiers: [{ min: 0, max: 100, apr: 99 }] }),
    product("cached", { aprSource: "cache", tiers: [{ min: 0, max: 100, apr: 8 }] }),
    product("zero", { tiers: [{ min: 0, max: 100, apr: 0 }] }),
    product("b", { rateCoverage: "partial", aprStatus: "available", tiers: [{ min: 0, max: 100, apr: 7.004 }] }),
    product("a", { tiers: [{ min: 0, max: 100, apr: 7.001 }] }),
  ];
  assert.deepEqual(input.sort(compareTableProducts).map(({ id }) => id), [
    "cached", "a", "b", "zero", "highest-only", "missing", "unavailable",
  ]);
});
