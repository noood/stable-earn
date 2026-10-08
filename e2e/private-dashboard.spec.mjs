import { expect, test } from "@playwright/test";

const visualPreviewAt = "2026-10-06T10:00:00.000Z";

async function waitForVisualAssets(page) {
  await page.evaluate(() => Promise.all([
    document.fonts.ready,
    ...Array.from(document.images, (image) => image.decode().catch(() => undefined)),
  ]));
}

async function openFixedPrivatePreview(page, viewport) {
  await page.clock.setFixedTime(new Date(visualPreviewAt));
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`/private?previewAt=${encodeURIComponent(visualPreviewAt)}`);
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("tr.product-row").first()).toBeVisible();
  await waitForVisualAssets(page);
}

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

test("BTC logo is served from the local SVG asset", async ({ page }) => {
  await page.goto("/");
  const btcTab = page.getByRole("button", { name: "BTC", exact: true });
  const icon = btcTab.locator("img.asset-icon-image");
  await expect(icon).toHaveAttribute("src", "/bitcoin.svg");
  await expect.poll(() => icon.evaluate((image) => image.naturalWidth)).toBe(64);
});

test("BTC logo falls back to a text symbol if the local asset cannot load", async ({ page }) => {
  await page.route("**/bitcoin.svg", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("button", { name: "BTC", exact: true }).locator(".bitcoin-icon-fallback")).toHaveText("₿");
});

test("header menu action labels align vertically within their rows", async ({ page }) => {
  await page.goto("/private");
  await page.locator(".action-menu-trigger").click();
  const apiSettings = page.locator(".action-menu-popover .menu-item").filter({ hasText: "API 设置" });
  await expect(apiSettings).toBeVisible();
  await expect(apiSettings).toHaveCSS("display", "flex");
  await expect(apiSettings).toHaveCSS("align-items", "center");
});

test("public menu has equal space above and below its only action", async ({ page }) => {
  await page.goto("/");
  await page.locator(".action-menu-trigger").click();
  const menu = page.locator(".action-menu-popover");
  const action = menu.getByRole("button", { name: "API 设置" });
  await expect(action).toBeVisible();
  const gaps = await menu.evaluate((popover) => {
    const item = popover.querySelector(".menu-item");
    if (!item) throw new Error("Public menu action missing");
    const outer = popover.getBoundingClientRect();
    const inner = item.getBoundingClientRect();
    return { top: inner.top - outer.top, bottom: outer.bottom - inner.bottom };
  });
  expect(gaps.top).toBeCloseTo(gaps.bottom, 0);
});

test("signed-out demo shows two synthetic product changes without requesting private history", async ({ page }) => {
  let privateHistoryRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/private/api/product-history")) privateHistoryRequests += 1;
  });
  await page.goto("/");
  const row = page.getByRole("row").filter({ hasText: "Binance.com" }).filter({ hasText: "6.20%" });
  await expect(row).not.toContainText("阶梯额度未获取");
  await expect(row).toContainText("5.35%");
  const historyButton = row.getByRole("button", { name: "查看变更记录" });
  await historyButton.click();
  const dialog = page.getByRole("dialog", { name: "产品变更记录" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("首档 APR 下调")).toBeVisible();
  await expect(dialog.getByText("首档额度减少")).toBeVisible();
  await expect(dialog.locator(".product-history-event")).toHaveCount(2);
  expect(privateHistoryRequests).toBe(0);
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
  const row = page.locator("tr.product-row").filter({ hasText: "首档额度未获取" });
  await expect(row).toBeVisible();
  await expect(row.locator(".product-meta-danger")).toContainText("首档额度未获取，不参与收益计算");
  await expect(page.locator(".sync-notice-message")).toContainText("Fixed Saving · 7 天 · APR 边界 · 首档额度未获取");
  await expect(row).toContainText("申购额度 · 上限未获取");
  await expect(row).not.toContainText("不限额");
});

