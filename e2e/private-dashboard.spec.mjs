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

test("header menu action labels align vertically within their rows", async ({ page }) => {
  await page.goto("/private");
  await page.locator(".action-menu-trigger").click();
  const apiSettings = page.locator(".action-menu-popover .menu-item").filter({ hasText: "API 设置" });
  await expect(apiSettings).toBeVisible();
  await expect(apiSettings).toHaveCSS("display", "flex");
  await expect(apiSettings).toHaveCSS("align-items", "center");
});

test("an unknown API quota shows a red warning instead of unlimited capacity", async ({ page }) => {
  await page.route("**/private/api/products**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("preview") !== "1") return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    const product = payload.products.find((item) => item.id === "preview-apr-six");
    product.tiers[0].max = null;
    delete product.tiers[0].maxStatus;
    await route.fulfill({ response, json: payload });
  });

  await page.goto("/private");
  const row = page.locator("tr.product-row").filter({ hasText: "首档额度待确认" });
  await expect(row).toBeVisible();
  await expect(row.locator(".product-meta-danger")).toContainText("首档额度待确认，不参与收益计算");
  await expect(row).toContainText("申购额度 · 上限待确认");
  await expect(row).not.toContainText("不限额");
});

test("complete empty sync preview shows an ordinary empty directory without an API error", async ({ page }) => {
  await page.goto("/private?syncScenario=empty");
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table).toHaveAttribute("aria-busy", "false");
  await expect(table.getByText("吸引人的稳定理财尚未出现！")).toBeVisible();
  await expect(page.getByText(/当前数据截至 .*，每日首次打开自动更新。/)).toBeVisible();
  await expect(page.locator(".error-panel")).toHaveCount(0);
});

test("a sync failure has a separate brand-colored manual refresh action", async ({ page }) => {
  for (const viewport of [{ width: 780, height: 842 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/private?syncScenario=error");
    const notice = page.locator(".sync-notice-copy");
    const refreshButton = page.getByRole("button", { name: "手动刷新" });
    await expect(refreshButton).toBeVisible();
    await expect(refreshButton).toHaveClass(/button-primary/);
    await expect(refreshButton).toHaveClass(/button-small/);
    await expect(refreshButton).toHaveCSS("font-size", "12px");
    await expect(refreshButton).toHaveCSS("font-weight", "600");
    await expect(refreshButton).toHaveCSS("padding-left", "12px");
    await expect(refreshButton).toHaveCSS("border-radius", "8px");
    await expect(refreshButton).toHaveCSS("background-color", "rgb(23, 63, 53)");
    await expect(notice).toContainText(/当前数据截至 .*，/);
    await expect(notice).not.toContainText("每日首次打开自动更新");
    await expect(notice).toContainText("本次产品和持仓数据更新失败");
    await expect(notice).not.toContainText("请手动刷新");
    await expect(notice).not.toContainText("下次更新将重试");
    const bounds = await page.evaluate(() => {
      const notice = document.querySelector(".card.type-caption.mb-4");
      const copy = document.querySelector(".sync-notice-copy");
      const icon = document.querySelector(".sync-notice-icon");
      const firstLine = document.querySelector(".sync-notice-message > span:first-child");
      const button = document.querySelector(".sync-notice-refresh");
      const rect = (node) => node.getBoundingClientRect();
      return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
        notice: rect(notice), copy: rect(copy), icon: rect(icon), firstLine: rect(firstLine), button: rect(button) };
    });
    expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.button.x).toBeGreaterThanOrEqual(bounds.copy.x + bounds.copy.width);
    expect(bounds.button.x + bounds.button.width).toBeLessThanOrEqual(bounds.notice.x + bounds.notice.width);
    expect(Math.abs((bounds.copy.y + bounds.copy.height / 2) - (bounds.notice.y + bounds.notice.height / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.icon.y - bounds.firstLine.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.icon.height - bounds.firstLine.height)).toBeLessThanOrEqual(1);
    const refreshRequestPromise = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/private/api/products" && url.searchParams.get("refresh") === "1";
    });
    await refreshButton.click();
    const refreshRequest = await refreshRequestPromise;
    expect(refreshRequest.method()).toBe("POST");
    expect((await refreshRequest.allHeaders()).origin).toBe(new URL(refreshRequest.url()).origin);
    await expect(refreshButton).toBeVisible();
  }
});

