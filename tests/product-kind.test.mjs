import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const load = moduleLoader();
const { normalizeManualTermField, resolveProductKind } = load("@/lib/product-kind");
const { applyProductOverride, productNeedsManualTerm, productNeedsManualType, productParticipatesInInterest, productTermDays, productTypeSelectionAvailable } = {
  ...load("@/lib/product-overrides"),
  ...load("@/lib/product-status"),
};
const { parseProductOverride } = load("@/lib/product-override-input");
const { productInformationIssues } = load("@/lib/product-status");
const { bestAvailableFirstTierProduct, productShouldBeActive, totalHighYieldRemaining } = load("@/lib/opportunity-policy");

const missingTypeProduct = {
  id: "okx-usdt",
  accountId: "okx-global",
  exchange: "okx",
  region: "global",
  asset: "USDT",
  name: "Simple Earn",
  productDataMode: "manual",
  holdingDataMode: "api",
  productType: "flexible",
  productTypeStatus: "missing",
  tiers: [{ id: "okx-usdt-tier-0", min: 0, max: 100, apr: 8 }],
  source: { kind: "manual", label: "API 资料" },
  rateCoverage: "complete",
  identityKey: "okx-global:USDT:flexible:manual:default",
};

test("product kind normalizes the three supported categories without guessing", () => {
  assert.deepEqual(resolveProductKind("活期"), { status: "known", kind: "flexible" });
  assert.deepEqual(resolveProductKind("定期理财"), { status: "known", kind: "fixed" });
  assert.deepEqual(resolveProductKind("限时活期"), { status: "known", kind: "limited" });
  assert.deepEqual(resolveProductKind(undefined), { status: "missing" });
  assert.deepEqual(resolveProductKind("staking"), { status: "unrecognized" });
});

test("only a complete missing-type product can accept a manual type; type absence does not block known-rate calculations", () => {
  assert.equal(productNeedsManualType(missingTypeProduct), true);
  assert.equal(productTypeSelectionAvailable(missingTypeProduct, "synced"), true);
  assert.equal(productTypeSelectionAvailable(missingTypeProduct, "error"), false);
  assert.equal(productTypeSelectionAvailable(missingTypeProduct, "synced", true), false);
  assert.equal(productTypeSelectionAvailable(missingTypeProduct, "synced", false, true), false);
  const settings = { manualKind: null, apr: 8, firstTierLimit: 100, termDays: null, purchaseDate: null };
  const unknown = applyProductOverride(missingTypeProduct, settings);
  assert.equal(productInformationIssues(unknown, settings).includes("产品类型未知"), false);
  assert.equal(productTermDays(unknown), null);
  assert.equal(productParticipatesInInterest(unknown, 50, settings), true);
  assert.equal(bestAvailableFirstTierProduct([unknown], { [unknown.id]: 0 }, () => true), unknown);
  assert.equal(totalHighYieldRemaining([unknown], { [unknown.id]: 0 }, () => true), 100);
  assert.equal(productNeedsManualType({ ...missingTypeProduct, productTypeStatus: "unavailable" }), false);
  assert.equal(productNeedsManualType({ ...missingTypeProduct, productTypeStatus: "unrecognized" }), false);
});

test("a manual term marker is effective only for a resolved fixed or limited product", () => {
  const markedUnknown = { ...missingTypeProduct, manualFields: { termDays: true } };
  const staleOverride = { manualKind: null, apr: 8, firstTierLimit: 100, termDays: 180, purchaseDate: "2026-08-01" };
  const unknown = applyProductOverride(markedUnknown, staleOverride);

  assert.equal(productNeedsManualTerm(markedUnknown), false);
  assert.equal(productNeedsManualTerm({ ...markedUnknown, productTypeStatus: "known" }), false);
  assert.equal(productNeedsManualTerm({ ...markedUnknown, productType: "fixed", productTypeStatus: "known" }), true);
  assert.equal(productNeedsManualTerm({ ...markedUnknown, manualKind: "limited", productTypeStatus: "manual" }), true);
  assert.equal(productNeedsManualTerm({ ...markedUnknown, productType: "fixed", productTypeStatus: "unavailable" }), false);
  assert.equal(normalizeManualTermField(markedUnknown).manualFields, undefined);
  assert.deepEqual(normalizeManualTermField({ ...markedUnknown, productType: "fixed", productTypeStatus: "unavailable" }).manualFields, { termDays: true });
  assert.equal(productTermDays(unknown), null);
  assert.equal(productInformationIssues(unknown, staleOverride, false, true).some((issue) => issue.includes("期限") || issue.includes("买入日")), false);
  assert.equal(productParticipatesInInterest(unknown, 50, staleOverride), true);
});

