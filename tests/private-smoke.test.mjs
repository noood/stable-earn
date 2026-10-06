import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const load = moduleLoader();
const { publicDemoProducts, publicDemoChangeEvents } = load("@/lib/public-demo");
const { catalogProductTemplates } = load("@/lib/catalog-templates");
const { localPrivateProductsPreview, localPrivateHoldingsPreview } = load("@/lib/local-preview");

test("private dashboard smoke data keeps demo, production compatibility, and preview fixtures separate", () => {
  assert.deepEqual(publicDemoProducts.map((product) => product.id), [
    "bn-g-usdt",
    "bg-usdt-simple",
    "by-g-usdt-short-fixed",
    "mexc-uk-usdt",
  ]);
  assert.equal(publicDemoChangeEvents.length, 2);
  assert.ok(publicDemoChangeEvents.every((event) => publicDemoProducts.some((product) => product.id === event.productId)));
  assert.deepEqual(publicDemoChangeEvents.map((event) => event.after), ["6.20%", "500 USDT"]);
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

test("private route serves a static shell and keeps account data client-loaded", () => {
  const privatePage = readFileSync(new URL("../app/private/page.tsx", import.meta.url), "utf8");
  const privateClient = readFileSync(new URL("../app/private/private-dashboard-client.tsx", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const history = readFileSync(new URL("../app/components/product-history.tsx", import.meta.url), "utf8");
  const apiSettings = readFileSync(new URL("../app/components/api-settings.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(privatePage, /dynamic = "force-static"/);
  assert.match(privatePage, /<PrivateDashboardClient \/>/);
  assert.doesNotMatch(privatePage, /searchParams|<Dashboard/);
  assert.match(privateClient, /ssr: false/);
  assert.match(privateClient, /localPreview=\{process\.env\.NODE_ENV === "development"\}/);
  assert.match(dashboard, /useState\(\(\) => isDemo \? publicDemoProducts : \[\]\)/);
  assert.match(dashboard, /loadHistoryPage=\{isDemo \|\| localPreview \? undefined/);
  assert.match(history, /product-history-loading/);
  assert.match(history, /暂无变更记录/);
  assert.ok(apiSettings.indexOf('<SectionIntro title="配置 API"') < apiSettings.indexOf('<SectionIntro title="手动刷新频率"'));
  assert.match(styles, /\.modal-body\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.match(styles, /\.product-history-popover\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.match(dashboard, /const emptyHoldings: HoldingMap = \{\};/);
});
