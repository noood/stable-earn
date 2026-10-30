import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { parseProductOverride } = moduleLoader()("@/lib/product-override-input");
const userProducts = moduleLoader()("@/lib/user-products");
const { productTermDays } = moduleLoader()("@/lib/product-overrides");
const { applyProductOverride } = moduleLoader()("@/lib/product-overrides");
const { productOverrideForSave } = moduleLoader()("@/lib/product-overrides");
const { productInformationIssues, productParticipatesInInterest } = moduleLoader()("@/lib/product-status");
const { sqliteDb } = await import("./helpers/sqlite-db.mjs");
const okxUsdc = {
  id: "okx-usdc", productDataMode: "manual", holdingDataMode: "api", productType: "flexible",
  productTypeStatus: "missing", termDays: undefined, manualFields: { termDays: true },
  tiers: [{ min: 0, max: null, apr: 0 }], source: { kind: "manual" },
};

test("saving a flexible or unknown product clears hidden terms and dates", () => {
  const product = {
    ...okxUsdc,
    rateCoverage: "complete",
    tiers: [{ min: 0, max: 100, apr: 8 }],
  };
  const unknownOverride = parseProductOverride(product, {
    termDays: 180, purchaseDate: "2026-08-01",
    apr: 8, firstTierLimit: 100,
  });
  assert.deepEqual(unknownOverride, {
    productId: "okx-usdc", apr: 8, firstTierLimit: 100, termDays: null,
    purchaseDate: null, manualKind: null,
  });
  const unknown = applyProductOverride(product, unknownOverride);
  assert.equal(productTermDays(unknown), null);
  assert.equal(productParticipatesInInterest(unknown, 50, unknownOverride), true);
  assert.equal(productInformationIssues(unknown, unknownOverride).some((issue) => issue.includes("期限") || issue.includes("买入日")), false);

  const flexibleOverride = parseProductOverride(product, {
    manualKind: "flexible", termDays: 180, purchaseDate: "2026-08-01", apr: 8, firstTierLimit: 100,
  });
  assert.deepEqual(flexibleOverride, {
    productId: "okx-usdc", apr: 8, firstTierLimit: 100, termDays: null,
    purchaseDate: null, manualKind: "flexible",
  });
  const flexibleProduct = applyProductOverride(product, flexibleOverride);
  assert.equal(productTermDays(flexibleProduct), null);
  assert.equal(productParticipatesInInterest(flexibleProduct, 50, flexibleOverride), true);
  assert.equal(productInformationIssues(flexibleProduct, flexibleOverride).some((issue) => issue.includes("期限") || issue.includes("买入日")), false);

  assert.deepEqual(parseProductOverride(product, {
    manualKind: "fixed", termDays: 180, purchaseDate: "2026-08-01", apr: 8, firstTierLimit: 100,
  }), { productId: "okx-usdc", apr: 8, firstTierLimit: 100, termDays: 180, purchaseDate: "2026-08-01", manualKind: "fixed" });
});

test("API-managed term fields cannot be replaced by client-supplied hidden values", () => {
  const apiFixed = {
    ...okxUsdc, exchange: "binance", productDataMode: "api", productType: "fixed", productTypeStatus: "known",
    termDays: 30, manualFields: undefined,
  };
  assert.deepEqual(parseProductOverride(apiFixed, {
    manualKind: "limited", termDays: 180, purchaseDate: "2026-08-01", apr: null, firstTierLimit: null,
  }), {
    productId: "okx-usdc", apr: null, firstTierLimit: null, termDays: 30,
    purchaseDate: null, manualKind: null,
  });
  assert.equal(parseProductOverride({ ...apiFixed, exchange: "bybit" }, {
    purchaseDate: "2026-08-01",
  }).purchaseDate, "2026-08-01");
});

test("save normalization clears hidden fields without mutating the editing draft", () => {
  const draft = { apr: 8, firstTierLimit: 100, termDays: 7, purchaseDate: "2026-10-01", updatedAt: null, manualKind: "flexible" };
  const saved = productOverrideForSave(okxUsdc, draft);
  assert.equal(saved.termDays, null);
  assert.equal(saved.purchaseDate, null);
  assert.equal(draft.termDays, 7);
  assert.equal(draft.purchaseDate, "2026-10-01");
  for (const manualKind of ["fixed", "limited"]) {
    assert.deepEqual(productOverrideForSave(okxUsdc, { ...draft, manualKind }), { ...draft, manualKind, firstTierUnlimited: false });
  }
});

