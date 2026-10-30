import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { summarizeStartupResources, summarizeStartupLongTasks } = moduleLoader()("@/lib/startup-resource-timing");
const resource = (name, rest = {}) => ({ name, startTime: 10, requestStart: 12, responseStart: 30, responseEnd: 40, transferSize: 1024, encodedBodySize: 800, ...rest });
const manifest = {
  version: 1,
  scripts: {
    framework: ["/_next/static/chunks/framework-123.js"],
    "private-dashboard-client": ["/_next/static/chunks/private-dashboard-client-789.js"],
  },
  dashboardPreloads: [],
};

test("resource timing uses exact manifest paths and exports only fixed same-origin labels and numeric measurements", () => {
  const lines = summarizeStartupResources([
    resource("https://app.example/_next/static/chunks/framework-123.js?secret=hidden"),
    resource("https://app.example/private/api/products?account=hidden"),
    resource("https://other.example/_next/static/chunks/vinext-hidden.js"),
    resource("https://app.example/_next/static/chunks/dashboard-456.js"),
    resource("https://app.example/_next/static/chunks/dashboard-guessed.js"),
    resource("https://app.example/_next/static/chunks/private-dashboard-client-789.js", { transferSize: 0 }),
  ], "https://app.example", 100, manifest);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].label, "框架脚本");
  assert.match(lines[0].value, /10→40ms · 首字节等待 18ms · 下载 10ms/);
  assert.equal(lines[1].label, "私人页外框脚本");
  assert.match(lines[1].value, /零传输不单独证明缓存命中/);
  assert.doesNotMatch(JSON.stringify(lines), /secret|hidden|https:|products|account|123|789/);
});

test("without an asset manifest, script filenames are not guessed", () => {
  const lines = summarizeStartupResources([
    resource("https://app.example/_next/static/chunks/framework-123.js"),
    resource("https://app.example/_next/static/css/site-456.css"),
  ], "https://app.example", 100);
  assert.deepEqual(lines.map((line) => line.label), ["页面样式"]);
});

test("basePath scripts require an exact same-origin manifest path and static CSS keeps its path boundary", () => {
  const baseManifest = {
    version: 1,
    scripts: { framework: ["/base/_next/static/chunks/framework-build.js?deploy=one"] },
    dashboardPreloads: [],
  };
  const lines = summarizeStartupResources([
    resource("https://app.example/base/_next/static/chunks/framework-build.js?deploy=one"),
    resource("https://app.example/base/_next/static/chunks/framework-other.js?deploy=one"),
    resource("https://app.example/base/_next/static-extra/chunks/framework-build.js?deploy=one"),
    resource("https://app.example/base/_next/static/css/site.css"),
    resource("https://app.example/base/_next/static-extra/css/site.css"),
    resource("https://cdn.example/base/_next/static/chunks/framework-build.js?deploy=one"),
  ], "https://app.example", 100, baseManifest);
  assert.deepEqual(lines.map((line) => line.label), ["框架脚本", "页面样式"]);
  assert.equal(lines.length, 2);
});

test("app-specific roles win when one physical chunk is listed under multiple roles", () => {
  const sharedManifest = {
    version: 1,
    scripts: {
      dashboard: ["/_next/static/chunks/app-dashboard.js"],
      "private-dashboard-client": ["/_next/static/chunks/private-shell.js"],
      framework: ["/_next/static/chunks/app-dashboard.js"],
      vinext: ["/_next/static/chunks/private-shell.js"],
    },
    dashboardPreloads: [],
  };
  const lines = summarizeStartupResources([
    resource("https://app.example/_next/static/chunks/app-dashboard.js"),
    resource("https://app.example/_next/static/chunks/private-shell.js", { startTime: 20 }),
  ], "https://app.example", 100, sharedManifest);
  assert.equal(lines.length, 2, "each physical resource is reported only once");
  assert.deepEqual(lines.map((line) => line.label), ["仪表盘脚本", "私人页外框脚本"]);
});

test("long-task reporting clips the measurement window and excludes later tasks", () => {
  const value = summarizeStartupLongTasks([
    { startTime: 10, duration: 60 }, { startTime: 80, duration: 80 },
    { startTime: 120, duration: 80 }, { startTime: 1, duration: 20 },
  ], 100);
  assert.match(value, /2个 ≥50ms 长任务 · 窗口内合计 80ms/);
  assert.match(value, /80→100ms/);
  assert.doesNotMatch(value, /120→/);
});
