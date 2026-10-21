import { expect, test } from "@playwright/test";
import { moduleLoader } from "../tests/helpers/load-ts.mjs";

const fixedTime = "2026-10-21T10:00:00.000Z";
const { buildFailures } = moduleLoader()("@/lib/private-sync/status");
const failures = buildFailures({ binanceGlobal: "not_configured", binanceBahrain: "not_configured",
  bybitGlobal: "not_configured", bitget: "not_configured", okx: "partial" },
{ okx: "unreadable_balance:USDC" }, []);

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 375, height: 812 }]) {
  test(`OKX incomplete balance explains the problem and retains holdings on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.clock.setFixedTime(new Date(fixedTime));
    await page.route("**/private/api/products**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET" || url.searchParams.get("preview") !== "1") {
        return route.fulfill({ status: 403, json: { error: "non-preview blocked" } });
      }
      const response = await route.fetch();
      const payload = await response.json();
      payload.products = payload.products.filter((product) => product.id === "okx-usdt");
      payload.rates = [];
      payload.partial = true;
      payload.failures = failures;
      payload.apiFieldNotices = [];
      payload.holdingUpdates = { "okx-usdt": 500 };
      payload.holdingSourceIds = ["okx-usdt"];
      payload.holdingFallbacks = {};
      payload.holdingSyncStates = { "okx-usdt": "partial" };
      payload.holdingPositions = [];
      payload.changeEvents = [];
      payload.historySummaries = [];
      payload.cache.scheduledState = "disabled";
      return route.fulfill({ response, json: payload });
    });
    await page.route("**/private/api/holdings**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET" || url.searchParams.get("preview") !== "1") {
        return route.fulfill({ status: 403, json: { error: "non-preview blocked" } });
      }
      const response = await route.fetch();
      const payload = await response.json();
      payload.manualProducts = [];
      payload.overrides = { "okx-usdt": { apr: 6, firstTierLimit: 1000, termDays: null, purchaseDate: null,
        updatedAt: fixedTime, manualKind: "flexible" } };
      return route.fulfill({ response, json: payload });
    });
    await page.goto(`/private?previewAt=${encodeURIComponent(fixedTime)}`);
    await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
    const notice = page.locator(".sync-notice-message");
    await expect(notice).toContainText("OKX USDC 持仓部分数据未返回");
    await expect(notice.locator(".text-danger")).toContainText("OKX USDC");
    await expect(notice).not.toContainText("每日首次打开自动更新");
    await expect(page.getByRole("button", { name: "手动刷新", exact: true })).toBeVisible();
    const row = page.locator("tr.product-row").filter({ hasText: "OKX" });
    await expect(row).toContainText("500.00");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`okx-partial-${viewport.name}.png`), fullPage: true });
  });
}