test("hidden manual dates are discarded instead of validated or saved", () => {
  const manual = userProducts.userProductInputToProduct({
    id: "manual-12345678", accountId: "binance-global", asset: "USDT",
    manualKind: "flexible", termDays: null,
  });
  assert.deepEqual(parseProductOverride(manual, {
    manualKind: null, termDays: null, purchaseDate: "2026-08-01", apr: 8, firstTierLimit: 100,
  }), {
    productId: "manual-12345678", apr: 8, firstTierLimit: 100, termDays: null,
    purchaseDate: null, manualKind: null,
  });
  assert.equal(parseProductOverride({ ...manual, productDataMode: "api" }, {
    termDays: null, purchaseDate: "2026-08-01",
  }).purchaseDate, null);
  assert.equal(parseProductOverride(manual, {
    termDays: null, purchaseDate: "2026-02-30",
  }).purchaseDate, null);
});

test("manual products clear flexible terms in storage and require a new term on a later fixed selection", async () => {
  const db = sqliteDb();
  const raw = {
    id: "manual-12345678", accountId: "binance-global", asset: "USDT",
    manualKind: "flexible", termDays: 180,
  };
  const [saved] = userProducts.sanitizeUserProducts([raw]);
  await db.batch(userProducts.prepareUserProductStatements(db, "user", [saved], [], "2026-10-12T00:00:00.000Z"));

  const [loadedFlexible] = await userProducts.loadUserProducts(db, "user");
  const flexible = loadedFlexible;
  assert.equal(db.sqlite.prepare("SELECT term_days FROM user_products WHERE user_id = ? AND product_id = ?").get("user", raw.id).term_days, null);
  assert.equal(flexible.termDays, undefined);
  assert.equal(productTermDays(flexible), null);
  assert.equal(userProducts.productToUserProduct(flexible).termDays, null);

  for (const manualKind of ["fixed", "limited"]) {
    const currentInput = userProducts.productToUserProduct(flexible);
    assert.equal(userProducts.sanitizeUserProducts([{ ...currentInput, manualKind }]), null);
    const [updated] = userProducts.sanitizeUserProducts([{ ...currentInput, manualKind, termDays: 7 }]);
    await db.batch(userProducts.prepareUserProductStatements(db, "user", [updated], [], "2026-10-12T00:00:01.000Z"));
    const [restored] = await userProducts.loadUserProducts(db, "user");
    assert.equal(restored.termDays, 7);
    assert.equal(productTermDays(restored), 7);

    // The next flexible save clears the term again, including in the DB.
    const [flexibleAgain] = userProducts.sanitizeUserProducts([{
      ...userProducts.productToUserProduct(restored),
      manualKind: "flexible",
    }]);
    await db.batch(userProducts.prepareUserProductStatements(db, "user", [flexibleAgain], [], "2026-10-12T00:00:02.000Z"));
    const [reloadedFlexible] = await userProducts.loadUserProducts(db, "user");
    assert.equal(reloadedFlexible.termDays, undefined);
    assert.equal(productTermDays(reloadedFlexible), null);
  }

  for (const invalidTerm of [0, "NaN", Number.NaN, 3651, Number.POSITIVE_INFINITY, true, [7], { value: 7 }, "0x7", "7days"]) {
    assert.equal(userProducts.sanitizeUserProducts([{ ...raw, manualKind: "fixed", termDays: invalidTerm }]), null);
  }
  assert.equal(userProducts.sanitizeUserProducts([{ ...raw, manualKind: "fixed", termDays: "7" }])?.[0].termDays, 7);
  assert.equal(userProducts.sanitizeUserProducts([{ ...raw, termDays: null }])?.[0].termDays, null);
  assert.equal(userProducts.sanitizeUserProducts([{ ...raw, manualKind: "fixed", termDays: null }]), null);
});

test("purchase date is not accepted without a manual term", () => {
  const apiFixed = { ...okxUsdc, productDataMode: "api", productType: "fixed", productTypeStatus: "known", manualFields: undefined };
  assert.deepEqual(parseProductOverride(apiFixed, {
    termDays: null, purchaseDate: "2026-08-01", apr: null, firstTierLimit: null,
  }), { productId: "okx-usdc", apr: null, firstTierLimit: null, termDays: null, purchaseDate: null, manualKind: null });
});

test("invalid manual term or date still fails validation", () => {
  const fixedOkxUsdc = { ...okxUsdc, productType: "fixed", productTypeStatus: "known" };
  assert.equal(parseProductOverride(fixedOkxUsdc, { termDays: 0, purchaseDate: "2026-08-01" }), null);
  assert.equal(parseProductOverride(fixedOkxUsdc, { termDays: 180, purchaseDate: "2026-02-30" }), null);
  assert.equal(parseProductOverride(okxUsdc, { manualKind: "flexible", termDays: "NaN", purchaseDate: "2026-08-01" }).termDays, null);
  assert.equal(parseProductOverride(okxUsdc, { manualKind: "limited", termDays: 180, purchaseDate: "2026-02-30" }), null);
});
