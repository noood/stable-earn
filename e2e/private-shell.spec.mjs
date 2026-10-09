import { expect, test } from "@playwright/test";

test("private route serves a lightweight shell before loading the dashboard", async ({ page }) => {
  const response = await page.goto("/private?asset=USDC");

  expect(response?.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain("正在加载个人数据");
  expect(html).not.toContain("总持仓 ·");
  expect(html).not.toContain("USDT 持仓");

  await expect(page.getByRole("heading", { name: "USDC 持仓" })).toBeVisible();
});

test("startup diagnostics are visible only when explicitly requested", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/private?diagnostics=1");

  const diagnostics = page.getByLabel("页面启动诊断");
  await expect(diagnostics).toBeVisible();
  const bounds = await diagnostics.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
  await expect(diagnostics).toContainText("页面诊断（仅显示启动状态和 HTTP 状态码）");
  await expect(diagnostics).toContainText("页面脚本");
  await expect(diagnostics).toContainText("私人页面模块");
  await expect(diagnostics).toContainText("持仓数据接口");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();

  await page.goto("/private");
  await expect(page.getByLabel("页面启动诊断")).toHaveCount(0);
});