test("known quota and remaining capacity stay visible when unrelated product information is missing", async ({ page }) => {
  await page.route("**/private/api/products**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("preview") !== "1") return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    payload.holdingUpdates["okx-usdt"] = 0;
    await route.fulfill({ response, json: payload });
  });

  await page.goto("/private");
  const row = page.locator("tr.product-row").filter({ hasText: "OKX" }).filter({ hasText: "活动期限待填写" });
  await expect(row).toContainText("活动期限待填写，不参与收益计算");
  await expect(row.locator(".holding-summary")).toContainText("持仓 0.00 / 首档 500.00");
  await expect(row.locator(".holding-summary")).toContainText("还可放 500.00 USDT");
  await expect(row.getByRole("progressbar", { name: "OKX 首档使用进度" })).toBeVisible();
  await expect(row.locator("td").nth(3)).toHaveText("—");
});

test("a mixed-source product follows API holding rules when removed", async ({ page }) => {
  await page.goto("/private");
  await page.getByRole("button", { name: "编辑持仓" }).click();
  const heldOkx = page.locator("tr.product-row").filter({ hasText: "OKX" });
  await expect(heldOkx.getByRole("button", { name: "移除产品" })).toBeDisabled();
  await page.getByRole("button", { name: "取消" }).first().click();
  await page.getByRole("button", { name: "BTC", exact: true }).first().click();
  await page.getByRole("button", { name: "编辑持仓" }).click();
  const emptyOkx = page.locator("tr.product-row").filter({ hasText: "OKX" });
  await emptyOkx.getByRole("button", { name: "移除产品" }).click();
  await expect(page.getByRole("dialog", { name: "移除产品" })).toBeVisible();
});

test("multiple API positions do not borrow one purchase date for the whole product", async ({ page }) => {
  let missingDate = true;
  await page.route("**/private/api/products**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("preview") !== "1") return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    const productId = "preview-binance-fixed-expired-held";
    payload.holdingPositions = payload.holdingPositions.filter((position) => position.productId !== productId);
    payload.holdingPositions.push(
      { productId, positionId: "one", amount: 100, source: "api", purchaseAt: "2026-10-01T00:00:00Z", updatedAt: visualPreviewAt },
      { productId, positionId: "two", amount: 200, source: "api", ...(missingDate ? {} : { purchaseAt: "2026-10-02T00:00:00Z" }), updatedAt: visualPreviewAt },
    );
    await route.fulfill({ response, json: payload });
  });

  await page.goto("/private");
  const row = page.locator("tr.product-row").filter({ hasText: "持仓 300.00 / 申购额度 300.00" });
  await expect(row).toContainText("买入日未获取，不参与收益计算");
  await expect(row.locator("td").nth(3)).toHaveText("—");
  missingDate = false;
  await page.reload();
  await expect(row).toContainText("多笔持仓");
  await expect(row).toContainText("各笔到期日请在交易所查看");
  await expect(row).not.toContainText("买入日未获取");
  await expect(row.locator("td").nth(3)).not.toHaveText("—");
});

