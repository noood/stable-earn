import { expect, test } from "@playwright/test";
import { moduleLoader } from "../tests/helpers/load-ts.mjs";

const { localPrivateProductsPreview, localPrivateHoldingsPreview } = moduleLoader()("@/lib/local-preview");
const productId = "bn-g-usdt";
const at = new Date("2026-10-20T10:00:00Z");

async function fixture(page, { failFirst = false, failRead = false, delayHistory = false, failModule = false } = {}) {
  const products = localPrivateProductsPreview(at);
  delete products.changeEvents;
  products.cache.cooldownUntil = null;
  const events = Array.from({ length: 60 }, (_, i) => ({
    id: `event-${i}`, productId, type: "rate", title: `记录 ${i}`,
    before: "8.00%", after: "5.00%", source: "手动刷新",
    observedAt: new Date(at.getTime() - i * 60_000).toISOString(),
    attention: i === 0 || i === 59,
  }));
  let pages = 0, writes = 0, productReads = 0;
  let releaseHistory;
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  const summary = () => ({ productId, eventCount: events.length, unreadCount: events.filter((e) => e.attention && !e.readAt).length });
  // All account APIs are synthetic. Never forward a request to an authenticated service.
  await page.route("**/private/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/session")) return route.fulfill({ json: { email: "test@example.invalid" } });
    if (url.pathname.endsWith("/holdings") && request.method() === "GET") return route.fulfill({ json: localPrivateHoldingsPreview(at) });
    if (url.pathname.endsWith("/products")) {
      productReads++;
      return route.fulfill({ json: { ...products, historySummaries: [summary()], dailyRefresh: { day: "2026-10-20", completed: true } } });
    }
    if (url.pathname.endsWith("/product-history")) {
      if (request.method() === "GET") {
        pages++;
        if (delayHistory) await historyGate;
        if (failFirst) { failFirst = false; return route.fulfill({ status: 503, json: { error: "test failure" } }); }
        const cursor = url.searchParams.get("cursor");
        const boundary = cursor === null ? null : JSON.parse(cursor);
        const ordered = [...events].sort((a, b) => a.observedAt === b.observedAt
          ? a.id === b.id ? 0 : a.id < b.id ? 1 : -1
          : a.observedAt < b.observedAt ? 1 : -1);
        const remaining = ordered.filter((item) => !boundary || item.observedAt < boundary.observedAt
          || (item.observedAt === boundary.observedAt && item.id < boundary.id));
        const items = remaining.slice(0, 50);
        const last = items.at(-1);
        return route.fulfill({ json: { events: items, nextCursor: remaining.length > items.length
          ? JSON.stringify({ observedAt: last.observedAt, id: last.id }) : null } });
      }
      writes++;
      if (failRead) return route.fulfill({ status: 503, json: { error: "test failure" } });
      const { eventIds, productId: requestedProduct } = request.postDataJSON();
      expect(requestedProduct).toBe(productId);
      expect(eventIds.length).toBeLessThanOrEqual(50);
      for (const item of events) if (eventIds.includes(item.id)) item.readAt = at.toISOString();
      return route.fulfill({ json: { eventIds, readAt: at.toISOString(), historySummary: summary() } });
    }
    return route.fulfill({ status: 403, json: { error: "unexpected account request blocked" } });
  });
  if (failModule) await page.route(/\/chunks\/dashboard-[^/]+\.js$/, (route) => route.abort());
  await page.goto("/private?diagnostics=1");
  if (!failModule) await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  const row = page.locator("tr.product-row").filter({ hasText: "Binance Global" }).filter({ hasText: "活期理财" }).first();
  const trigger = row.locator(".product-history-trigger");
  const dialog = page.getByRole("dialog", { name: "产品变更记录" });
  return { trigger, dialog, events, pages: () => pages, writes: () => writes, reads: () => productReads,
    releaseHistory, allowReads: () => { failRead = false; },
    async refresh() {
      const before = productReads;
      await page.getByRole("heading", { name: "USDT 持仓" }).click();
      await page.locator(".action-menu-trigger").click();
      await page.locator(".action-menu-popover").getByRole("button", { name: "手动刷新", exact: true }).click();
      await expect.poll(() => productReads).toBeGreaterThan(before);
      await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
    },
  };
}

test("production HTML preloads dashboard resources before the shell finishes, without duplicate downloads", async ({ page }) => {
  await fixture(page);
  const html = await (await page.request.get("/private")).text();
  expect(html).toMatch(/rel="modulepreload"[^>]*href="[^\"]*\/dashboard-[^\"]+\.js"/);
  const resources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => ({
    name: entry.name, start: entry.startTime, end: entry.responseEnd, initiator: entry.initiatorType,
  })));
  const dashboard = resources.filter((entry) => /\/chunks\/dashboard-[^/]+\.js$/.test(entry.name));
  const shell = resources.find((entry) => /\/chunks\/private-dashboard-client-[^/]+\.js$/.test(entry.name));
  expect(dashboard).toHaveLength(1);
  console.info("production resource timing", { dashboard: { start: dashboard[0].start, end: dashboard[0].end, initiator: dashboard[0].initiator }, shell: { start: shell.start, end: shell.end } });
  // Chromium may classify modulepreload as "other"; request ordering and
  // a single resource entry, not that label, prove early fetching and reuse.
  expect(dashboard[0].start).toBeLessThanOrEqual(shell.end);
});

