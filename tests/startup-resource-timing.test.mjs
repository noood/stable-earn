import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { summarizeStartupResources, summarizeStartupLongTasks } = moduleLoader()("@/lib/startup-resource-timing");
const resource = (name, rest = {}) => ({ name, startTime: 10, requestStart: 12, responseStart: 30, responseEnd: 40, transferSize: 1024, encodedBodySize: 800, ...rest });

test("resource timing exports only fixed same-origin script labels and numeric measurements", () => {
  const lines = summarizeStartupResources([
    resource("https://app.example/_next/static/chunks/framework-123.js?secret=hidden"),
    resource("https://app.example/private/api/products?account=hidden"),
    resource("https://other.example/_next/static/chunks/vinext-hidden.js"),
    resource("https://app.example/_next/static/chunks/dashboard-456.js", { responseEnd: 200 }),
    resource("https://app.example/_next/static/chunks/private-dashboard-client-789.js", { transferSize: 0 }),
  ], "https://app.example", 100);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].label, "框架脚本");
  assert.match(lines[0].value, /10→40ms · 首字节等待 18ms · 下载 10ms/);
  assert.match(lines[1].value, /零传输不单独证明缓存命中/);
  assert.doesNotMatch(JSON.stringify(lines), /secret|hidden|https:|products|account|123|789/);
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
