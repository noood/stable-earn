import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { parseProductOverride } = moduleLoader()("@/lib/product-override-input");
const okxUsdc = {
  id: "okx-usdc", productDataMode: "manual", holdingDataMode: "api", productType: "flexible",
  termDays: undefined, manualFields: { termDays: true },
  tiers: [{ min: 0, max: null, apr: 0 }], source: { kind: "manual" },
};

test("manual term and purchase date are saved together when the catalogue has no term", () => {
  assert.deepEqual(parseProductOverride(okxUsdc, {
    termDays: 180, purchaseDate: "2026-08-01", apr: null, firstTierLimit: null,
  }), { productId: "okx-usdc", apr: null, firstTierLimit: null, termDays: 180, purchaseDate: "2026-08-01" });
});

test("purchase date is not accepted without a manual term", () => {
  assert.deepEqual(parseProductOverride(okxUsdc, {
    termDays: null, purchaseDate: "2026-08-01", apr: null, firstTierLimit: null,
  }), { productId: "okx-usdc", apr: null, firstTierLimit: null, termDays: null, purchaseDate: null });
});

test("invalid manual term or date still fails validation", () => {
  assert.equal(parseProductOverride(okxUsdc, { termDays: 0, purchaseDate: "2026-08-01" }), null);
  assert.equal(parseProductOverride(okxUsdc, { termDays: 180, purchaseDate: "2026-02-30" }), null);
});
