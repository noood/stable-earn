import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { moduleLoader } from "./helpers/load-ts.mjs";

const uiPath = new URL("../app/components/ui.tsx", import.meta.url).pathname;
const inputsPath = new URL("../app/components/dashboard/product-inputs.tsx", import.meta.url).pathname;
const datePath = new URL("../app/components/dashboard/purchase-date-input.tsx", import.meta.url).pathname;
const ui = moduleLoader()(uiPath);
const load = moduleLoader({ "@/app/components/ui": ui });
const { HoldingInput, InlineSelect, ManualAprInput, ManualLimitInput, ManualTermInput } = load(inputsPath);
const { PurchaseDateInput, parseCalendarDate } = load(datePath);
const historyPath = new URL("../app/components/product-history.tsx", import.meta.url).pathname;
const history = load(historyPath);
const rowLoad = moduleLoader({
  "@/app/components/ui": ui,
  "@/app/components/product-history": history,
  "@/app/components/dashboard/product-inputs": load(inputsPath),
  "@/app/components/dashboard/purchase-date-input": load(datePath),
});
const rowPath = new URL("../app/components/dashboard/product-row.tsx", import.meta.url).pathname;
const { ProductRow, overflowFromFirstTier, formatSyncDateTime } = rowLoad(rowPath);
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const noop = () => {};

test("extracted holding controls preserve empty zero, decimal amounts and disabled markup", () => {
  const zero = render(HoldingInput, { value: 0, asset: "USDT", disabled: false, onChange: noop });
  assert.match(zero, /holding-editor-editable/);
  assert.match(zero, /aria-label="USDT 产品持仓"/);
  assert.match(zero, /inputMode="decimal"/);
  assert.match(zero, /value=""/);
  assert.doesNotMatch(zero, /disabled=""/);
  const held = render(HoldingInput, { value: 0.00012345, asset: "BTC", disabled: true, onChange: noop });
  assert.match(held, /holding-editor-disabled/);
  assert.match(held, /value="0.00012345"/);
  assert.match(held, /disabled=""/);
});

test("extracted manual controls retain field labels, units and valid zero APR", () => {
  const apr = render(ManualAprInput, { value: 0, disabled: false, onChange: noop });
  assert.match(apr, /aria-label="APR"/);
  assert.match(apr, /value="0"/);
  assert.match(apr, /<span>%<\/span>/);
  const limit = render(ManualLimitInput, { value: null, asset: "USDC", disabled: true, onChange: noop });
  assert.match(limit, /aria-label="首档额度"/);
  assert.match(limit, /<span>USDC<\/span>/);
  assert.match(limit, /manual-field-control-disabled/);
  assert.match(limit, /value=""/);
  const term = render(ManualTermInput, { label: "活动期限", value: null, disabled: false, onChange: noop });
  assert.match(term, /aria-label="活动期限"/);
  assert.match(term, /placeholder="填写"/);
  assert.match(term, /<span>天<\/span>/);
});

test("extracted inline select retains current label and its closed listbox trigger", () => {
  const html = render(InlineSelect, {
    ariaLabel: "平台", value: "bybit-global", className: "inline-select-trigger-primary",
    options: [{ value: "bybit-global", label: "Bybit Global" }], disabled: false, onChange: noop,
  });
  assert.match(html, /inline-select-trigger inline-select-trigger-primary/);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Bybit Global/);
  assert.doesNotMatch(html, /role="listbox"/);
});

test("calendar date parsing preserves valid pure dates without accepting rolled dates", () => {
  assert.equal(parseCalendarDate("2024-02-29")?.toISOString(), "2024-02-29T00:00:00.000Z");
  assert.equal(parseCalendarDate("2026-10-05")?.toISOString(), "2026-10-05T00:00:00.000Z");
  for (const invalid of [null, "", "2026-02-29", "2026-13-01", "2026-10-05T00:00:00Z", "2026-1-5"]) {
    assert.equal(parseCalendarDate(invalid), null);
  }
});

test("extracted purchase-date control preserves date and maturity presentation", () => {
  const html = render(PurchaseDateInput, { value: "2026-10-05", durationDays: 5, disabled: true, onChange: noop });
  assert.match(html, /aria-label="买入日"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /2026 \/ 10 \/ 05/);
  assert.match(html, /按 5 天自动计算：10\/10 到期/);
  assert.match(html, /disabled=""/);
  const empty = render(PurchaseDateInput, { value: null, durationDays: 7, disabled: false, onChange: noop });
  assert.match(empty, /manual-date-trigger-empty/);
  assert.match(empty, /选择日期/);
  assert.match(empty, /填写后按 7 天自动计算到期日/);
});

