import { expect, test } from "@playwright/test";

test("private route serves a lightweight shell before loading the dashboard", async ({ page }) => {
  const response = await page.goto("/private?asset=USDC");

  expect(response?.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain("skeleton-block");
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain("Stable Earn");
  expect(html).toContain("平台 / 产品");
  expect(html).toContain("实际到账以平台账户为准");
  expect(html).not.toContain("正在加载个人数据");
  expect(html).not.toContain("总持仓 ·");
  expect(html).not.toContain("USDT 持仓");

  await expect(page.getByRole("heading", { name: "USDC 持仓" })).toBeVisible();
});

test("module-loading skeleton has no visible copy and gives way to the dashboard", async ({ page }) => {
  let releaseDashboard;
  let dashboardRequestIntercepted = false;
  const accountReads = [];
  page.on("request", (request) => {
    if (["/private/api/holdings", "/private/api/products"].includes(new URL(request.url()).pathname)) accountReads.push(request);
  });
  const dashboardGate = new Promise((resolve) => { releaseDashboard = resolve; });
  await page.route((url) => url.pathname.endsWith("/app/components/dashboard/dashboard.tsx"), async (route) => {
    dashboardRequestIntercepted = true;
    await dashboardGate;
    await route.continue();
  });

  try {
    await page.goto("/private", { waitUntil: "domcontentloaded" });
    await expect.poll(() => dashboardRequestIntercepted).toBe(true);
    await expect(page.locator('.metrics-panel[aria-busy="true"] .skeleton-block').first()).toBeVisible();
    await expect(page.locator('.metrics-panel[aria-busy="true"]')).toContainText("组合有效 APR");
    await expect(page.locator('.metrics-panel[aria-busy="true"]')).toContainText("按各阶梯实际占用加权");
    await expect(page.locator('.metrics-panel[aria-busy="true"]')).toContainText("总持仓 · USDT");
    await expect(page.getByRole("button", { name: "编辑持仓" })).toBeDisabled();
    await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("Stable Earn");
    await expect(page.getByRole("button", { name: "USDT" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("columnheader", { name: "平台 / 产品" })).toBeVisible();
    await expect(page.getByText("实际到账以平台账户为准。", { exact: false })).toBeVisible();
    await expect(page.getByText("正在加载个人数据")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();
    await expect(page).toHaveScreenshot("private-module-loading.png", { animations: "disabled", caret: "hide" });
    expect(accountReads).toHaveLength(0);
    releaseDashboard();
    await expect(page.locator(".metrics-panel .skeleton-block")).toHaveCount(0);
    expect(accountReads.filter((request) => new URL(request.url()).pathname.endsWith("/holdings"))).toHaveLength(1);
    expect(accountReads.filter((request) => new URL(request.url()).pathname.endsWith("/products"))).toHaveLength(1);
  } finally {
    releaseDashboard();
  }
});

test("module-download failure keeps the fixed shell without a retry button", async ({ page }) => {
  let dashboardRequestBlocked = false;
  const accountReads = [];
  page.on("request", (request) => {
    if (["/private/api/holdings", "/private/api/products"].includes(new URL(request.url()).pathname)) accountReads.push(request);
  });
  await page.route((url) => url.pathname.endsWith("/app/components/dashboard/dashboard.tsx"), async (route) => {
    dashboardRequestBlocked = true;
    await route.abort();
  });

  await page.goto("/private", { waitUntil: "domcontentloaded" });
  await expect.poll(() => dashboardRequestBlocked).toBe(true);
  await expect(page.getByRole("alert")).toHaveText("页面加载失败，数据无法显示，请刷新页面。");
  await expect(page.getByRole("button", { name: "重试" })).toHaveCount(0);
  await expect(page.getByText("加载失败", { exact: true })).toHaveCount(6);
  await expect(page.locator(".metrics-panel")).toContainText("总持仓 · USDT");
  await expect(page.locator(".metrics-panel")).toContainText("预计每日收益 · USDT");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();
  await expect(page.getByText("持仓信息加载失败", { exact: true })).toBeVisible();
  await expect(page.locator(".empty-product-state > p")).toHaveText("页面加载失败，数据无法显示，请刷新页面。");
  await expect(page.getByRole("button", { name: "编辑持仓" })).toHaveClass(/button-primary/);
  await expect(page.locator(".empty-product-state > p")).toHaveClass(/text-muted type-label font-semibold/);
  await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("Stable Earn");
  await expect(page.getByRole("columnheader", { name: "平台 / 产品" })).toBeVisible();
  await expect(page.getByText("实际到账以平台账户为准。", { exact: false })).toBeVisible();
  expect(accountReads).toHaveLength(0);
});

test("a completed server daily marker removes the extra request without hiding the saved failure", async ({ page }) => {
  const methods = [];
  await page.route((url) => url.pathname === "/private/api/products", async (route) => {
    methods.push(route.request().method());
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: {
      ...data,
      dailyRefresh: { day: "2026-10-20", completed: true },
      cache: { ...data.cache, state: "error", lastError: "同步失败" },
      failures: ["产品和持仓数据更新失败"],
    } });
  });
  await page.goto("/private?diagnostics=1");
  await expect(page.getByLabel("页面启动诊断")).toContainText("无需请求：服务端确认今日尝试已完成");
  await expect(page.getByLabel("页面启动诊断")).toContainText("顶部更新提示结束（DOM提交）");
  expect(methods).toEqual(["GET"]);
  await expect(page.locator(".sync-notice-message")).toContainText("产品和持仓数据更新失败");
});

test("local-only module failure preview shows the failure style without a retry button", async ({ page }) => {
  let accountApiRequested = false;
  await page.route((url) => ["/private/api/holdings", "/private/api/products"].includes(url.pathname), async (route) => {
    accountApiRequested = true;
    await route.continue();
  });
  await page.goto("/private?moduleScenario=error", { waitUntil: "domcontentloaded" });
  await expect(page.locator('.metrics-panel[aria-busy="true"] .skeleton-block').first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("页面加载失败，数据无法显示，请刷新页面。");
  await expect(page.getByText("加载失败", { exact: true })).toHaveCount(6);
  await expect(page.locator(".metrics-panel")).toContainText("总持仓 · USDT");
  await expect(page.locator(".metrics-panel")).toContainText("预计每日收益 · USDT");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();
  await expect(page.getByText("持仓信息加载失败", { exact: true })).toBeVisible();
  await expect(page.locator(".empty-product-state > p")).toHaveText("页面加载失败，数据无法显示，请刷新页面。");
  await expect(page.getByRole("button", { name: "重试" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("Stable Earn");
  await expect(page.getByRole("columnheader", { name: "平台 / 产品" })).toBeVisible();
  expect(accountApiRequested).toBe(false);

});

test("local second-stage failure shows the same fixed shell from skeleton to account-read error", async ({ page }) => {
  let releaseHoldingsRead;
  let holdingsReadBlocked = false;
  const holdingsReadGate = new Promise((resolve) => { releaseHoldingsRead = resolve; });
  await page.route((url) => url.pathname === "/private/api/holdings" && url.searchParams.get("syncScenario") === "both-read-error", async (route) => {
    holdingsReadBlocked = true;
    await holdingsReadGate;
    await route.continue();
  });

  try {
    await page.goto("/private?syncScenario=both-read-error", { waitUntil: "domcontentloaded" });
    await expect.poll(() => holdingsReadBlocked).toBe(true);
    await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("Stable Earn");
    await expect(page.locator('.metrics-panel[aria-busy="true"] .skeleton-block').first()).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "平台 / 产品" })).toBeVisible();
    await expect(page.getByText("实际到账以平台账户为准。", { exact: false })).toBeVisible();

    releaseHoldingsRead();
    await expect(page.locator('.card[aria-live="polite"]').getByText("服务器读取失败，数据无法显示，请刷新页面。", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "编辑持仓" })).toHaveClass(/button-primary/);
    await expect(page.locator(".empty-product-state > p")).toHaveClass(/text-muted type-label font-semibold/);
    await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("Stable Earn");
    await expect(page.getByRole("columnheader", { name: "平台 / 产品" })).toBeVisible();
    await expect(page.locator(".metrics-panel")).toContainText("—");
  } finally {
    releaseHoldingsRead();
  }
});

test("startup diagnostics are visible only when explicitly requested", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/private?diagnostics=1");

  const diagnostics = page.getByLabel("页面启动诊断");
  await expect(diagnostics).toBeVisible();
  const bounds = await diagnostics.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
  await expect(diagnostics).toContainText("页面诊断（启动阶段与耗时）");
  await expect(diagnostics).toContainText("启动期间曾在后台：否");
  await expect(diagnostics).toContainText("HTML 请求与下载");
  await expect(diagnostics).toContainText("客户端模块执行");
  await expect(diagnostics).toContainText("客户端挂载");
  await expect(diagnostics).toContainText("私人页面模块");
  await expect(diagnostics).toContainText("界面首次渲染开始");
  await expect(diagnostics).toContainText("界面首次 DOM 提交");
  await expect(diagnostics).toContainText("初始化任务准备");
  await expect(diagnostics).toContainText("下一帧开始初始化");
  await expect(diagnostics).toContainText("持仓数据接口");
  await expect(diagnostics).toContainText("产品缓存读取");
  await expect(diagnostics).not.toContainText("每日刷新请求");
  await expect(diagnostics).toContainText("骨架屏移除（DOM提交）");
  await expect(diagnostics).toContainText("顶部更新提示结束（DOM提交）");
  await expect(diagnostics).toContainText("首次打开流程结束");
  await expect(diagnostics).toContainText("资源计时范围");
  await expect(diagnostics).toContainText("启动主线程长任务");
  await expect(diagnostics).toContainText("浏览器");
  await expect(diagnostics).toContainText("服务端");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("startup-diagnostics-darwin.png"), fullPage: true });

  await page.goto("/private");
  await expect(page.getByLabel("页面启动诊断")).toHaveCount(0);
});