test("top error action stays disabled without a countdown while the menu shows the retry time", async ({ page }) => {
  await page.route("**/private/api/products**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("preview") !== "1") return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    payload.cache = { ...payload.cache, cooldownUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
    await route.fulfill({ response, json: payload });
  });

  await page.goto("/private?syncScenario=error");
  const notice = page.locator(".card.type-caption.mb-4");
  const topRefresh = notice.getByRole("button", { name: "手动刷新" });
  await expect(topRefresh).toBeDisabled();
  await expect(topRefresh).toHaveText("手动刷新");
  await expect(notice).not.toContainText("冷却至");

  await page.locator(".action-menu-trigger").click();
  const menuRefresh = page.locator(".menu-item-refresh");
  await expect(menuRefresh).toBeDisabled();
  await expect(menuRefresh).toContainText(/冷却至 \d{2}:\d{2}/);
});

test("top notice keeps success, partial failure, total failure, read failure and refresh states distinct", async ({ page }) => {
  const notice = page.locator(".card.type-caption").first();

  await page.goto("/private?syncScenario=success");
  await expect(notice).toContainText(/当前数据截至 .*，每日首次打开自动更新。/);
  await expect(notice.getByRole("button", { name: "手动刷新" })).toHaveCount(0);

  await page.goto("/private?syncScenario=partial");
  await expect(notice).toContainText(/当前数据截至 .*，/);
  await expect(notice).toContainText("Bitget 持仓数据未完整返回");
  await expect(notice).not.toContainText("每日首次打开自动更新");
  const partialRefresh = notice.getByRole("button", { name: "手动刷新" });
  await expect(partialRefresh).toBeVisible();
  await expect(notice.locator(".sync-notice-message")).not.toContainText("请手动刷新");
  await expect(partialRefresh).toHaveClass(/button-primary/);

  await page.goto("/private?syncScenario=error");
  await expect(notice).toContainText("本次产品和持仓数据更新失败");
  await expect(notice).not.toContainText("每日首次打开自动更新");

  await page.goto("/private?syncScenario=initial-error");
  await expect(notice).toContainText("暂无成功测试数据，");
  await expect(notice).toContainText("本次产品和持仓数据更新失败");
  await expect(notice).not.toContainText("当前数据截至");
  const noCacheRefresh = notice.getByRole("button", { name: "手动刷新" });
  await expect(noCacheRefresh).toBeVisible();
  await expect(noCacheRefresh).toHaveClass(/button-primary/);
  await expect(notice.locator(".sync-notice-message")).not.toContainText("请手动刷新");

  await page.goto("/private?syncScenario=product-read-error");
  await expect(notice).toContainText("服务器读取失败，数据无法显示，请刷新页面。");
  await expect(notice).not.toContainText("当前数据截至");
  await expect(notice.getByRole("button", { name: "手动刷新" })).toHaveCount(0);

  await page.goto("/private?syncScenario=syncing");
  await expect(notice).toContainText("数据正在更新中，请稍候。");
  await expect(notice).not.toContainText("当前数据截至");
  await expect(notice.getByRole("button", { name: "手动刷新" })).toHaveCount(0);
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
          { id: "okx-global", label: "OKX", configured: false, requiresPassphrase: true, syncDescription: "同步 USDT、USDC、BTC 活期持仓；每币种对应一条跟踪产品，成功完整回包缺少币种行按 0；产品 APR 需手动维护" },
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
      body: JSON.stringify({
        generatedAt: "2026-10-04T00:00:00.000Z",
        dataChangesCommitted: false,
        includesHoldingAmounts: false,
        checkedItemCount: 112,
        requestSafety: { requestsStarted: 38, requestLimit: 40, concurrencyLimit: 3, stopReason: null },
        checks: [],
      }),
    });
  });

  try {
    await page.goto("/private?settings=api");
    const dialog = page.getByRole("dialog", { name: "API 设置" });
    await expect(dialog).toBeVisible();
    const sectionHeadings = await dialog.locator(".api-settings-body h3").allTextContents();
    expect(sectionHeadings.slice(0, 3)).toEqual(["配置 API", "手动刷新频率", "API 检测"]);
    const modalBody = dialog.locator(".api-settings-body");
    const modalBodyBox = await modalBody.boundingBox();
    expect(modalBodyBox).not.toBeNull();
    const pageScrollBeforeModalWheel = await page.evaluate(() => window.scrollY);
    await modalBody.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.mouse.move(modalBodyBox.x + modalBodyBox.width / 2, modalBodyBox.y + modalBodyBox.height - 16);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(pageScrollBeforeModalWheel);
    await expect(dialog).toBeVisible();
    await modalBody.evaluate((element) => { element.scrollTop = 0; });
    const closeButton = dialog.getByRole("button", { name: "关闭" });
    await expect(closeButton).toHaveCSS("width", "32px");
    await expect(closeButton).toHaveCSS("height", "32px");
    await expect(closeButton.locator("svg")).toHaveCSS("width", "20px");
    await expect.poll(() => closeButton.locator("svg path").evaluate((path) => path.getBBox().width)).toBe(12);
    await expect(dialog.getByRole("heading", { name: "手动刷新频率" })).toBeVisible();
    const cooldownOptions = dialog.getByRole("radiogroup", { name: "手动刷新冷却时间" });
    await expect(cooldownOptions).toHaveCSS("width", "160px");
    await expect(cooldownOptions).toHaveCSS("height", "40px");
    const noCooldown = dialog.getByRole("radio", { name: "无" });
    await expect(noCooldown).toBeVisible();
    await expect(noCooldown).toHaveCSS("font-size", "14px");
    await expect(noCooldown).toHaveCSS("line-height", "20px");
    await expect(dialog.getByRole("radio", { name: "30 分钟" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByText("仅限制手动刷新；当天首次打开页面时仍会自动更新。设置同步至此邮箱所有设备。")).toBeVisible();

    await expect(dialog.getByRole("heading", { name: "配置 API" })).toBeVisible();
    await expect(dialog.locator(".api-settings-body > section").first()).toHaveCSS("margin-block-end", "32px");
    await expect(dialog.getByText("Key 和 Secret 由服务器加密保存；完整密钥不会返回浏览器。")).toBeVisible();
    const connectionList = dialog.locator(".api-connection-list");
    await expect(connectionList).toBeVisible();
    await expect(connectionList.locator(":scope > .api-connection-row")).toHaveCount(8);
    await expect(connectionList.locator(".api-connection-row").first().locator(":scope > div")).toHaveCSS("column-gap", "24px");
    const euRow = connectionList.locator(".api-connection-row").filter({ hasText: "Bybit EU" });
    await expect(euRow).toContainText("手动维护");
    await expect(euRow).toContainText("产品 APR 由公开 API 提供（活期 USDT、USDC、BTC；定期四种资产）");
    await expect(euRow).toContainText("持仓需手动维护");
    await expect(euRow.getByRole("button", { name: "添加" })).toHaveCount(0);
    const bybitRow = connectionList.locator(".api-connection-row").filter({ hasText: "Bybit.com" });
    await expect(bybitRow).toContainText("产品 APR 由公开 API 提供（活期 USDT、USDC、BTC；定期四种资产）；持仓自动同步");
    const okxRow = connectionList.locator(".api-connection-row").filter({ hasText: "OKX" });
    await expect(okxRow).toContainText("每币种对应一条跟踪产品，成功完整回包缺少币种行按 0");

    await expect(dialog.getByRole("heading", { name: "API 检测" })).toBeVisible();
    const checkButton = dialog.getByRole("button", { name: "检测 API" });
    const checkButtonWidth = await checkButton.evaluate((button) => getComputedStyle(button).width);
    const checkButtonHeight = await checkButton.evaluate((button) => getComputedStyle(button).height);
    const addButton = dialog.getByRole("button", { name: "添加" }).first();
    const editHoldingsButton = page.getByRole("button", { name: "编辑持仓" });
    await expect(checkButton).toHaveCSS("width", "96px");
    await expect(checkButton).toHaveCSS("height", "40px");
    await expect(addButton).toHaveCSS("height", "40px");
    await expect(editHoldingsButton).toHaveCSS("height", "40px");
    await expect(checkButton).toHaveCSS("padding-left", "16px");
    await expect(checkButton).toHaveCSS("padding-left", await addButton.evaluate((button) => getComputedStyle(button).paddingLeft));
    await expect(checkButton).toHaveCSS("border-radius", "10px");
    await expect(checkButton).toHaveCSS("border-radius", await addButton.evaluate((button) => getComputedStyle(button).borderRadius));
    await expect(checkButton).toHaveCSS("padding-left", await editHoldingsButton.evaluate((button) => getComputedStyle(button).paddingLeft));
    await expect(checkButton).toHaveCSS("border-radius", await editHoldingsButton.evaluate((button) => getComputedStyle(button).borderRadius));
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

    releaseReport();
    const completeCheckButton = dialog.getByRole("button", { name: "检测完成" });
    await expect(completeCheckButton).toBeVisible();
    await expect(completeCheckButton).toHaveCSS("width", checkButtonWidth);
    await expect(completeCheckButton).toHaveCSS("height", checkButtonHeight);
    const downloadButton = dialog.getByRole("button", { name: /下载 JSON · \d{4}\/\d{1,2}\/\d{1,2}/ });
    await expect(downloadButton).toBeVisible();
    await expect(dialog.getByRole("status")).toContainText("本次共发起 38 个请求");
    await downloadButton.hover();
    await expect(downloadButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(completeCheckButton.locator(".api-check-success-icon")).toBeVisible();
    await expect(dialog.getByText(/最近检查 · .* · 112 项/)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "检测 API" })).toBeVisible({ timeout: 5_000 });
    await expect(downloadButton).toBeVisible();

    for (const width of [719, 536, 375]) {
      await page.setViewportSize({ width, height: 832 });
      const pageWidths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      expect(pageWidths.document).toBeLessThanOrEqual(pageWidths.viewport);
      expect(pageWidths.body).toBeLessThanOrEqual(pageWidths.viewport);
      for (const rowIndex of [0, 1]) {
        const row = dialog.locator(".api-settings-split-row").nth(rowIndex);
        await expect(row).toHaveCSS("column-gap", width <= 639 ? "16px" : "32px");
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
    await expect(reopenedDialog.getByRole("button", { name: /下载 JSON · \d{4}\/\d{1,2}\/\d{1,2}/ })).toBeVisible();
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

test("scrolling the product history popover at its boundary does not scroll the page or close it", async ({ page }) => {
  await page.goto("/private?asset=USDT");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();

  const row = page.locator("tr.product-row").filter({ hasText: "Binance.com" }).first();
  await row.getByRole("button", { name: /查看变更记录/ }).click();
  const popover = page.getByRole("dialog", { name: "产品变更记录" });
  await expect(popover).toBeVisible();
  await expect.poll(() => popover.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  const pageScrollBeforePopoverWheel = await page.evaluate(() => window.scrollY);
  const popoverBox = await popover.boundingBox();
  expect(popoverBox).not.toBeNull();
  await popover.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.mouse.move(popoverBox.x + popoverBox.width / 2, popoverBox.y + popoverBox.height - 12);
  await page.mouse.wheel(0, 500);

  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(pageScrollBeforePopoverWheel);
  await expect(popover).toBeVisible();
});

test("rate-limited API report explains partial results and shows a retry countdown", async ({ page }) => {
  await page.route("**/private/api/credentials", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sources: [], manualSources: [] }) });
  });
  await page.route("**/private/api/preferences", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ manualRefreshCooldownMinutes: 30 }) });
  });
  await page.route("**/private/api/diagnostics/platform-capabilities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: "2026-10-04T00:00:00.000Z",
        dataChangesCommitted: false,
        includesHoldingAmounts: false,
        checkedScopeCount: 56,
        checkedItemCount: 112,
        requestSafety: { requestsStarted: 8, requestLimit: 40, concurrencyLimit: 3, stopReason: "rate_limited", retryAfterSeconds: 292 },
        checks: [],
      }),
    });
  });

  await page.goto("/private?settings=api");
  const dialog = page.getByRole("dialog", { name: "API 设置" });
  const checkButton = dialog.getByRole("button", { name: "检测 API" });
  await checkButton.click();

  const status = dialog.getByRole("status");
  await expect(status).toHaveText("已发出 8 次请求，平台限制了检查请求，已停止后续探测，本报告没有完整生成。请等冷却时间结束后再次检测。");
  await expect(status).toHaveClass(/error-panel/);
  await expect(dialog.getByRole("button", { name: /下载 JSON/ })).toHaveCount(0);
  const waitingButton = dialog.getByRole("button", { name: "等待 04:52 后可检测" });
  await expect(waitingButton).toBeDisabled();
  await expect(waitingButton).toHaveText("04:52");

  if (process.env.API_RATE_LIMIT_PREVIEW_PATH) {
    await dialog.locator(".api-settings-body > section").last().screenshot({ path: process.env.API_RATE_LIMIT_PREVIEW_PATH });
  }
});