const product = {
  id: "component-test", identityKey: "bitget-global:USDT:component-test", accountId: "bitget-global",
  exchange: "bitget", region: "global", asset: "USDT", name: "测试产品",
  productDataMode: "api", apiAccess: "authenticated", holdingDataMode: "api", productType: "flexible",
  source: { kind: "private", label: "API" }, rateCoverage: "complete",
  tiers: [{ id: "tier", min: 0, max: 100, apr: 8 }],
};
function renderRow(patch = {}, props = {}) {
  const rowProduct = { ...product, ...patch };
  return render(ProductRow, {
    product: rowProduct, baseProduct: rowProduct, holding: 20, holdingAvailable: true,
    editing: false, editable: false, saving: false, manualProduct: false,
    apiDeleteDisabled: false, changeEvents: [], onEventsRead: noop, onHoldingChange: noop,
    onOverrideChange: noop, onManualProductChange: noop, onDelete: noop, ...props,
  });
}

test("extracted product row retains known, zero and unknown holding presentation", () => {
  const known = renderRow();
  assert.equal((known.match(/<td/g) ?? []).length, 5);
  assert.match(known, /持仓 20\.00/);
  assert.match(known, /首档 100\.00/);
  assert.match(known, /还可放 80\.00 USDT/);
  const zero = renderRow({}, { holding: 0 });
  assert.match(zero, /product-row-empty/);
  const unknown = renderRow({}, { holding: 0, holdingAvailable: false, holdingSyncState: "error" });
  assert.match(unknown, /持仓未获取/);
  assert.doesNotMatch(unknown, /product-row-empty|持仓 0\.00/);
});

test("extracted product row preserves cache timestamps and known capacity when APR is missing", () => {
  const cached = renderRow({ aprSource: "cache", aprFetchedAt: "2026-10-05T02:03:00.000Z" }, {
    holdingFallbackAt: "2026-10-04T01:02:00.000Z",
  });
  assert.ok(cached.includes(`APR 沿用 ${formatSyncDateTime("2026-10-05T02:03:00.000Z")} 的缓存数据`));
  assert.ok(cached.includes(`持仓沿用 ${formatSyncDateTime("2026-10-04T01:02:00.000Z")} 的缓存数据`));
  const missingApr = renderRow({ rateCoverage: "unavailable", aprStatus: "unavailable" });
  assert.match(missingApr, /APR 未获取/);
  assert.match(missingApr, /首档 · 0\.00–100\.00/);
  assert.match(missingApr, /首档 100\.00/);
  assert.doesNotMatch(missingApr, /8\.00%|0\.00%/);
});

test("extracted product row keeps API edits read-only and omits an empty manual-field divider", () => {
  const apiEdit = renderRow({}, { editing: true });
  assert.match(apiEdit, /holding-editor-readonly/);
  assert.match(apiEdit, /API 同步/);
  assert.doesNotMatch(apiEdit, /class="manual-fields"|holding-editor-editable/);
  const manualEdit = renderRow({
    productDataMode: "manual", apiAccess: undefined, holdingDataMode: "manual",
    source: { kind: "manual", label: "手动维护" },
  }, { editing: true, editable: true, manualProduct: true, saving: true });
  assert.match(manualEdit, /manual-identity-fields/);
  assert.match(manualEdit, /aria-label="平台"/);
  assert.match(manualEdit, /aria-label="产品类型"/);
  assert.match(manualEdit, /class="manual-fields"/);
  assert.match(manualEdit, /aria-label="APR"/);
  assert.match(manualEdit, /aria-label="首档额度"/);
  assert.match(manualEdit, /holding-editor-editable/);
  assert.doesNotMatch(manualEdit, /aria-label="锁定期限"|aria-label="活动期限"/);
});

test("shared row presentation helpers retain their exact boundary and Shanghai-time behavior", () => {
  assert.equal(overflowFromFirstTier(product, 100), 0);
  assert.equal(overflowFromFirstTier(product, 105), 5);
  assert.equal(overflowFromFirstTier({ ...product, tiers: [{ ...product.tiers[0], max: null }] }, 105), 0);
  assert.equal(formatSyncDateTime("bad-date"), "bad-date");
  assert.equal(formatSyncDateTime("2026-10-05T02:03:00.000Z"), "10/05 10:03");
});
