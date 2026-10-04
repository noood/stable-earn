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

test("complete empty sync preview shows an ordinary empty directory without an API error", async ({ page }) => {
  await page.goto("/private?syncScenario=empty");
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table).toHaveAttribute("aria-busy", "false");
  await expect(table.getByText("吸引人的稳定理财尚未出现！")).toBeVisible();
  await expect(page.getByText(/本地测试数据截至 .*；不会写入数据库。/)).toBeVisible();
  await expect(page.locator(".error-panel")).toHaveCount(0);
});

test("API settings modal keeps its three sections, truthful account copy, and report feedback", async ({ page }) => {
  await page.route("**/private/api/credentials", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sources: [
          { id: "binance-global", label: "Binance.com", configured: false, requiresPassphrase: false, syncDescription: "自动同步四种资产的活期、定期产品、APR 与持仓" },
          { id: "binance-bahrain", label: "Binance Bahrain", configured: false, requiresPassphrase: false, syncDescription: "自动同步四种资产的活期、定期产品、APR 与持仓" },
          { id: "bybit-global", label: "Bybit.com", configured: false, requiresPassphrase: false, syncDescription: "产品 APR 由公开 API 提供（活期 USDT、USDC、BTC；定期四种资产）；持仓自动同步" },
          { id: "bitget-global", label: "Bitget", configured: false, requiresPassphrase: true, syncDescription: "自动同步四种资产的活期、定期产品、APR 与持仓" },
          { id: "okx-global", label: "OKX", configured: false, requiresPassphrase: true, syncDescription: "同步活期持仓余额（USDT、USDC、BTC；按币种汇总，不区分产品）；产品 APR 需手动维护" },
        ],
        manualSources: [
          { id: "bybit-eu", label: "Bybit EU", statusLabel: "手动维护", syncDescription: "产品 APR 由公开 API 提供（活期 USDT、USDC、BTC；定期四种资产）；持仓需手动维护" },
          { id: "mexc-ph", label: "MEXC · PH 🇵🇭", syncDescription: "产品信息与持仓需要手动维护" },
          { id: "mexc-uk", label: "MEXC · UK 🇬🇧", syncDescription: "产品信息与持仓需要手动维护" },
        ],
      }),
    });
  });
  await page.route("**/private/api/preferences", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ manualRefreshCooldownMinutes: 30 }) });
  });

  let releaseReport;
  let checkStarted = false;
  const reportGate = new Promise((resolve) => { releaseReport = resolve; });
  await page.route("**/private/api/diagnostics/platform-capabilities", async (route) => {
    checkStarted = true;
    await reportGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ generatedAt: "2026-10-04T00:00:00.000Z", dataChangesCommitted: false, includesHoldingAmounts: false, checkedItemCount: 112, checks: [] }),
    });
  });

  try {
    await page.goto("/private?settings=api");
    const dialog = page.getByRole("dialog", { name: "API 设置" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "手动刷新频率" })).toBeVisible();
    const cooldownOptions = dialog.getByRole("radiogroup", { name: "手动刷新冷却时间" });
    await expect(cooldownOptions).toHaveCSS("width", "160px");
    await expect(dialog.getByRole("radio", { name: "无" })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "30 分钟" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByText("仅限制手动刷新；不影响每日 07:00 更新和当天首次打开时的刷新。设置同步至此邮箱所有设备。")).toBeVisible();

    await expect(dialog.getByRole("heading", { name: "配置 API" })).toBeVisible();
    await expect(dialog.getByText("Key 和 Secret 由服务器加密保存；完整密钥不会返回浏览器。")).toBeVisible();
    const connectionList = dialog.locator(".api-connection-list");
    await expect(connectionList).toBeVisible();
    await expect(connectionList.locator(":scope > .api-connection-row")).toHaveCount(8);
    const euRow = connectionList.locator(".api-connection-row").filter({ hasText: "Bybit EU" });
    await expect(euRow).toContainText("手动维护");
    await expect(euRow).toContainText("产品 APR 由公开 API 提供（活期 USDT、USDC、BTC；定期四种资产）");
    await expect(euRow).toContainText("持仓需手动维护");
    await expect(euRow.getByRole("button", { name: "添加" })).toHaveCount(0);
    const bybitRow = connectionList.locator(".api-connection-row").filter({ hasText: "Bybit.com" });
    await expect(bybitRow).toContainText("产品 APR 由公开 API 提供（活期 USDT、USDC、BTC；定期四种资产）；持仓自动同步");

    await expect(dialog.getByRole("heading", { name: "API 检测" })).toBeVisible();
    const checkButton = dialog.getByRole("button", { name: "检测 API" });
    const checkButtonWidth = await checkButton.evaluate((button) => getComputedStyle(button).width);
    const checkButtonHeight = await checkButton.evaluate((button) => getComputedStyle(button).height);
    await expect(checkButton).toHaveCSS("width", "96px");
    await expect(checkButton).toHaveCSS("padding-left", "12px");
    await expect(cooldownOptions).toHaveCSS("height", checkButtonHeight);
    await expect(checkButton).toHaveText("检测 API");
    await expect(dialog.getByText("只读检查已知接口，不写入产品、持仓或历史；报告不含持仓金额或密钥。OKX On-chain Earn 单独检查。")).toBeVisible();
    await checkButton.click();
    await expect.poll(() => checkStarted).toBe(true);
    const loadingButton = dialog.getByRole("button", { name: "正在检测 API" });
    await expect(loadingButton).toBeDisabled();
    await expect(loadingButton).toHaveText("");
    await expect(loadingButton).toHaveCSS("width", checkButtonWidth);
    await expect(loadingButton).toHaveCSS("height", checkButtonHeight);
    const spinner = dialog.locator(".api-check-spinner");
    await expect(spinner).toBeVisible();
    const spinnerWidth = await spinner.evaluate((icon) => getComputedStyle(icon).width);

    releaseReport();
    const completeButton = dialog.getByRole("button", { name: "检测完成" });
    await expect(completeButton).toBeVisible();
    await expect(completeButton).toHaveText("");
    await expect(completeButton).toHaveCSS("width", checkButtonWidth);
    await expect(completeButton).toHaveCSS("height", checkButtonHeight);
    const downloadButton = dialog.getByRole("button", { name: /下载 JSON（\d{4}\/\d{1,2}\/\d{1,2}）/ });
    await expect(downloadButton).toBeVisible();
    await downloadButton.hover();
    await expect(downloadButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const successIcon = completeButton.locator(".api-check-success-icon");
    await expect(successIcon).toBeVisible();
    await expect(successIcon).toHaveAttribute("viewBox", "0 0 14 14");
    await expect(successIcon).toHaveCSS("width", spinnerWidth);
    await expect(dialog.getByText(/最近检查 · .* · 112 项/)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "检测 API" })).toBeVisible({ timeout: 5_000 });
    await expect(downloadButton).toBeVisible();

    for (const width of [719, 536]) {
      await page.setViewportSize({ width, height: 832 });
      for (const rowIndex of [0, 1]) {
        const row = dialog.locator(".api-settings-split-row").nth(rowIndex);
        await row.scrollIntoViewIfNeeded();
        const left = await row.locator(":scope > :first-child").boundingBox();
        const right = await row.locator(":scope > :last-child").boundingBox();
        expect(left).not.toBeNull();
        expect(right).not.toBeNull();
        expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
      }
    }

    await dialog.getByRole("button", { name: "关闭" }).click();
    await expect(dialog).toHaveCount(0);
    await page.locator(".action-menu-trigger").click();
    await page.getByRole("button", { name: "API 设置" }).click();
    const reopenedDialog = page.getByRole("dialog", { name: "API 设置" });
    await expect(reopenedDialog.getByRole("button", { name: /下载 JSON（\d{4}\/\d{1,2}\/\d{1,2}）/ })).toBeVisible();
    await reopenedDialog.getByRole("button", { name: "关闭" }).click();
    await page.getByRole("button", { name: "编辑持仓" }).click();
    const tableApiSettings = page.locator(".table-toolbar-inline-action");
    await expect(tableApiSettings).toBeVisible();
    await tableApiSettings.hover();
    await expect(tableApiSettings).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  } finally {
    releaseReport();
  }
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