test("a known first tier stays visible without claiming an unknown later rate", async ({ page }) => {
  await page.route("**/private/api/products**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("preview") !== "1") return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    payload.products.find((product) => product.id === "bn-g-usdt").rateCoverage = "partial";
    await route.fulfill({ response, json: payload });
  });

  await page.goto("/private");
  const row = page.locator("tr.product-row").filter({ hasText: "阶梯结构未获取" });
  await expect(row.locator(".holding-summary")).toContainText("持仓 650.00 / 首档 300.00");
  await expect(row.locator(".holding-summary")).toContainText("超出首档 +350.00 USDT · 后续档位待确认");
  await expect(row.locator("td").nth(3)).toHaveText("—");
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
    await expect(dialog.getByText("只读检查已知接口，不写入产品、持仓或历史；报告不含持仓金额或密钥。")).toBeVisible();
    await checkButton.click();
    await expect.poll(() => checkStarted).toBe(true);
    const loadingButton = dialog.getByRole("button", { name: "正在检测 API" });
    await expect(loadingButton).toBeDisabled();
    await expect(loadingButton).toHaveText("");
    await expect(loadingButton).toHaveCSS("width", checkButtonWidth);
    await expect(loadingButton).toHaveCSS("height", checkButtonHeight);
    const spinner = dialog.locator(".loading-spinner");
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
    const tableApiSettings = page.locator(".button-text-inline-action");
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

test("hover- and click-open history both close when their trigger leaves view", async ({ page }) => {
  await page.goto("/private?asset=USDT");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();

  const trigger = page.locator("tr.product-row").filter({ hasText: "Binance Bahrain" }).first()
    .getByRole("button", { name: /查看变更记录/ });
  await trigger.hover();
  const popover = page.getByRole("dialog", { name: "产品变更记录" });
  await expect(popover).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(popover).toHaveCount(0);

  await trigger.click();
  await expect(popover).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(popover).toHaveCount(0);
});

test("clicking an open history bubble does not pin or toggle it", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/private?asset=USDT");
  const trigger = page.locator("tr.product-row").filter({ hasText: "Binance.com" }).first()
    .getByRole("button", { name: "查看变更记录" });
  await trigger.hover();
  const history = page.getByRole("dialog", { name: "产品变更记录" });
  await expect(history).toBeVisible();
  await trigger.click();
  await expect(history).toBeVisible();
  await trigger.click();
  await expect(history).toBeVisible();
  await page.mouse.move(10, 10);
  await expect(history).toHaveCount(0);

  const otherTrigger = page.locator("tr.product-row").filter({ hasText: "Binance Bahrain" }).first()
    .getByRole("button", { name: /查看变更记录/ });
  await trigger.click();
  await expect(history).toBeVisible();
  await otherTrigger.hover();
  await expect(history).toHaveCount(1);
  await expect.poll(() => page.getByRole("dialog", { name: "产品变更记录" }).count()).toBe(1);
  await expect(history).toBeVisible();
});