test("diagnostics show same-request D1 timings and safe resource labels without changing product loading", async ({ page }) => {
  await page.addInitScript(() => {
    const original = performance.getEntriesByType.bind(performance);
    performance.getEntriesByType = (type) => type !== "resource" ? original(type) : [{
      name: `${location.origin}/_next/static/chunks/framework-synthetic.js?private=must-not-appear`,
      startTime: 1, requestStart: 2, responseStart: 3, responseEnd: 4, transferSize: 1024, encodedBodySize: 800,
    }];
  });
  await page.route((url) => url.pathname === "/private/api/products", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: {
      ...response.headers(),
      "server-timing": 'app;dur=350,history_recent;dur=340;desc="start=1",history_unread;dur=100;desc="start=1",history_merge;dur=1;desc="start=341",history_recent_sql;desc="value=3.9",history_recent_rows;desc="value=760",history_recent_attempts;desc="value=1"',
    } });
  });
  await page.goto("/private?diagnostics=1");
  const diagnostics = page.getByLabel("页面启动诊断");
  await expect(diagnostics).toContainText("最近历史调用总耗时 340ms");
  await expect(diagnostics).toContainText("最近历史 SQL 执行（末次尝试） 3.9ms");
  await expect(diagnostics).toContainText("最近历史返回 760条");
  await expect(diagnostics).toContainText("框架脚本");
  await expect(diagnostics).toContainText("导航后 1→4ms");
  await expect(diagnostics).not.toContainText("must-not-appear");
  await expect(page.locator(".metrics-panel .skeleton-block")).toHaveCount(0);
});