test("a production modulepreload/import failure retains the shell and never starts account reads", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const f = await fixture(page, { failModule: true });
  await expect(page.getByRole("alert")).toHaveText("页面加载失败，数据无法显示，请刷新页面。");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  expect(f.reads()).toBe(0);
  expect(f.pages()).toBe(0);
  expect(errors).toEqual([]);
});

test("summary-only first screen does not request details; old unread alerts stay until their page is presented", async ({ page }) => {
  const f = await fixture(page, { delayHistory: true });
  expect(f.pages()).toBe(0);
  expect(f.reads()).toBe(1);
  await expect(f.trigger).toHaveAccessibleName("查看变更记录，有需要关注的变化");
  await f.trigger.click();
  await expect(f.dialog.locator(".product-history-loading")).toBeVisible();
  expect(f.writes()).toBe(0);
  f.releaseHistory();
  await expect(f.dialog.locator(".product-history-event")).toHaveCount(50);
  await expect.poll(f.writes).toBe(1);
  await expect(f.trigger).toHaveAccessibleName("查看变更记录，有需要关注的变化");
  expect(f.events.find((e) => e.id === "event-59").readAt).toBeUndefined();
  await f.dialog.getByRole("button", { name: "加载更早记录" }).click();
  await expect(f.dialog.locator(".product-history-event")).toHaveCount(60);
  await expect(f.trigger).toHaveAccessibleName("查看变更记录");
  expect(f.writes()).toBe(2);
});

test("summary revision refreshes the latest page and retains loaded older pages, even for backdated inserts", async ({ page }) => {
  const f = await fixture(page);
  await f.trigger.click();
  await expect(f.dialog.locator(".product-history-event")).toHaveCount(50);
  await f.dialog.getByRole("button", { name: "加载更早记录" }).click();
  await expect(f.dialog.locator(".product-history-event")).toHaveCount(60);
  await expect(f.trigger).toHaveAccessibleName("查看变更记录");
  f.events.unshift({ ...f.events[0], id: "new-head", title: "刷新后新记录", readAt: undefined });
  const pages = f.pages();
  await f.refresh();
  await expect(f.trigger).toHaveAccessibleName("查看变更记录，有需要关注的变化");
  await f.trigger.click();
  await expect(f.dialog.getByText("刷新后新记录", { exact: true })).toBeVisible();
  await expect(f.dialog.locator(".product-history-event")).toHaveCount(61);
  await expect(f.trigger).toHaveAccessibleName("查看变更记录");
  // Both already-loaded pages must be reconciled before confirming this
  // revision, not just the newest 50 records.
  expect(f.pages()).toBe(pages + 2);
  await f.refresh();
  await f.trigger.click();
  expect(f.pages()).toBe(pages + 2); // read-state-only changes do not invalidate details
  f.events.push({ ...f.events[0], id: "backdated", title: "补记的更早记录", observedAt: "2020-01-01T00:00:00Z", readAt: undefined });
  await f.refresh();
  await expect(f.trigger).toHaveAccessibleName("查看变更记录，有需要关注的变化");
  await f.trigger.click();
  await expect(f.dialog.locator(".product-history-event")).toHaveCount(62);
  await expect(f.dialog.getByText("补记的更早记录", { exact: true })).toBeVisible();
  await expect(f.trigger).toHaveAccessibleName("查看变更记录");
  expect(f.pages()).toBe(pages + 4);
  expect(f.events.find((item) => item.id === "backdated").readAt).toBe(at.toISOString());
});

test("detail failures and failed read acknowledgements never clear the summary dot", async ({ page }) => {
  const f = await fixture(page, { failFirst: true, failRead: true });
  await f.trigger.click();
  await expect(f.dialog.getByRole("button", { name: "加载失败，点击重试" })).toBeVisible();
  expect(f.writes()).toBe(0);
  await expect(f.trigger).toHaveAccessibleName("查看变更记录，有需要关注的变化");
  await f.dialog.getByRole("button", { name: "加载失败，点击重试" }).click();
  await expect(f.dialog.locator(".product-history-event")).toHaveCount(50);
  await expect.poll(f.writes).toBeGreaterThan(0);
  await expect(f.trigger).toHaveAccessibleName("查看变更记录，有需要关注的变化");
  f.allowReads();
  await page.getByRole("heading", { name: "USDT 持仓" }).click();
  await f.trigger.click();
  await expect.poll(() => f.events[0].readAt).toBe(at.toISOString());
  await expect(f.trigger).toHaveAccessibleName("查看变更记录，有需要关注的变化");
});
