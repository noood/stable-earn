import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const load = moduleLoader();
const { applyProductOverride, manualFirstTierIsUnlimited, productOverrideForSave } = load("@/lib/product-overrides");
const { parseProductOverride } = load("@/lib/product-override-input");
const { productInformationIssues, productParticipatesInInterest } = load("@/lib/product-status");
const { productHasUnknownTierCapacity } = load("@/lib/domain");
const { buildManualChangeEvents } = load("@/lib/product-change-events");

const base = {
  id: "manual-limit-test", identityKey: "manual-limit-test", accountId: "okx-global",
  asset: "USDC", exchange: "okx", region: "global", name: "Synthetic manual product",
  productDataMode: "manual", holdingDataMode: "api", productType: "flexible", productTypeStatus: "known",
  tiers: [{ id: "tier", min: 0, max: null, apr: 0 }], rateCoverage: "unavailable",
  capacityStatus: "unavailable", tierStructureStatus: "complete", source: { kind: "manual", label: "人工维护" },
};

const settings = (patch = {}) => ({ apr: 6.72, firstTierLimit: null, termDays: null, purchaseDate: null, updatedAt: null, ...patch });
const legacyUnlimited = { ...base, capacityStatus: "available", tiers: [{ ...base.tiers[0], maxStatus: "unlimited" }] };

function history(before, after, product = base, amount = 100) {
  return buildManualChangeEvents({ [product.id]: amount }, { [product.id]: amount },
    { [product.id]: before }, { [product.id]: after }, [], [], [product], {
      holdingProductIds: [], overrideProductIds: [product.id], manualProductIds: [], deletedManualProductIds: [],
    }, "2026-10-29T00:00:00.000Z");
}

test("manual quota distinguishes finite, unlimited and pending without changing the API holding source", () => {
  const finiteSettings = settings({ firstTierLimit: 250, firstTierUnlimited: false });
  const unlimitedSettings = settings({ firstTierUnlimited: true });
  const pendingSettings = settings({ firstTierUnlimited: false });
  const finite = applyProductOverride(base, finiteSettings);
  const unlimited = applyProductOverride(base, unlimitedSettings);
  const pending = applyProductOverride(base, pendingSettings);
  assert.equal(finite.tiers[0].max, 250);
  assert.equal(finite.tiers[0].maxStatus, undefined);
  assert.equal(finite.capacityStatus, "available");
  assert.equal(finite.rateCoverage, "complete");
  assert.equal(unlimited.tiers[0].max, null);
  assert.equal(unlimited.tiers[0].maxStatus, "unlimited");
  assert.equal(unlimited.capacityStatus, "available");
  assert.equal(unlimited.rateCoverage, "complete");
  assert.equal(pending.tiers[0].max, null);
  assert.equal(pending.tiers[0].maxStatus, undefined);
  assert.equal(pending.capacityStatus, "unavailable");
  assert.equal(pending.rateCoverage, "base_only");
  assert.deepEqual(productInformationIssues(pending, pendingSettings), ["首档额度待填写"]);
  assert.equal(productParticipatesInInterest(pending, 100, pendingSettings), false);
  assert.equal(productParticipatesInInterest(finite, 100, finiteSettings), true);
  assert.equal(productParticipatesInInterest(unlimited, 100, unlimitedSettings), true);
  for (const product of [finite, unlimited, pending]) assert.equal(product.holdingDataMode, "api");
});

test("only a confirmed legacy unlimited bound is inherited; explicit false clears it", () => {
  const inheritedSettings = settings();
  const inherited = applyProductOverride(legacyUnlimited, inheritedSettings);
  assert.equal(manualFirstTierIsUnlimited(legacyUnlimited, inheritedSettings), true);
  assert.equal(inherited.tiers[0].maxStatus, "unlimited");
  const pendingSettings = settings({ firstTierUnlimited: false });
  const pending = applyProductOverride(legacyUnlimited, pendingSettings);
  assert.equal(pending.tiers[0].maxStatus, undefined);
  assert.equal(pending.capacityStatus, "unavailable");
  assert.equal(productHasUnknownTierCapacity(pending), true);
  assert.deepEqual(productInformationIssues(pending, pendingSettings), ["首档额度待填写"]);
  const limited = applyProductOverride(legacyUnlimited, settings({ firstTierLimit: 250, firstTierUnlimited: false }));
  assert.equal(limited.tiers[0].max, 250);
  assert.equal(limited.tiers[0].maxStatus, undefined);
  assert.equal(manualFirstTierIsUnlimited(base, settings()), false);
  assert.equal(manualFirstTierIsUnlimited({ ...legacyUnlimited, capacityStatus: "unavailable" }, settings()), false);
});