test("a rate-limited check removes a JSON download from the previous complete report", async ({ page }) => {
  await page.route("**/private/api/credentials", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sources: [], manualSources: [] }) });
  });
  await page.route("**/private/api/preferences", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ manualRefreshCooldownMinutes: 30 }) });
  });

  let probeCount = 0;
  await page.route("**/private/api/diagnostics/platform-capabilities", async (route) => {
    probeCount += 1;
    const limited = probeCount === 2;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: "2026-10-04T00:00:00.000Z",
        dataChangesCommitted: false,
        includesHoldingAmounts: false,
        checkedScopeCount: 56,
        checkedItemCount: limited ? 56 : 112,
        requestSafety: {
          requestsStarted: limited ? 8 : 38,
          requestLimit: 40,
          concurrencyLimit: 3,
          stopReason: limited ? "rate_limited" : null,
          ...(limited ? { retryAfterSeconds: 292 } : {}),
        },
        checks: [],
      }),
    });
  });

  await page.goto("/private?settings=api");
  const dialog = page.getByRole("dialog", { name: "API 设置" });
  await dialog.getByRole("button", { name: "检测 API" }).click();
  const downloadButton = dialog.getByRole("button", { name: /下载 JSON/ });
  await expect(downloadButton).toBeVisible();

  await expect(dialog.getByRole("button", { name: "检测 API" })).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole("button", { name: "检测 API" }).click();
  await expect(dialog.getByRole("status")).toContainText("本报告没有完整生成");
  await expect(dialog.getByRole("button", { name: /下载 JSON/ })).toHaveCount(0);
});

test("localhost rate-limit demo uses mock data without calling the diagnostics API", async ({ page }) => {
  let diagnosticsRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/private/api/diagnostics/platform-capabilities")) diagnosticsRequests += 1;
  });

  await page.goto("/private?settings=api&apiCheckScenario=rate-limited");
  const dialog = page.getByRole("dialog", { name: "API 设置" });
  await expect(dialog.getByText("本地演示模式：点击后显示模拟限流结果，不会连接交易所或修改数据。")).toHaveCount(0);
  await dialog.getByRole("button", { name: "检测 API" }).click();
  await expect(dialog.getByRole("status")).toContainText("请等冷却时间结束后再次检测");
  await expect(dialog.getByRole("button", { name: "等待 04:52 后可检测" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /下载 JSON/ })).toHaveCount(0);
  expect(diagnosticsRequests).toBe(0);
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
