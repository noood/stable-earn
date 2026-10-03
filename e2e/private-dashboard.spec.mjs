import { expect, test } from "@playwright/test";

async function interceptLocalPortfolioSave(page, savedPayloads) {
  await page.route("**/private/api/holdings**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("preview") !== "1") {
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "E2E blocked non-preview write" }) });
      return;
    }
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }

    savedPayloads.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ saved: 0, manualUpdated: 0, productUpdated: 0, productDeleted: 0, updatedAt: "2026-10-03T00:00:00.000Z", preview: true }),
    });
  });
}

test("private dashboard reaches a settled table state and switches assets", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/private");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Stable Earn");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();

  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table).toHaveAttribute("aria-busy", "false");
  await expect(table.locator("tbody tr.product-row, tbody td[colspan='5']").first()).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "有效 APR" })).toBeVisible();

  await page.getByRole("button", { name: "USDC" }).click();
  await expect(page.getByRole("heading", { name: "USDC 持仓" })).toBeVisible();
  await expect(page).toHaveURL(/asset=USDC/);
  expect(pageErrors).toEqual([]);
});

test("table skeleton stays visible while the initial holdings read is pending", async ({ page }) => {
  let releaseHoldings;
  let holdingsIntercepted = false;
  const holdingsGate = new Promise((resolve) => { releaseHoldings = resolve; });

  await page.route("**/private/api/holdings**", async (route) => {
    holdingsIntercepted = true;
    await holdingsGate;
    await route.continue();
  });

  try {
    await page.goto("/private", { waitUntil: "domcontentloaded" });
    await expect.poll(() => holdingsIntercepted).toBe(true);

    const table = page.getByRole("table");
    await expect(table).toHaveAttribute("aria-busy", "true");
    await expect(table.locator(".skeleton-table-line").first()).toBeVisible();

    releaseHoldings();
    await expect(table).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    await expect(table.locator(".skeleton-table-line")).toHaveCount(0);
  } finally {
    releaseHoldings();
  }
});

test("editing guards asset switching with an accessible, keyboard-dismissible dialog", async ({ page }) => {
  await page.goto("/private");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();

  const editButton = page.getByRole("button", { name: "编辑持仓" });
  await expect(editButton).toBeEnabled();
  await editButton.click();
  await expect(page.getByRole("button", { name: "保存持仓" })).toBeVisible();

  const assetButton = page.getByRole("button", { name: "USDC" });
  await assetButton.click();

  const dialog = page.getByRole("dialog", { name: "请先完成编辑" });
  await expect(dialog).toBeVisible();
  const closeButton = dialog.getByRole("button", { name: "关闭" });
  await expect(closeButton).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "保存并离开" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(assetButton).toBeFocused();

  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("button", { name: "编辑持仓" })).toBeVisible();
});

test("local product history displays recorded events and clears the attention dot without writing remotely", async ({ page }) => {
  let historyWrites = 0;
  page.on("request", (request) => {
    if (request.url().includes("/private/api/product-history") && request.method() === "POST") historyWrites += 1;
  });

  await page.goto("/private");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();

  const productRow = page.getByRole("row").filter({ hasText: "Binance.com" }).filter({ hasText: "5.80%" });
  const historyButton = productRow.locator(".product-history-trigger");
  await expect(historyButton).toBeVisible();
  await expect(historyButton).toHaveAccessibleName("查看变更记录，有需要关注的变化");
  await historyButton.click();

  const dialog = page.getByRole("dialog", { name: "产品变更记录" });
  await expect(dialog.getByText("首档 APR 下调")).toBeVisible();
  await expect(dialog.getByText("首档额度减少")).toBeVisible();
  await expect(historyButton).toHaveAccessibleName("查看变更记录");
  expect(historyWrites).toBe(0);
});

test("empty local product history opens directly in its stable empty state", async ({ page }) => {
  await page.goto("/private");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();

  const productRow = page.getByRole("row").filter({ hasText: "Binance Bahrain" });
  const historyButton = productRow.getByRole("button", { name: "查看变更记录" });
  await historyButton.click();

  const dialog = page.getByRole("dialog", { name: "产品变更记录" });
  await expect(dialog.getByText("暂无变更记录")).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveCount(0);
});

test("saving an edited holding submits only the local preview payload", async ({ page }) => {
  const savedPayloads = [];
  await interceptLocalPortfolioSave(page, savedPayloads);
  await page.goto("/private");
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: "编辑持仓" }).click();
  const productRow = page.locator("tr.product-row").filter({ hasText: "Binance.com" }).filter({ hasText: "持仓 40.00" });
  await productRow.getByLabel("USDT 产品持仓").fill("41.25");
  await page.getByRole("button", { name: "保存持仓" }).click();

  await expect(page.getByRole("button", { name: "编辑持仓" })).toBeVisible();
  expect(savedPayloads).toHaveLength(1);
  expect(savedPayloads[0].changedHoldingProductIds).toContain("manual-preview-fixed");
  expect(savedPayloads[0].holdings).toMatchObject({ "manual-preview-fixed": 41.25 });
});

test("removing a manual product confirms the copy and submits a local preview deletion", async ({ page }) => {
  const savedPayloads = [];
  await interceptLocalPortfolioSave(page, savedPayloads);
  await page.goto("/private");
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "编辑持仓" }).click();

  const productRow = page.locator("tr.product-row").filter({ hasText: "Binance.com" }).filter({ hasText: "持仓 40.00" });
  await productRow.getByRole("button", { name: "移除产品" }).click();
  const dialog = page.getByRole("dialog", { name: "移除手动产品" });
  await expect(dialog).toContainText("移除该产品及其已保存的持仓和人工设置；产品变更记录仍会保留。");
  await dialog.getByRole("button", { name: "移除手动产品" }).click();
  await expect(productRow).toHaveCount(0);

  await page.getByRole("button", { name: "保存持仓" }).click();
  await expect(page.getByRole("button", { name: "编辑持仓" })).toBeVisible();
  expect(savedPayloads).toHaveLength(1);
  expect(savedPayloads[0].deletedManualProductIds).toContain("manual-preview-fixed");
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 375, height: 812 },
]) {
  test(`initial loading layout matches the ${viewport.name} visual baseline`, async ({ page }) => {
    let releaseRequests;
    let holdingsIntercepted = false;
    let productsIntercepted = false;
    const requestGate = new Promise((resolve) => { releaseRequests = resolve; });

    await page.route("**/private/api/holdings**", async (route) => {
      if (route.request().method() === "GET") {
        holdingsIntercepted = true;
        await requestGate;
      }
      await route.continue();
    });
    await page.route("**/private/api/products**", async (route) => {
      if (route.request().method() === "GET") {
        productsIntercepted = true;
        await requestGate;
      }
      await route.continue();
    });

    try {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/private", { waitUntil: "domcontentloaded" });
      await expect.poll(() => holdingsIntercepted && productsIntercepted).toBe(true);
      await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "true");
      await expect(page).toHaveScreenshot(`private-loading-${viewport.name}.png`, {
        animations: "disabled",
        caret: "hide",
      });
    } finally {
      releaseRequests();
    }
  });
}

test("mobile layout does not create page-level horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/private");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();
  await expect(page.getByRole("button", { name: "USDT" })).toBeVisible();

  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));

  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport);
});