test("leaving one history bubble cancels its pending reopen before hovering another", async ({ page }) => {
  await page.goto("/private?asset=USDT");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();

  const firstTrigger = page.locator("tr.product-row").filter({ hasText: "Binance.com" }).filter({ hasText: "5.80%" }).first()
    .getByRole("button", { name: /查看变更记录/ });
  const secondTrigger = page.locator("tr.product-row").filter({ hasText: "Binance Bahrain" }).first()
    .getByRole("button", { name: /查看变更记录/ });
  const dialogs = page.getByRole("dialog", { name: "产品变更记录" });

  await firstTrigger.hover();
  await expect(dialogs).toHaveCount(1);
  await dialogs.hover();
  await firstTrigger.hover();
  await secondTrigger.hover();

  await expect.poll(() => dialogs.count()).toBe(1);
  await expect(firstTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(secondTrigger).toHaveAttribute("aria-expanded", "true");
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
  const emptyAlignment = await dialog.evaluate((popover) => {
    const state = popover.querySelector(".product-history-state");
    const empty = popover.querySelector(".product-history-empty");
    if (!state || !empty) throw new Error("History popover content missing");
    const stateRect = state.getBoundingClientRect();
    const emptyRect = empty.getBoundingClientRect();
    const headerRect = popover.querySelector(".product-history-header").getBoundingClientRect();
    return {
      stateHeight: stateRect.height,
      minimumHeight: Number.parseFloat(getComputedStyle(state).minHeight),
      centerOffset: Math.abs((stateRect.top + stateRect.height / 2) - (emptyRect.top + emptyRect.height / 2)),
      centerFromHeader: emptyRect.top + emptyRect.height / 2 - headerRect.bottom,
    };
  });
  expect(emptyAlignment.stateHeight).toBe(emptyAlignment.minimumHeight);
  expect(emptyAlignment.centerOffset).toBeCloseTo(2, 0);

  await dialog.getByText("暂无变更记录").click();
  await expect(dialog).toBeVisible();

  const singleEventRow = page.getByRole("row").filter({ hasText: "Bitget" }).filter({ hasText: "持仓 300.00" });
  await singleEventRow.getByRole("button", { name: /查看变更记录/ }).click();
  const singleEventDialog = page.getByRole("dialog", { name: "产品变更记录" });
  await expect(singleEventDialog.getByText("持仓变化")).toBeVisible();
  const singleEventCenterFromHeader = await singleEventDialog.evaluate((popover) => {
    const header = popover.querySelector(".product-history-header");
    const copy = popover.querySelector(".product-history-event-copy");
    if (!header || !copy) throw new Error("Single history event missing");
    const headerRect = header.getBoundingClientRect();
    const copyRect = copy.getBoundingClientRect();
    return copyRect.top + copyRect.height / 2 - headerRect.bottom;
  });
  expect(Math.abs(singleEventCenterFromHeader - emptyAlignment.centerFromHeader)).toBeLessThan(1);

  await singleEventDialog.locator(".product-history-event-copy").click();
  await expect(singleEventDialog).toBeVisible();
  await page.mouse.move(4, 4);
  await expect(singleEventDialog).toHaveCount(0);
});

test("history request starts during the hover-intent delay", async ({ page }) => {
  await page.goto("/private");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();
  const productRow = page.getByRole("row").filter({ hasText: "Bybit.com" }).filter({ hasText: "8.80%" });
  const hoverStartedAt = Date.now();
  await productRow.getByRole("button", { name: "查看变更记录" }).hover();

  const dialog = page.getByRole("dialog", { name: "产品变更记录" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".product-history-loading")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "加载失败，点击重试" })).toBeVisible();
  // The preview loader takes 450ms. If it were started only when the dialog
  // opened (after the 220ms hover delay), the error would arrive around 670ms.
  expect(Date.now() - hoverStartedAt).toBeLessThan(600);
});

