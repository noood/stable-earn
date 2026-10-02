import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const load = moduleLoader();
const { publicDemoProducts } = load("@/lib/public-demo");
const { catalogProductTemplates } = load("@/lib/catalog-templates");
const { localPrivateProductsPreview, localPrivateHoldingsPreview } = load("@/lib/local-preview");

test("private dashboard smoke data keeps demo, production compatibility, and preview fixtures separate", () => {
  assert.deepEqual(publicDemoProducts.map((product) => product.id), [
    "bn-g-usdt",
    "bg-usdt-simple",
    "by-g-usdt-short-fixed",
    "mexc-uk-usdt",
  ]);
  assert.deepEqual(catalogProductTemplates.map((product) => product.id), ["okx-usdt", "okx-usdc", "okx-btc"]);
  assert.ok(catalogProductTemplates.every((product) => product.productDataMode === "manual" && product.holdingDataMode === "api"));
});

test("private preview still contains the long-history and manual-field scenarios", () => {
  const preview = localPrivateProductsPreview(new Date("2026-10-03T00:00:00.000Z"));
  const previewIds = new Set(preview.products.map((product) => product.id));
  assert.ok(previewIds.has("okx-usdt"));
  assert.ok(previewIds.has("mexc-ph-usdt"));
  assert.ok(preview.changeEvents.length >= 25);
  const holdingsPreview = localPrivateHoldingsPreview(new Date("2026-10-03T00:00:00.000Z"));
  assert.equal(holdingsPreview.found, true);
  assert.ok(holdingsPreview.manualProducts.some((product) => product.id === "manual-preview-fixed"));
});

test("private route remains account-scoped and does not fall back to global seeds", () => {
  const privatePage = readFileSync(new URL("../app/private/page.tsx", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(privatePage, /<Dashboard mode="private"/);
  assert.match(privatePage, /localPreview=\{process\.env\.NODE_ENV === "development"\}/);
  assert.match(dashboard, /useState\(\(\) => isDemo \? publicDemoProducts : \[\]\)/);
  assert.match(dashboard, /const emptyHoldings: HoldingMap = \{\};/);
});
