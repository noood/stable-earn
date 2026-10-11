import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { parseProductOverride } = moduleLoader()("@/lib/product-override-input");
const okxUsdc = {
  id: "okx-usdc", productDataMode: "manual", holdingDataMode: "api", productType: "flexible",
  productTypeStatus: "missing", termDays: undefined, manualFields: { termDays: true },
  tiers: [{ min: 0, max: null, apr: 0 }], source: { kind: "manual" },
};

test("unknown type ignores stale manual term input until a term-based type is selected", () => {
  assert.deepEqual(parseProductOverride(okxUsdc, {
    termDays: 180, purchaseDate: "2026-08-01", apr: null, firstTierLimit: null,
  }), { productId: "okx-usdc", apr: null, firstTierLimit: null, termDays: null, purchaseDate: null, manualKind: null });

  assert.deepEqual(parseProductOverride(okxUsdc, {
    manualKind: "fixed", termDays: 180, purchaseDate: "2026-08-01", apr: null, firstTierLimit: null,
  }), { productId: "okx-usdc", apr: null, firstTierLimit: null, termDays: 180, purchaseDate: "2026-08-01", manualKind: "fixed" });
});

test("purchase date is not accepted without a manual term", () => {
  const fixedOkxUsdc = { ...okxUsdc, productType: "fixed", productTypeStatus: "known" };
  assert.deepEqual(parseProductOverride(fixedOkxUsdc, {
    termDays: null, purchaseDate: "2026-08-01", apr: null, firstTierLimit: null,
  }), { productId: "okx-usdc", apr: null, firstTierLimit: null, termDays: null, purchaseDate: null, manualKind: null });
});

test("invalid manual term or date still fails validation", () => {
  const fixedOkxUsdc = { ...okxUsdc, productType: "fixed", productTypeStatus: "known" };
  assert.equal(parseProductOverride(fixedOkxUsdc, { termDays: 0, purchaseDate: "2026-08-01" }), null);
  assert.equal(parseProductOverride(fixedOkxUsdc, { termDays: 180, purchaseDate: "2026-02-30" }), null);
});