test("three local Bybit USDT products separately preview history failure, pagination, and more-page failure", async ({ page }) => {
  await page.goto("/private");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();

  const initialFailureRow = page.getByRole("row").filter({ hasText: "Bybit.com" }).filter({ hasText: "8.80%" });
  await initialFailureRow.getByRole("button", { name: "查看变更记录" }).hover();
  const dialog = page.getByRole("dialog", { name: "产品变更记录" });
  await expect(dialog.locator(".product-history-loading")).toBeVisible();
  const loadingState = await dialog.locator(".product-history-state").boundingBox();
  expect(loadingState).not.toBeNull();

  const retry = dialog.getByRole("button", { name: "加载失败，点击重试" });
  await expect(retry).toBeVisible();
  const errorStyle = await retry.evaluate((button) => ({
    color: getComputedStyle(button).color,
    danger: getComputedStyle(document.documentElement).getPropertyValue("--danger-text").trim(),
    alignment: getComputedStyle(button).textAlign,
  }));
  const dangerRgb = errorStyle.danger.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  expect(dangerRgb).not.toBeNull();
  expect(errorStyle.color).toBe(`rgb(${parseInt(dangerRgb[1], 16)}, ${parseInt(dangerRgb[2], 16)}, ${parseInt(dangerRgb[3], 16)})`);
  expect(errorStyle.alignment).toBe("center");
  expect(await retry.evaluate((button) => getComputedStyle(button).marginTop)).toBe("4px");
  const errorAlignment = await dialog.evaluate((popover) => {
    const state = popover.querySelector(".product-history-state");
    const action = state?.querySelector(".product-history-state-action");
    if (!state || !action) throw new Error("Centered history error state missing");
    const stateRect = state.getBoundingClientRect();
    const actionRect = action.getBoundingClientRect();
    return {
      stateHeight: stateRect.height,
      centerOffset: Math.abs((stateRect.top + stateRect.height / 2) - (actionRect.top + actionRect.height / 2)),
    };
  });
  expect(errorAlignment.stateHeight).toBe(loadingState.height);
  expect(errorAlignment.centerOffset).toBeCloseTo(2, 0);
  await retry.click();
  const retryLoading = dialog.getByRole("button", { name: "加载中…" });
  await expect(retryLoading).toBeDisabled();
  expect(await retryLoading.evaluate((button) => button.classList.contains("product-history-error"))).toBe(false);
  expect(await retryLoading.evaluate((button) => button.classList.contains("product-history-loading-state"))).toBe(true);
  const loadingColor = await retryLoading.evaluate((button) => getComputedStyle(button).color);
  const dangerColor = await page.locator("html").evaluate((element) => {
    const value = getComputedStyle(element).getPropertyValue("--danger-text").trim();
    const rgb = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
    if (!rgb) throw new Error("Unexpected danger color token");
    return `rgb(${parseInt(rgb[1], 16)}, ${parseInt(rgb[2], 16)}, ${parseInt(rgb[3], 16)})`;
  });
  expect(loadingColor).not.toBe(dangerColor);
  await expect(dialog.locator(".product-history-loading")).toHaveCount(0);
  await expect(dialog.locator(".product-history-event")).toHaveCount(3);
  await expect(dialog.getByRole("button", { name: "加载更早记录" })).toHaveCount(0);

  // Keep each local fixture isolated: a hover bubble intentionally stays open
  // while the pointer is over its contents so its paging controls remain usable.
  await page.goto("/private");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();
  const paginationRow = page.getByRole("row").filter({ hasText: "Bybit.com" }).filter({ hasText: "6.00%" });
  await paginationRow.getByRole("button", { name: "查看变更记录" }).hover();
  const paginationDialog = page.getByRole("dialog", { name: "产品变更记录" });
  await expect(paginationDialog.locator(".product-history-loading")).toBeVisible();
  await expect(paginationDialog.locator(".product-history-event")).toHaveCount(3);
  const more = paginationDialog.getByRole("button", { name: "加载更早记录" });
  expect(await more.evaluate((button) => getComputedStyle(button).textAlign)).toBe("center");
  expect(await more.evaluate((button) => getComputedStyle(button).marginTop)).toBe("12px");
  await more.click();
  const paginationLoading = paginationDialog.getByRole("button", { name: "加载中…" });
  await expect(paginationLoading).toBeDisabled();
  await expect(paginationDialog.locator(".product-history-loading")).toHaveCount(0);
  await expect(paginationDialog.locator(".product-history-event")).toHaveCount(6);
  await paginationRow.getByRole("button", { name: "查看变更记录" }).hover();
  await expect(paginationDialog.locator(".product-history-loading")).toHaveCount(0);
  await expect(paginationDialog.locator(".product-history-event")).toHaveCount(6);

  await page.goto("/private");
  await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();
  const moreErrorRow = page.getByRole("row").filter({ hasText: "Bybit.com" }).filter({ hasText: "5.90%" });
  await moreErrorRow.getByRole("button", { name: "查看变更记录" }).hover();
  const moreErrorDialog = page.getByRole("dialog", { name: "产品变更记录" });
  await expect(moreErrorDialog.locator(".product-history-event")).toHaveCount(3);
  await moreErrorDialog.getByRole("button", { name: "加载更早记录" }).click();
  await expect(moreErrorDialog.getByRole("button", { name: "加载中…" })).toBeDisabled();
  await expect(moreErrorDialog.locator(".product-history-loading")).toHaveCount(0);
  await expect(moreErrorDialog.getByRole("button", { name: "加载失败，点击重试" })).toBeVisible();
  await expect(moreErrorDialog.locator(".product-history-event")).toHaveCount(3);
  await moreErrorDialog.getByRole("button", { name: "加载失败，点击重试" }).click();
  await expect(moreErrorDialog.getByRole("button", { name: "加载中…" })).toBeDisabled();
  await expect(moreErrorDialog.locator(".product-history-loading")).toHaveCount(0);
  await expect(moreErrorDialog.locator(".product-history-event")).toHaveCount(6);
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
  test(`settled signed-out page matches the ${viewport.name} visual baseline`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();
    await expect(page.getByText("以下均为演示数据。")).toBeVisible();
    await waitForVisualAssets(page);
    await expect(page).toHaveScreenshot(`public-settled-${viewport.name}.png`, {
      fullPage: true,
      animations: "disabled",
      caret: "hide",
    });
  });

  test(`settled private page and editing match the ${viewport.name} full-page baselines`, async ({ page }) => {
    await openFixedPrivatePreview(page, viewport);
    for (const asset of ["USDT", "USDC", "USDGO", "BTC"]) {
      if (asset !== "USDT") {
        await page.getByRole("button", { name: asset, exact: true }).first().click();
        await expect(page.getByRole("heading", { name: `${asset} 持仓` })).toBeVisible();
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await waitForVisualAssets(page);
      await expect(page).toHaveScreenshot(`private-settled-${asset.toLowerCase()}-${viewport.name}.png`, {
        fullPage: true, animations: "disabled", caret: "hide",
      });
    }

    await page.getByRole("button", { name: "USDT", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "USDT 持仓" })).toBeVisible();
    await page.getByRole("button", { name: "编辑持仓" }).click();
    await expect(page.getByRole("button", { name: "取消" }).first()).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page).toHaveScreenshot(`private-editing-${viewport.name}.png`, {
      fullPage: true, animations: "disabled", caret: "hide",
    });
  });

  test(`private empty and sync-status pages match the ${viewport.name} full-page baselines`, async ({ page }) => {
    for (const scenario of ["empty", "partial", "error", "syncing"]) {
      await page.clock.setFixedTime(new Date(visualPreviewAt));
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/private?previewAt=${encodeURIComponent(visualPreviewAt)}&syncScenario=${scenario}`);
      await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
      await waitForVisualAssets(page);
      await expect(page).toHaveScreenshot(`private-${scenario}-${viewport.name}.png`, {
        fullPage: true, animations: "disabled", caret: "hide",
      });
    }
  });

  test(`private settings and history match the ${viewport.name} visual baselines`, async ({ page }) => {
    await openFixedPrivatePreview(page, viewport);
    await page.locator(".action-menu-trigger").click();
    await page.getByRole("button", { name: "API 设置" }).click();
    const dialog = page.getByRole("dialog", { name: "API 设置" });
    await expect(dialog.locator(".api-connection-row")).toHaveCount(8);
    await waitForVisualAssets(page);
    await expect(page).toHaveScreenshot(`private-settings-top-${viewport.name}.png`, {
      animations: "disabled", caret: "hide",
    });
    await dialog.locator(".api-settings-body").evaluate((body) => { body.scrollTop = body.scrollHeight; });
    await expect(page).toHaveScreenshot(`private-settings-bottom-${viewport.name}.png`, {
      animations: "disabled", caret: "hide",
    });
    await dialog.getByRole("button", { name: "关闭" }).click();

    const historyRow = page.locator("tr.product-row").filter({ hasText: "Binance.com" }).first();
    await historyRow.getByRole("button", { name: "查看变更记录" }).click();
    await expect(page.getByRole("dialog", { name: "产品变更记录" })).toBeVisible();
    await expect(page).toHaveScreenshot(`private-history-${viewport.name}.png`, {
      animations: "disabled", caret: "hide",
    });
  });

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
      await waitForVisualAssets(page);
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
