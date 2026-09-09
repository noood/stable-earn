import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { moduleLoader } from "./helpers/load-ts.mjs";

const source = ts.createSourceFile("page.tsx", readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const parts = {};
function visit(node) {
  if (ts.isJsxElement(node)) {
    const className = node.openingElement.attributes.properties.find((attribute) => attribute.name?.getText(source) === "className")?.initializer?.text;
    if (className?.startsWith("metrics-panel ")) parts.metrics = node.getText(source);
    if (className?.startsWith("card type-caption mb-5 ")) parts.notice = node.getText(source);
    if (node.openingElement.tagName.getText(source) === "tbody") parts.body = node.getText(source);
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === "EmptyProductState") parts.empty = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(Object.keys(parts).length, 4);
const ui = moduleLoader()(new URL("../app/components/ui.tsx", import.meta.url).pathname);
const { dashboardReadState, serverReadFailureMessage } = moduleLoader()("@/lib/sync-notice");
function render(part, overrides = {}) {
  const props = {
    ...ui, dataBlocked: true, initialLoading: false, isDemo: false, asset: "USDT", serverReadFailureMessage,
    totalHolding: 100, holdingProductCount: 1, portfolioApr: 8, annualEarn: 8,
    bestProduct: { accountId: "test", rateCoverage: "max_only" }, highYieldLeft: 50, tierOneOverflow: 20,
    formatAmount: (value) => value.toFixed(2), highestProductApr: () => 10, accountName: () => "Test Exchange",
    tableProducts: [], ProductTableSkeleton: () => null,
    ...overrides,
  };
  const code = ts.transpileModule(`${parts.empty}\nreturn (${parts[part]});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return renderToStaticMarkup(new Function("React", ...Object.keys(props), code)(React, ...Object.values(props)));
}

test("personal read failure keeps six metric cards with missing values instead of misleading results", () => {
  const html = render("metrics");
  assert.equal((html.match(/class="metric-value[^\"]*">—<\/p>/g) ?? []).length, 6);
  assert.match(html, /metric-item-highlight/);
  assert.match(html, /— 个持仓产品/);
  for (const label of ["总持仓", "组合有效 APR", "预计每日收益", "最佳首档 APR", "高息剩余额度", "超出首档"]) assert.ok(html.includes(label));
  assert.doesNotMatch(html, /暂无产品|未超出首档|已进入次档|Test Exchange|text-danger|尚未加载|skeleton/);
});

test("personal read error notice has the requested copy and no retry button", () => {
  const html = render("notice");
  assert.match(html, /服务器读取失败，数据无法显示，请刷新页面。/);
  assert.doesNotMatch(html, /<button|重试/);
  assert.match(html, /text-danger font-semibold/);
});

test("personal read failure reuses the table empty state while ordinary empty portfolios retain their copy", () => {
  const failed = render("body");
  assert.match(failed, /colSpan="4"|colspan="4"/);
  assert.match(failed, /class="empty-product-state"/);
  assert.match(failed, /服务器读取失败，数据无法显示，请刷新页面。/);
  const empty = render("body", { dataBlocked: false });
  assert.match(empty, /吸引人的稳定理财尚未出现！/);
  assert.doesNotMatch(empty, /服务器读取失败/);
});

test("loading retains skeletons and loaded metrics retain actual values", () => {
  const loading = render("metrics", { dataBlocked: false, initialLoading: true });
  assert.equal((loading.match(/skeleton-value/g) ?? []).length, 6);
  const loaded = render("metrics", { dataBlocked: false });
  assert.match(loaded, /100\.00/);
  assert.match(loaded, /1 个持仓产品/);
  assert.match(loaded, /Test Exchange/);
  assert.match(loaded, /已进入次档/);
  assert.match(loaded, /metric-value type-metric text-warning/);
});

test("updating copy uses one warning style, with a timestamp only when available", () => {
  for (const lastUpdated of [null, "2026-09-08T02:36:00Z"]) {
    const html = render("notice", {
      dataBlocked: false, updating: true, historyAvailable: Boolean(lastUpdated), lastUpdated, loading: true,
      currentDataSummary: "",
    });
    assert.match(html, /text-warning font-semibold/);
    assert.doesNotMatch(html, /暂无成功数据|text-danger/);
    assert.ok(html.includes("数据正在更新中，请稍候。"));
    assert.doesNotMatch(html, /当前数据截至 09\/08 10:36/);
  }
});

test("page read errors override exchange warnings and dates", () => {
  for (const dataBlocked of [true, false]) {
    const html = render("notice", {
      dataBlocked, updating: false, loading: false, hasSyncFailure: true,
      currentDataSummary: "当前数据截至 09/08 11:09。", failureSummary: "Bitget API 暂不可用；下次更新将重试。",
    });
    assert.ok(html.includes(`${dataBlocked ? "text-danger" : "text-warning"} font-semibold`));
    if (dataBlocked) assert.doesNotMatch(html, /当前数据截至|Bitget/);
    else assert.match(html, /Bitget API 暂不可用/);
  }
});

const complete = { isDemo: false, opening: false, requesting: false, backgroundUpdating: false,
  personalReady: true, personalError: false, productReady: true, productReadFailed: false,
  lastUpdated: "2026-09-08T03:09:00Z" };

test("all combinations of read failures use untimed loading then the same blocked result", () => {
  for (const personalError of [false, true]) for (const productReadFailed of [false, true]) {
    if (!personalError && !productReadFailed) continue;
    const input = { ...complete, personalError, productReadFailed };
    const pending = dashboardReadState({ ...input, opening: true });
    assert.equal(pending.historyAvailable, false);
    assert.equal(pending.initialLoading, true);
    assert.equal(pending.dataBlocked, false);
    const html = render("notice", { ...pending, currentDataSummary: "" });
    assert.match(html, /数据正在更新中，请稍候。/);
    assert.doesNotMatch(html, /服务器读取失败|当前数据截至/);
    const ended = dashboardReadState(input);
    assert.equal(ended.dataBlocked, true);
    assert.equal(ended.canEdit, false);
    assert.equal(ended.initialLoading, false);
    assert.match(render("notice", ended), /服务器读取失败/);
    assert.equal((render("metrics", ended).match(/class="metric-value[^\"]*">—<\/p>/g) ?? []).length, 6);
    assert.match(render("body", ended), /服务器读取失败/);
  }
});

test("complete history stays visible through loading and becomes editable after completion", () => {
  for (const patch of [{ opening: true }, { requesting: true }, { backgroundUpdating: true }]) {
    const state = dashboardReadState({ ...complete, ...patch });
    assert.equal(state.updating, true);
    assert.equal(state.historyAvailable, true);
    assert.equal(state.initialLoading, false);
    assert.equal(state.canEdit, false);
  }
  assert.equal(dashboardReadState(complete).canEdit, true);
  const empty = dashboardReadState({ ...complete, lastUpdated: null });
  assert.equal(empty.dataBlocked, false); // Confirmed empty is not a failed read.
  assert.equal(empty.initialLoading, false);
});
