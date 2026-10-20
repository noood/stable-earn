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
    releaseDashboard();
    await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();
  } finally {
    releaseDashboard();
  }
});

test("module-download failure keeps the fixed shell without a retry button", async ({ page }) => {
  let dashboardRequestBlocked = false;
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

test("startup diagnostics are visible only when explicitly requested", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/private?diagnostics=1");

  const diagnostics = page.getByLabel("页面启动诊断");
  await expect(diagnostics).toBeVisible();
  const bounds = await diagnostics.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
  await expect(diagnostics).toContainText("页面诊断（启动阶段与耗时）");
  await expect(diagnostics).toContainText("客户端启动");
  await expect(diagnostics).toContainText("私人页面模块");
  await expect(diagnostics).toContainText("持仓数据接口");
  await expect(diagnostics).toContainText("首轮数据就绪");
  await expect(diagnostics).toContainText("浏览器");
  await expect(diagnostics).toContainText("服务端");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();

  await page.goto("/private");
  await expect(page.getByLabel("页面启动诊断")).toHaveCount(0);
});