test("parser preserves absent versus explicit flags and rejects zero sentinels or contradictory choices", () => {
  const legacy = parseProductOverride(base, { apr: 6.72, firstTierLimit: null });
  assert.equal(Object.hasOwn(legacy, "firstTierUnlimited"), false);
  assert.equal(parseProductOverride(base, { apr: 6.72, firstTierLimit: null, firstTierUnlimited: false }).firstTierUnlimited, false);
  assert.equal(parseProductOverride(base, { apr: 6.72, firstTierLimit: null, firstTierUnlimited: true }).firstTierUnlimited, true);
  for (const invalid of [
    { firstTierLimit: 0 }, { firstTierLimit: -1 }, { firstTierLimit: 250, firstTierUnlimited: true },
    { firstTierLimit: null, firstTierUnlimited: null }, { firstTierUnlimited: 1 }, { firstTierUnlimited: "true" },
  ]) assert.equal(parseProductOverride(base, invalid), null);
});

test("manual quota choices cannot override API-owned tiers or APR", () => {
  const apiProduct = { ...base, productDataMode: "api", apiAccess: "public", source: { kind: "live", label: "API" },
    tiers: [{ id: "api-tier", min: 0, max: 500, apr: 3 }], rateCoverage: "complete", capacityStatus: "available" };
  const malicious = settings({ apr: 99, firstTierLimit: null, firstTierUnlimited: true });
  assert.equal(applyProductOverride(apiProduct, malicious), apiProduct);
  const parsed = parseProductOverride(apiProduct, malicious);
  assert.equal(parsed.apr, null);
  assert.equal(parsed.firstTierLimit, null);
  assert.equal(Object.hasOwn(parsed, "firstTierUnlimited"), false);
});

test("save normalization clears the hidden numeric bound only in the saved unlimited payload", () => {
  const draft = settings({ firstTierLimit: 250, firstTierUnlimited: true });
  const normalized = productOverrideForSave(base, draft);
  assert.equal(normalized.firstTierLimit, null);
  assert.equal(normalized.firstTierUnlimited, true);
  assert.equal(draft.firstTierLimit, 250);
  assert.equal(draft.firstTierUnlimited, true);
  assert.equal(productOverrideForSave(legacyUnlimited, settings()).firstTierUnlimited, true);
  const pending = productOverrideForSave(legacyUnlimited, settings({ firstTierUnlimited: false }));
  assert.equal(pending.firstTierLimit, null);
  assert.equal(pending.firstTierUnlimited, false);
  const parsed = parseProductOverride(base, JSON.parse(JSON.stringify(normalized)));
  assert.equal(parsed.firstTierUnlimited, true);
  assert.equal(parsed.firstTierLimit, null);
});

test("mode-only changes record unlimited versus pending while equivalent legacy inheritance records no change", () => {
  const pending = settings({ firstTierUnlimited: false });
  const unlimited = settings({ firstTierUnlimited: true });
  let events = history(pending, unlimited);
  assert.deepEqual(events.map(({ title, before, after }) => ({ title, before, after })), [
    { title: "首档额度修改", before: "待填写", after: "不限额" },
  ]);
  events = history(unlimited, pending, legacyUnlimited);
  assert.deepEqual(events.map(({ title, before, after }) => ({ title, before, after })), [
    { title: "首档额度修改", before: "不限额", after: "待填写" },
  ]);
  assert.deepEqual(history(settings(), unlimited, legacyUnlimited), []);
});

test("switching from unlimited to a smaller finite quota records a real over-capacity alert", () => {
  const unlimited = settings({ firstTierUnlimited: true });
  const finite = settings({ firstTierLimit: 50, firstTierUnlimited: false });
  const events = history(unlimited, finite);
  assert.equal(events.filter((event) => event.title === "首档额度修改").length, 1);
  assert.equal(events.filter((event) => event.title === "持仓超过首档额度" && event.attention).length, 1);
  assert.equal(history(finite, unlimited).some((event) => event.title === "持仓超过首档额度"), false);
});

test("small positive limits keep their numeric precision through parsing, normalization and product application", () => {
  for (const amount of [0.00000001, 0.001, 0.002, 1.001, 1.002]) {
    const parsed = parseProductOverride(base, { apr: 6.72, firstTierLimit: amount, firstTierUnlimited: false });
    const saved = productOverrideForSave(base, parsed);
    const resolved = applyProductOverride(base, saved);
    assert.equal(saved.firstTierLimit, amount);
    assert.equal(resolved.tiers[0].max, amount);
  }
});

test("a real finite quota change is recorded even when both bounds round to the same display text", () => {
  const btcProduct = { ...base, asset: "BTC" };
  for (const [beforeAmount, afterAmount] of [[0.001, 0.002], [1.001, 1.002]]) {
    const before = settings({ firstTierLimit: beforeAmount, firstTierUnlimited: false });
    const after = settings({ firstTierLimit: afterAmount, firstTierUnlimited: false });
    const events = history(before, after, btcProduct, 0);
    assert.equal(events.filter((event) => event.title === "首档额度修改").length, 1);
  }
});
