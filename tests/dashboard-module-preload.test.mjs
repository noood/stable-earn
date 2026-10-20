import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { moduleLoader } from "./helpers/load-ts.mjs";

function renderHints(assets = {}, browser = false) {
  let registryReads = 0;
  const { DashboardModulePreload } = moduleLoader({
    "vinext/server/pages-client-assets": { getPagesClientAssets() { registryReads++; return assets; } },
  }, { window: browser ? {} : undefined })("@/app/private/dashboard-module-preload.tsx");
  return { html: renderToStaticMarkup(React.createElement(DashboardModulePreload)), registryReads };
}

test("SSR emits deduplicated manifest script hints without hardcoded build names or dashboard execution", () => {
  const { html, registryReads } = renderHints({
    dynamicPreloads: { "app/components/dashboard/dashboard.tsx": [
      "_next/static/chunks/dashboard-build-a.js",
      "_next/static/chunks/shared-build-b.js",
      "_next/static/chunks/dashboard-build-a.js",
      "_next/static/css/site-build-c.css",
    ], "unrelated.tsx": ["must-not-appear.js"] },
  });
  assert.equal(registryReads, 1);
  assert.equal((html.match(/rel="modulepreload"/g) ?? []).length, 2);
  assert.match(html, /href="\/_next\/static\/chunks\/dashboard-build-a.js"/);
  assert.match(html, /href="\/_next\/static\/chunks\/shared-build-b.js"/);
  assert.match(html, /as="script" crossorigin="" fetchPriority="low"/);
  assert.doesNotMatch(html, /must-not-appear|\.css|<script/);
});

test("SSR keeps prefixed/CDN paths and the framework's configured crossorigin", () => {
  const { html } = renderHints({ crossOrigin: "use-credentials", dynamicPreloads: {
    "app/components/dashboard/dashboard.tsx": ["/base/_next/dashboard.js", "https://cdn.example.test/dashboard.js", "//cdn.example.test/shared.js"],
  } });
  assert.match(html, /href="\/base\/_next\/dashboard.js"/);
  assert.match(html, /href="https:\/\/cdn.example.test\/dashboard.js"/);
  assert.match(html, /href="\/\/cdn.example.test\/shared.js"/);
  assert.equal((html.match(/crossorigin="use-credentials"/g) ?? []).length, 3);
});

test("development/missing manifest produces no hint or fallback guessed URL", () => {
  assert.equal(renderHints().html, "");
  assert.equal(renderHints({ dynamicPreloads: {} }).html, "");
});

test("browser renders nothing and does not read the server asset registry", () => {
  const result = renderHints({ dynamicPreloads: {
    "app/components/dashboard/dashboard.tsx": ["_next/static/chunks/dashboard.js"],
  } }, true);
  assert.equal(result.html, "");
  assert.equal(result.registryReads, 0);
});
