import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { moduleLoader } from "./helpers/load-ts.mjs";

const source = ts.createSourceFile("dashboard.tsx", readFileSync(new URL("../app/components/dashboard/dashboard.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const parts = {};
function visit(node) {
  if (ts.isJsxElement(node)) {
    if (node.openingElement.tagName.getText(source) === "MetricsPanel") parts.metrics = node.getText(source);
    if (node.openingElement.tagName.getText(source) === "DashboardSyncNotice") parts.notice = node.getText(source);
    if (node.openingElement.tagName.getText(source) === "DashboardProductTableSection") {
      const rows = node.children.find((child) => ts.isJsxExpression(child));
      if (rows?.expression) parts.body = rows.expression.getText(source);
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.deepEqual(Object.keys(parts).sort(), ["body", "metrics", "notice"]);
const load = moduleLoader();
const ui = load("@/app/components/ui");
const { DashboardSyncNotice, ProductTableEmptyState } = load("@/app/components/dashboard/dashboard-frame");
const { DashboardMetricsSkeleton, metricDescriptions } = load("@/app/components/dashboard/dashboard-skeleton");
const { dashboardReadState, serverReadFailureMessage } = load("@/lib/sync-notice");
function render(part, overrides = {}) {
  const props = {
    ...ui, dataBlocked: true, initialLoading: false, updating: false, isDemo: false, asset: "USDT", serverReadFailureMessage,
    totalHolding: 100, portfolioApr: 8, annualEarn: 8, hasApy: false,
    bestProduct: { accountId: "test", rateCoverage: "complete", tiers: [{ min: 0, max: 100, apr: 10 }] }, highYieldLeft: 50, tierOneOverflow: 20,
    formatAmount: (value) => value.toFixed(2), highestProductApr: () => 10, accountName: () => "Test Exchange",
    tableProducts: [],
    DashboardMetricsSkeleton, metricDescriptions, DashboardSyncNotice, ProductTableEmptyState,
    ProductTableSkeletonRows: () => null,
    ...overrides,
  };
  props.scheduledRefreshFailed ??= false;
  props.hasSyncFailure ??= false;
  props.uniqueMissingApiFieldNotices ??= [];
  props.hasTopNotice ??= props.hasSyncFailure || props.uniqueMissingApiFieldNotices.length > 0;
  props.manualRefreshInProgress ??= false;
  props.preserveManualRefreshButton ??= false;
  props.showSyncFailureRefresh ??= (props.manualRefreshInProgress && props.preserveManualRefreshButton)
    || (!props.dataBlocked && !props.isDemo && !props.updating && !props.scheduledRefreshFailed && props.hasTopNotice);
  const code = ts.transpileModule(`return (${parts[part]});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return renderToStaticMarkup(new Function("React", ...Object.keys(props), code)(React, ...Object.values(props)));
}

test("personal read failure keeps six metric cards with missing values instead of misleading results", () => {
  const html = render("metrics");
  assert.equal((html.match(/class="metric-value[^\"]*">—<\/p>/g) ?? []).length, 6);
  assert.match(html, /metric-item-highlight/);
  for (const label of ["总持仓", "组合有效 APR", "预计每日收益", "最佳首档 APR", "高息剩余额度", "超出首档"]) assert.ok(html.includes(label));
  assert.doesNotMatch(html, /个持仓产品|暂无产品|未超出首档|已进入次档|Test Exchange|text-danger|尚未加载|skeleton/);
});

test("a complete API response can still name a product with missing APR in the top notice", () => {
  const html = render("notice", {
    dataBlocked: false, updating: false, hasSyncFailure: false,
    currentDataSummary: "当前数据截至 10/06 13:02，",
    uniqueMissingApiFieldNotices: ["Bitget · USDT 活期 · APR 未获取"],
    openingLoading: false, loading: false, refreshingExchange: false,
    manualRefreshCooling: false, handleManualRefresh() {},
  });
  assert.match(html, /Bitget · USDT 活期 · APR 未获取/);
  assert.match(html, /data-icon="bell"/);
  assert.match(html, /sync-notice-refresh/);
  assert.doesNotMatch(html, /部分数据未返回|API 暂不可用/);
});

test("personal read error notice has the requested copy and no retry button", () => {
  const html = render("notice");
  assert.match(html, /服务器读取失败，数据无法显示，请刷新页面。/);
  assert.match(html, /data-icon="bell"/);
  assert.doesNotMatch(html, /<button|重试/);
  assert.match(html, /text-danger/);
});

test("personal read failure reuses the table empty state while ordinary empty portfolios retain their copy", () => {
  const failed = render("body");
  assert.match(failed, /colSpan="5"|colspan="5"/);
  assert.match(failed, /class="empty-product-state"/);
  assert.match(failed, /服务器读取失败，数据无法显示，请刷新页面。/);
  const empty = render("body", { dataBlocked: false });
  assert.match(empty, /吸引人的稳定理财尚未出现！/);
  assert.doesNotMatch(empty, /服务器读取失败/);
});

test("loading retains skeletons and loaded metrics retain actual values", () => {
  const loading = render("metrics", { dataBlocked: false, initialLoading: true });
  assert.equal((loading.match(/skeleton-value/g) ?? []).length, 6);
  assert.doesNotMatch(loading, /skeleton-note|metric-note/);
  const loaded = render("metrics", { dataBlocked: false });
  assert.match(loaded, /100\.00/);
  assert.doesNotMatch(loaded, /个持仓产品|已进入次档|未超出首档/);
  assert.match(loaded, /最佳首档 APR · Test Exchange/);
  assert.match(loaded, /metric-value type-metric text-danger/);
  const noBest = render("metrics", { dataBlocked: false, bestProduct: null });
  assert.match(noBest, /暂无可确认的首档/);
  assert.doesNotMatch(noBest, /最佳首档 APR ·/);
});

test("updating shows the clock and hides previous failures and timestamps", () => {
  for (const lastUpdated of [null, "2026-09-08T02:36:00Z"]) {
    const html = render("notice", {
      dataBlocked: false, updating: true, historyAvailable: Boolean(lastUpdated), lastUpdated, loading: true,
      currentDataSummary: "", hasSyncFailure: true, failureSummary: serverReadFailureMessage,
      uniqueMissingApiFieldNotices: ["首档额度未获取"],
    });
    assert.match(html, /text-secondary|text-muted/);
    assert.match(html, /data-icon="clock"/);
    assert.doesNotMatch(html, /暂无成功数据|text-danger|服务器读取失败/);
    assert.ok(html.includes("数据正在更新中，请稍候。"));
    assert.doesNotMatch(html, /当前数据截至 09\/08 10:36/);
  }
});

test("the public demo notice shows a bell and only the login word is actionable", () => {
  const html = render("notice", {
    isDemo: true, dataBlocked: false, openPrivateDashboard() {},
  });
  assert.match(html, /data-icon="bell"/);
  assert.match(html, /<p\b[^>]*>以下均为演示数据，<button\b[^>]*class="[^"]*\bbutton-text\b[^"]*"[^>]*>登录<\/button>可同步私人数据。<\/p>/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /text-danger|role="alert"/);
});

test("an overdue scheduled refresh shows the bell without changing live announcements or offering a retry", () => {
  const html = render("notice", {
    dataBlocked: false, updating: false, currentDataSummary: "", scheduledRefreshFailed: true,
    scheduledFailureLabel: "定时更新失败，下次更新将重试。",
  });
  assert.match(html, /定时更新失败，下次更新将重试。/);
  assert.match(html, /data-icon="bell"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /role="alert"|<button/);
});

test("page read errors override exchange warnings and dates", () => {
  for (const dataBlocked of [true, false]) {
    const html = render("notice", {
      dataBlocked, updating: false, loading: false, hasSyncFailure: true,
      currentDataSummary: "当前数据截至 09/08 11:09，", failureSummary: "Bitget API 暂不可用",
      openingLoading: false, refreshingExchange: false, manualRefreshCooling: false, handleManualRefresh() {},
    });
    assert.match(html, /text-danger/);
    assert.match(html, /data-icon="bell"/);
    if (dataBlocked) assert.doesNotMatch(html, /当前数据截至|Bitget/);
    else {
      assert.match(html, /Bitget API 暂不可用/);
      assert.match(html, /当前数据截至 09\/08 11:09，/);
      assert.match(html, /<span class="[^"]*text-danger[^"]*">Bitget API 暂不可用<\/span>/);
      assert.match(html, /<button[^>]*class="[^"]*button button-primary button-small[^"]*sync-notice-refresh[^"]*"[^>]*>手动刷新<\/button>/);
      assert.doesNotMatch(html, /，请|button-text/);
      assert.doesNotMatch(html, /下次更新将重试/);
    }
  }
});

test("manual refresh keeps the visible recovery button busy until the request settles", () => {
  const inFlight = render("notice", {
    dataBlocked: false, updating: true, hasSyncFailure: false,
    manualRefreshInProgress: true, preserveManualRefreshButton: true,
    currentDataSummary: "", openingLoading: false, loading: true, refreshingExchange: true,
    failureSummary: "", manualRefreshCooling: false, handleManualRefresh() {},
  });
  assert.match(inFlight, /<button[^>]*aria-label="正在刷新"[^>]*aria-busy="true"[^>]*>\s*<span class="loading-spinner" aria-hidden="true"><\/span>\s*<\/button>/);
  assert.match(inFlight, /data-icon="clock"/);

  const succeeded = render("notice", {
    dataBlocked: false, updating: false, hasSyncFailure: false,
    manualRefreshInProgress: false, preserveManualRefreshButton: false,
    currentDataSummary: "", openingLoading: false, loading: false, refreshingExchange: false,
    failureSummary: "", manualRefreshCooling: false, handleManualRefresh() {},
  });
  assert.doesNotMatch(succeeded, /sync-notice-refresh/);
  assert.match(succeeded, /data-icon="clock"/);

  const failed = render("notice", {
    dataBlocked: false, updating: false, hasSyncFailure: true,
    manualRefreshInProgress: false, preserveManualRefreshButton: false,
    currentDataSummary: "", openingLoading: false, loading: false, refreshingExchange: false,
    failureSummary: "同步失败", manualRefreshCooling: false, handleManualRefresh() {},
  });
  assert.match(failed, /class="[^"]*sync-notice-refresh[^"]*"[^>]*>\s*手动刷新\s*<\/button>/);
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
