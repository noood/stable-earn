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
function render(part, overrides = {}) {
  const props = {
    ...ui, personalDataBlocked: true, initialLoading: false, isDemo: false, asset: "USDT",
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
});

test("personal read failure reuses the table empty state while ordinary empty portfolios retain their copy", () => {
  const failed = render("body");
  assert.match(failed, /colSpan="4"|colspan="4"/);
  assert.match(failed, /class="empty-product-state"/);
  assert.match(failed, /服务器读取失败，数据无法显示，请刷新页面。/);
  const empty = render("body", { personalDataBlocked: false });
  assert.match(empty, /吸引人的稳定理财尚未出现！/);
  assert.doesNotMatch(empty, /服务器读取失败/);
});

test("loading retains skeletons and loaded metrics retain actual values", () => {
  const loading = render("metrics", { personalDataBlocked: false, initialLoading: true });
  assert.equal((loading.match(/skeleton-value/g) ?? []).length, 6);
  const loaded = render("metrics", { personalDataBlocked: false });
  assert.match(loaded, /100\.00/);
  assert.match(loaded, /1 个持仓产品/);
  assert.match(loaded, /Test Exchange/);
  assert.match(loaded, /已进入次档/);
});