test("a complete unknown-type product enters the no-holding catalog; only confirmed long fixed terms are excluded", () => {
  const catalogProduct = {
    ...missingTypeProduct,
    productDataMode: "api",
    source: { kind: "live", label: "API" },
  };
  assert.equal(productShouldBeActive(catalogProduct, { known: true, amount: 0 }), true);
  assert.equal(productShouldBeActive({ ...catalogProduct, productType: "fixed", termDays: undefined }, { known: true, amount: 0 }), true);
  assert.equal(productShouldBeActive({ ...catalogProduct, tiers: [{ id: "tier", min: 0, max: 100, apr: 5.99 }] }, { known: true, amount: 0 }), false);
  assert.equal(productShouldBeActive({ ...catalogProduct, productTypeStatus: "unavailable" }, { known: true, amount: 0 }), false);
  assert.equal(productShouldBeActive({ ...catalogProduct, productTypeStatus: "unrecognized" }, { known: true, amount: 0 }), false);

  const fixed = { ...catalogProduct, productType: "fixed", productTypeStatus: "known", termDays: 7 };
  assert.equal(productShouldBeActive(fixed, { known: true, amount: 0 }), true);
  assert.equal(productShouldBeActive({ ...fixed, termDays: 8 }, { known: true, amount: 0 }), false);
  assert.equal(productShouldBeActive({ ...fixed, termDays: 30 }, { known: true, amount: 0 }), false);
});

test("manual fixed and limited choices preserve identity and require their own term", () => {
  for (const [manualKind, expectedType] of [["fixed", "fixed"], ["limited", "flexible"]]) {
    const parsed = parseProductOverride(missingTypeProduct, {
      manualKind,
      apr: 8,
      firstTierLimit: 100,
      termDays: 7,
      purchaseDate: "2026-10-01",
    });
    assert.equal(parsed.manualKind, manualKind);
    const selected = applyProductOverride(missingTypeProduct, parsed);
    assert.equal(selected.productTypeStatus, "manual");
    assert.equal(selected.manualKind, manualKind);
    assert.equal(selected.productType, expectedType);
    assert.equal(selected.identityKey, missingTypeProduct.identityKey);
    assert.equal(productTermDays(selected), 7);
    assert.equal(parsed.termDays, 7);
    assert.equal(parsed.purchaseDate, "2026-10-01");
    assert.equal(productInformationIssues(selected, parsed).includes("产品类型未知"), false);
    assert.equal(productParticipatesInInterest(selected, 50, parsed), true);
  }

  const incompleteFixed = parseProductOverride(missingTypeProduct, { manualKind: "fixed", apr: 8, firstTierLimit: 100 });
  const fixedProduct = applyProductOverride(missingTypeProduct, incompleteFixed);
  assert.equal(productInformationIssues(fixedProduct, incompleteFixed).includes("锁定期限待填写"), true);
  assert.equal(productParticipatesInInterest(fixedProduct, 50, incompleteFixed), false);

  const flexible = parseProductOverride(missingTypeProduct, { manualKind: "flexible", apr: 8, firstTierLimit: 100, termDays: 7 });
  assert.equal(flexible.termDays, null);
  assert.equal(flexible.purchaseDate, null);
  assert.equal(productTermDays(applyProductOverride(missingTypeProduct, flexible)), null);
  assert.equal(parseProductOverride(missingTypeProduct, { manualKind: "staking" }), null);
});

test("a newly discovered API product with no explicit kind is not silently treated as flexible", async () => {
  const { sqliteDb } = await import("./helpers/sqlite-db.mjs");
  const db = sqliteDb();
  const { prepareProductCatalogSync } = load("@/lib/product-catalog");
  const now = "2026-10-10T00:00:00.000Z";
  const result = await prepareProductCatalogSync(db, "user", [{
    productId: "new-offer",
    identityKey: "exchange:USDT:unknown:new-offer",
    apr: 8,
    tiers: [{ min: 0, max: 100, apr: 8 }],
    fetchedAt: now,
    sourceLabel: "API",
    catalog: { accountId: "okx-global", exchange: "okx", region: "global", asset: "USDT", holdingDataMode: "api", apiAccess: "authenticated" },
  }], { "new-offer": 10 });
  const product = result.products[0];
  assert.ok(product);
  assert.equal(product.productType, "flexible");
  assert.equal(product.productTypeStatus, "unavailable");
  assert.equal(productNeedsManualType(product), false);
});

test("the local preview remembers the chosen kind across reloads without using a database", () => {
  const entries = new Map();
  const localStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
  const previewStore = moduleLoader({}, { window: { localStorage } })("@/lib/local-preview-storage");
  const saved = {
    "okx-usdt": { apr: 8, firstTierLimit: 100, termDays: 7, purchaseDate: "2026-10-01", updatedAt: null, manualKind: "limited" },
  };
  previewStore.saveLocalPreviewOverrides(saved);
  assert.deepEqual(previewStore.readLocalPreviewOverrides(), saved);
});
