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