test("the content checkpoint follows skeleton removal while the update notice can remain active", async ({ page }) => {
  let releaseCache;
  let cacheRequested = false;
  const cacheGate = new Promise((resolve) => { releaseCache = resolve; });
  await page.route((url) => url.pathname === "/private/api/products", async (route) => {
    cacheRequested = true;
    await cacheGate;
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, cache: { ...data.cache, state: "syncing" } } });
  });
  try {
    await page.goto("/private?diagnostics=1", { waitUntil: "domcontentloaded" });
    await expect.poll(() => cacheRequested).toBe(true);
    const diagnostics = page.getByLabel("页面启动诊断");
    await expect(page.locator('.metrics-panel[aria-busy="true"] .skeleton-block').first()).toBeVisible();
    await expect(diagnostics).not.toContainText("骨架屏移除（DOM提交）");
    releaseCache();
    await expect(diagnostics).toContainText("骨架屏移除（DOM提交）");
    await expect(page.locator(".metrics-panel .skeleton-block")).toHaveCount(0);
    await expect(page.locator(".product-table tbody .skeleton-block")).toHaveCount(0);
    await expect(page.locator(".sync-notice-message")).toContainText("数据正在更新中，请稍候。");
    await expect(diagnostics).not.toContainText("顶部更新提示结束（DOM提交）");
  } finally {
    releaseCache();
  }
});
