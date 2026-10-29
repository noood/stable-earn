import { expect, test } from "@playwright/test";

// All addresses, balances and rates below are synthetic local test fixtures.
const productId = "preview-bgw-morph-usdc";
const address = "0x1111111111111111111111111111111111111111";
const previewAt = "2026-10-06T10:00:00.000Z";
const sourceAt = "2026-10-05T04:34:00.000Z";
const identityKey = "bitget-wallet-morph:2818:0x9131eb40bd0bdce73c72755f1bb2cf39a9453341";
const referenceApr = 6.73;

function bgwProduct(patch = {}) {
  return {
    id: productId,
    accountId: "bitget-wallet-morph",
    exchange: "bitget-wallet",
    region: "morph",
    asset: "USDC",
    name: "Gauntlet USDC",
    holdingDataMode: "api",
    productDataMode: "manual",
    productType: "flexible",
    productTypeStatus: "known",
    rateCoverage: "unavailable",
    aprStatus: "unavailable",
    capacityStatus: "available",
    tierStructureStatus: "complete",
    tiers: [{ id: `${productId}-tier-0`, min: 0, max: null, maxStatus: "unlimited", apr: 0 }],
    source: { kind: "manual", label: "手动填写整体 APR" },
    externalProductId: "2818:0x9131eb40bd0bdce73c72755f1bb2cf39a9453341",
    identityKey,
    ...patch,
  };
}

async function installLocalBgwPreview(page, { product = bgwProduct(), manualApr = 6.73, cached = false, holdingAmount = () => 123.45, onlyWallet = false, beforeProductFulfill } = {}) {
  const requests = { products: 0, holdings: 0, productMethods: [], saves: [], failNextSave: false };
  let storedOverride = { apr: manualApr, firstTierLimit: null, termDays: null, purchaseDate: null, updatedAt: sourceAt };
  await page.route("**/private/api/products**", async (route) => {
    const url = new URL(route.request().url());
    if (!["GET", "POST"].includes(route.request().method()) || url.searchParams.get("preview") !== "1") {
      return route.fulfill({ status: 403, json: { error: "BGW E2E allows local preview reads only" } });
    }
    // A UI refresh POST receives another GET-only local fixture; the browser
    // never forwards a mutation or asks an upstream provider for real data.
    const fixtureUrl = new URL(url);
    fixtureUrl.searchParams.delete("visit");
    fixtureUrl.searchParams.delete("refresh");
    const response = await route.fetch({ method: "GET", url: fixtureUrl.toString() });
    const payload = await response.json();
    if (onlyWallet) {
      payload.products = [];
      payload.holdingUpdates = {};
      payload.holdingSourceIds = [];
      payload.holdingSyncStates = {};
      payload.holdingFallbacks = {};
      payload.failures = [];
      payload.partial = false;
    }
    payload.products.push(product);
    payload.holdingUpdates[productId] = holdingAmount();
    payload.holdingSourceIds.push(productId);
    payload.holdingSyncStates[productId] = cached ? "error" : "synced";
    if (cached) {
      payload.holdingFallbacks[productId] = sourceAt;
      payload.failures = [...(payload.failures ?? []), "Bitget Wallet / Morph 持仓"];
      payload.partial = true;
    }
    if (beforeProductFulfill) await beforeProductFulfill(payload, route.request());
    await route.fulfill({ response, json: payload });
    requests.products += 1;
    requests.productMethods.push(route.request().method());
  });
  await page.route("**/private/api/holdings**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("preview") !== "1") {
      return route.fulfill({ status: 403, json: { error: "BGW E2E only allows local preview" } });
    }
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      requests.saves.push(body);
      if (requests.failNextSave) {
        requests.failNextSave = false;
        return route.fulfill({ status: 503, json: { error: "synthetic save failure" } });
      }
      expect(body.holdings).toEqual({});
      expect(body.changedHoldingProductIds).toEqual([]);
      expect(body.changedOverrideProductIds).toEqual([productId]);
      storedOverride = { ...body.overrides[productId], updatedAt: previewAt };
      return route.fulfill({ json: { saved: 0, manualUpdated: 1, updatedAt: previewAt, preview: true } });
    }
    if (route.request().method() !== "GET") return route.fulfill({ status: 403 });
    const response = await route.fetch();
    const payload = await response.json();
    if (onlyWallet) { payload.holdings = {}; payload.overrides = {}; }
    payload.holdings[productId] = holdingAmount();
    payload.overrides[productId] = storedOverride;
    await route.fulfill({ response, json: payload });
    requests.holdings += 1;
  });
  await page.clock.setFixedTime(new Date(previewAt));
  return requests;
}

async function openBgwPreview(page) {
  await page.goto(`/private?asset=USDC&previewAt=${encodeURIComponent(previewAt)}`);
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  const row = page.locator("tr.product-row").filter({ hasText: "Bitget Wallet" });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".holding-summary")).toContainText("持仓 123.45");
  return row;
}

for (const width of [1280, 375]) {
  test(`BGW manual APR computes existing holdings using the shared unlimited tier at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installLocalBgwPreview(page);
    const row = await openBgwPreview(page);
    await expect(row.locator("td").first().locator(".type-body.font-semibold")).toHaveText("Bitget Wallet");
    await expect(row.locator("td").first()).toContainText("活期理财");
    await expect(row.locator("td").first()).not.toContainText("Morph");
    await expect(row.locator("td").first()).not.toContainText("Gauntlet");
    await expect(row.locator(".product-rate-headline")).toContainText("不限额");
    await expect(row.locator(".product-rate-headline")).toContainText("6.73%");
    await expect(row).toContainText("手动填写");
    await expect(row).not.toContainText("Dune");
    await expect(row).toContainText(/10\/05.*12:34/);
    await expect(row).not.toContainText("申购额度未获取");
    await expect(row).not.toContainText("含奖励的整体 APR，按日复利折算预估收益。");
    await expect(row.locator(".product-meta-danger").filter({ hasText: "额度" })).toHaveCount(0);
    await expect(row).not.toContainText("不参与收益计算");
    await expect(row.locator(".holding-summary")).toContainText("持仓 123.45 / 不限额");
    await expect(row.getByRole("progressbar")).toHaveCount(0);
    await expect(row.locator("td").nth(3)).toHaveText(`${referenceApr.toFixed(2)}%`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page).toHaveScreenshot(`bgw-reference-${width}.png`, { fullPage: true, animations: "disabled" });

    await expect(row.getByRole("button", { name: "APR说明", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "编辑持仓" }).click();
    await expect(row.locator(".holding-editor-readonly")).toContainText("123.45");
    await expect(row.getByRole("textbox", { name: "USDC 产品持仓" })).toHaveCount(0);
    await expect(row.getByRole("textbox", { name: "APY", exact: true })).toHaveCount(0);
    await expect(row.getByRole("textbox", { name: "APR", exact: true })).toHaveValue("6.73");
    await expect(row.locator(".product-rate-headline").getByRole("button")).toHaveCount(0);
    const info = row.locator(".manual-field-label").getByRole("button", { name: "APR说明", exact: true });
    await expect(info).toHaveCount(1);
    await expect(row).not.toContainText("填写 BGW 显示的整体 APR");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page).toHaveScreenshot(`bgw-manual-edit-${width}.png`, { fullPage: true, animations: "disabled" });
    if (width === 375) {
      await row.getByRole("textbox", { name: "APR", exact: true }).scrollIntoViewIfNeeded();
      await expect(row.locator("td").nth(1)).toHaveScreenshot("bgw-manual-field-375.png", { animations: "disabled" });
    }
    await expect(row.getByRole("textbox", { name: "首档额度", exact: true })).toHaveCount(0);
    await expect(info).toBeVisible();
    await info.click();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("整体 APR 包含基础收益和奖励利率");
    await expect(tooltip).toContainText("奖励每 8 小时结算一次，赎回时空投到钱包余额");
    await expect(tooltip).toHaveScreenshot(`bgw-apr-info-${width}.png`, { animations: "disabled" });
    await info.press("Escape");
    await expect(tooltip).toHaveCount(0);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(row.getByRole("button", { name: "APR说明", exact: true })).toHaveCount(0);
  });
}

test("BGW direct APR is consistent in the row, portfolio and daily estimate", async ({ page }) => {
  await installLocalBgwPreview(page, { manualApr: 6.72, holdingAmount: () => 10000, onlyWallet: true });
  await page.goto(`/private?asset=USDC&previewAt=${encodeURIComponent(previewAt)}`);
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  const row = page.locator("tr.product-row").filter({ hasText: "Bitget Wallet" });
  await expect(row.locator("td").nth(3)).toHaveText("6.72%");
  const metric = (label) => page.locator(".metric-item").filter({ has: page.getByText(label, { exact: true }) }).locator(".metric-value");
  await expect(metric("总持仓 · USDC")).toHaveText("10,000.00");
  await expect(metric("组合有效 APR")).toHaveText("6.72%");
  await expect(metric("预计每日收益 · USDC")).toHaveText("1.84");
  await expect(metric("最佳首档 APR")).toHaveText("6.72%");
  await expect(metric("高息剩余额度")).toHaveText("不限");
  await expect(page.locator(".metrics-panel")).not.toContainText("APY");
});

test("missing BGW APR keeps its known current holding and hides calculated yield", async ({ page }) => {
  await installLocalBgwPreview(page, {
    manualApr: null,
  });
  const row = await openBgwPreview(page);
  await expect(row.locator(".product-rate-headline")).toContainText("APR 待填写");
  await expect(row.locator("td").nth(3)).toHaveText("—");
  await expect(row).not.toContainText("0.00%");
  await expect(row).toContainText("持仓 123.45");
});

test("failed RPC refresh retains the independent manual APR across page reloads", async ({ page }) => {
  await installLocalBgwPreview(page, {
    cached: true,
  });
  const row = await openBgwPreview(page);
  const aprSourceNote = row.locator(".product-meta").filter({ hasText: "手动填写" });
  await expect(aprSourceNote).toContainText(/10\/05.*12:34/);
  const originalNote = await aprSourceNote.innerText();
  await expect(row.locator("td").nth(3)).toHaveText(`${referenceApr.toFixed(2)}%`);
  await page.reload();
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  await expect(aprSourceNote).toHaveText(originalNote);
  await expect(row).toContainText("持仓 123.45");
  await expect(row.locator(".product-meta").filter({ hasText: /APR.*沿用/ })).toHaveCount(0);
  await expect(row).toContainText("持仓沿用");
});

test("manual APR supports cancel, save, refresh persistence, zero and clearing without editing RPC holdings", async ({ page }) => {
  const requests = await installLocalBgwPreview(page, { manualApr: null });
  const row = await openBgwPreview(page);
  const headline = row.locator(".product-rate-headline");
  await page.getByRole("button", { name: "编辑持仓", exact: true }).click();
  await row.getByRole("textbox", { name: "APR", exact: true }).fill("6.72");
  await expect(row.locator("td").nth(3)).toHaveText("6.72%");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(headline).toContainText("APR 待填写");
  expect(requests.saves).toHaveLength(0);

  async function saveApr(value, expected) {
    await page.getByRole("button", { name: "编辑持仓", exact: true }).click();
    await row.getByRole("textbox", { name: "APR", exact: true }).fill(value);
    await page.getByRole("button", { name: "保存持仓", exact: true }).click();
    await expect(page.getByRole("button", { name: "编辑持仓", exact: true })).toBeVisible();
    await expect(headline).toContainText(expected);
    await expect(row.locator(".holding-summary")).toContainText("持仓 123.45");
  }
  await saveApr("6.72", "6.72%");
  expect(requests.saves.at(-1).overrides[productId].apr).toBe(6.72);
  await page.reload();
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  await expect(headline).toContainText("6.72%");
  await expect(row).toContainText("手动填写");
  await expect(row).not.toContainText("Dune");
  await saveApr("0", "0.00%");
  await expect(row.locator("td").nth(3)).toHaveText("0.00%");
  await saveApr("", "APR 待填写");
  await expect(row.locator("td").nth(3)).toHaveText("—");
  expect(requests.saves.at(-1).overrides[productId].apr).toBeNull();
});

test("failed manual APR save keeps the draft for retry and cancel restores the saved value", async ({ page }) => {
  const requests = await installLocalBgwPreview(page);
  const row = await openBgwPreview(page);
  await page.getByRole("button", { name: "编辑持仓", exact: true }).click();
  await row.getByRole("textbox", { name: "APR", exact: true }).fill("7.25");
  requests.failNextSave = true;
  await page.getByRole("button", { name: "保存持仓", exact: true }).click();
  await expect(page.locator(".table-error-panel")).toContainText("保存失败");
  await expect(row.getByRole("textbox", { name: "APR", exact: true })).toHaveValue("7.25");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(row.locator(".product-rate-headline")).toContainText("6.73%");
  await expect(row.locator(".holding-summary")).toContainText("持仓 123.45");
});

test("the actual local BGW preview supports manual APR editing without mocked product responses", async ({ page }) => {
  await page.goto("/private?asset=USDC&syncScenario=bgw");
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  const row = page.locator("tr.product-row").filter({ hasText: "Bitget Wallet" });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".holding-summary")).toContainText("持仓 123.45");
  await expect(row.locator(".product-rate-headline")).toContainText("APR 待填写");
  await page.getByRole("button", { name: "编辑持仓", exact: true }).click();
  await row.getByRole("textbox", { name: "APR", exact: true }).fill("6.72");
  await page.getByRole("button", { name: "保存持仓", exact: true }).click();
  await expect(page.getByRole("button", { name: "编辑持仓", exact: true })).toBeVisible();
  await expect(row.locator(".product-rate-headline")).toContainText("6.72%");
  const manualNote = row.locator(".product-meta").filter({ hasText: "手动填写" });
  const savedNote = await manualNote.innerText();
  await page.reload();
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  await expect(row.locator(".product-rate-headline")).toContainText("6.72%");
  await expect(manualNote).toHaveText(savedNote);
  await expect(row.locator(".holding-summary")).toContainText("持仓 123.45");
});

test("wallet settings validate the address, save locally and confirm removal before rereading holdings", async ({ page }) => {
  const reads = await installLocalBgwPreview(page);
  let storedAddress = null;
  const mutations = [];
  let walletReads = 0;
  await page.route("**/private/api/wallet", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      walletReads += 1;
      return route.fulfill({ json: { address: storedAddress } });
    }
    if (request.method() === "PUT") {
      const body = request.postDataJSON();
      mutations.push({ method: "PUT", body });
      storedAddress = body.address;
      return route.fulfill({ json: { address: storedAddress } });
    }
    if (request.method() === "DELETE") {
      mutations.push({ method: "DELETE" });
      storedAddress = null;
      return route.fulfill({ json: { address: null } });
    }
    return route.fulfill({ status: 405, json: { error: "Unexpected wallet operation" } });
  });
  await page.route("**/private/api/credentials", (route) => route.fulfill({ json: { sources: [], manualSources: [] } }));
  await page.route("**/private/api/preferences", (route) => route.fulfill({ json: { manualRefreshCooldownMinutes: 30 } }));
  await openBgwPreview(page);
  await page.locator(".action-menu-trigger").click();
  await page.getByRole("button", { name: "数据源设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "数据源设置" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "钱包地址", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  const input = dialog.getByRole("textbox", { name: "钱包地址" });
  const save = dialog.getByRole("button", { name: "保存", exact: true });
  await input.fill("0x123");
  await expect(save).toBeDisabled();
  await expect(dialog).toContainText("40 位十六进制字符");
  await input.press("Enter");
  expect(mutations).toEqual([]);
  await input.fill(address);
  await expect(save).toBeEnabled();
  const beforeSaveReads = reads.holdings;
  await save.click();
  await expect(dialog).toContainText("钱包地址已保存");
  await expect.poll(() => reads.holdings).toBeGreaterThan(beforeSaveReads);
  expect(mutations).toEqual([{ method: "PUT", body: { address } }]);
  await expect(dialog.getByLabel("Bitget Wallet 更多操作")).toHaveAttribute("aria-disabled", "false");
  await expect(dialog).not.toContainText(address);
  expect(walletReads).toBeGreaterThanOrEqual(1);

  await dialog.getByLabel("Bitget Wallet 更多操作").click();
  await dialog.getByRole("button", { name: "移除钱包", exact: true }).click();
  let confirmation = page.getByRole("dialog", { name: "移除钱包地址", exact: true });
  await expect(confirmation).toBeVisible();
  expect(mutations).toHaveLength(1);
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(mutations).toHaveLength(1);

  await dialog.getByLabel("Bitget Wallet 更多操作").click();
  await dialog.getByRole("button", { name: "移除钱包", exact: true }).click();
  confirmation = page.getByRole("dialog", { name: "移除钱包地址", exact: true });
  const beforeRemoveReads = reads.holdings;
  await confirmation.getByRole("button", { name: "确认移除钱包", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(dialog).toContainText("钱包地址已移除");
  await expect.poll(() => reads.holdings).toBeGreaterThan(beforeRemoveReads);
  expect(mutations).toEqual([{ method: "PUT", body: { address } }, { method: "DELETE" }]);
  await expect(dialog.getByRole("button", { name: "添加", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "添加", exact: true })).toBeEnabled();
});

for (const width of [1280, 375]) {
  test(`wallet settings reuse the source row and keep a public-address save at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installLocalBgwPreview(page);
    await page.route("**/private/api/wallet", (route) => route.fulfill({ json: { address: null } }));
    await page.route("**/private/api/credentials", (route) => route.fulfill({ json: {
      sources: [{ id: "bitget-global", label: "Bitget", configured: false, requiresPassphrase: true, syncDescription: "产品、APR 与持仓自动同步" }], manualSources: [],
    } }));
    await page.route("**/private/api/preferences", (route) => route.fulfill({ json: { manualRefreshCooldownMinutes: 30 } }));
    await openBgwPreview(page);
    await page.locator(".action-menu-trigger").click();
    await page.getByRole("button", { name: "数据源设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "数据源设置", exact: true });
    const walletRow = dialog.locator(".api-connection-row").filter({ hasText: "Bitget Wallet" });
    await expect(walletRow.locator(".account-badge")).toHaveText("BW");
    await expect(walletRow.getByText("Morph 链", { exact: true })).toBeVisible();
    await expect(walletRow.getByText("Morph 链", { exact: true })).toHaveCSS("margin-top", "4px");
    await expect(walletRow).not.toContainText("整体 APR");
    await expect(dialog).not.toContainText("无需私钥");
    await expect(dialog).toHaveScreenshot(`bgw-wallet-settings-${width}.png`, { animations: "disabled" });
    await walletRow.getByRole("button", { name: "添加", exact: true }).click();
    const input = walletRow.getByRole("textbox", { name: "钱包地址", exact: true });
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    await expect(walletRow.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await expect(walletRow).not.toContainText("加密保存");
    await expect(walletRow).not.toContainText("填写持有该理财");
    await expect(walletRow).toHaveScreenshot(`bgw-wallet-editor-${width}.png`, { animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test(`configured source menus stay clickable outside their cards at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installLocalBgwPreview(page);
    await page.route("**/private/api/wallet", (route) => route.fulfill({ json: { address } }));
    await page.route("**/private/api/credentials", (route) => route.fulfill({ json: {
      sources: [{ id: "bitget-global", label: "Bitget", configured: true, requiresPassphrase: true, syncDescription: "产品、APR 与持仓自动同步" }], manualSources: [],
    } }));
    await page.route("**/private/api/preferences", (route) => route.fulfill({ json: { manualRefreshCooldownMinutes: 30 } }));
    await openBgwPreview(page);
    await page.locator(".action-menu-trigger").click();
    await page.getByRole("button", { name: "数据源设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "数据源设置", exact: true });
    const walletRow = dialog.locator(".api-connection-row").filter({ hasText: "Bitget Wallet" });
    await expect(walletRow.getByText("已配置", { exact: true })).toBeVisible();
    await expect(walletRow).not.toContainText(address);

    await dialog.getByLabel("Bitget 更多操作", { exact: true }).click();
    await dialog.getByRole("button", { name: "移除 API 配置", exact: true }).click();
    const apiRemoval = page.getByRole("dialog", { name: "移除 API 配置及产品", exact: true });
    await expect(apiRemoval).toBeVisible();
    await apiRemoval.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.getByLabel("Bitget 更多操作", { exact: true }).click();
    await dialog.getByRole("button", { name: "更新 API 配置", exact: true }).click();
    await expect(dialog.getByLabel("API Key", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();

    await dialog.getByLabel("Bitget Wallet 更多操作", { exact: true }).click();
    await expect(dialog).toHaveScreenshot(`bgw-configured-source-menu-${width}.png`, { animations: "disabled" });
    await dialog.getByRole("button", { name: "移除钱包", exact: true }).click();
    const walletRemoval = page.getByRole("dialog", { name: "移除钱包地址", exact: true });
    await expect(walletRemoval).toBeVisible();
    await walletRemoval.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.getByLabel("Bitget Wallet 更多操作", { exact: true }).click();
    await dialog.getByRole("button", { name: "修改钱包", exact: true }).click();
    await expect(walletRow.getByRole("textbox", { name: "钱包地址", exact: true })).toHaveValue(address);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("a delayed settings read cannot restore the previous wallet after a save", async ({ page }) => {
  await installLocalBgwPreview(page);
  const replacementAddress = "0x2222222222222222222222222222222222222222";
  let storedAddress = address;
  let reads = 0;
  let delayedReadFinished = false;
  let releaseOldRead;
  const oldReadGate = new Promise((resolve) => { releaseOldRead = resolve; });
  await page.route("**/private/api/wallet", async (route) => {
    if (route.request().method() === "GET") {
      const snapshot = storedAddress;
      reads += 1;
      if (reads === 2) {
        await oldReadGate;
        await route.fulfill({ json: { address: snapshot } });
        delayedReadFinished = true;
        return;
      }
      return route.fulfill({ json: { address: snapshot } });
    }
    expect(route.request().method()).toBe("PUT");
    storedAddress = route.request().postDataJSON().address;
    return route.fulfill({ json: { address: storedAddress } });
  });
  await page.route("**/private/api/credentials", (route) => route.fulfill({ json: { sources: [], manualSources: [] } }));
  await page.route("**/private/api/preferences", (route) => route.fulfill({ json: { manualRefreshCooldownMinutes: 30 } }));
  await openBgwPreview(page);
  async function openSettings() {
    await page.locator(".action-menu-trigger").click();
    await page.getByRole("button", { name: "数据源设置", exact: true }).click();
  }
  const dialog = page.getByRole("dialog", { name: "数据源设置", exact: true });
  await openSettings();
  await expect(dialog.getByLabel("Bitget Wallet 更多操作")).toBeVisible();
  await expect(dialog).not.toContainText(address);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await openSettings();
  await expect.poll(() => reads).toBe(2);
  await dialog.getByLabel("Bitget Wallet 更多操作").click();
  await dialog.getByRole("button", { name: "修改钱包", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "钱包地址", exact: true })).toHaveValue(address);
  await dialog.getByRole("textbox", { name: "钱包地址", exact: true }).fill(replacementAddress);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByLabel("Bitget Wallet 更多操作")).toHaveAttribute("aria-disabled", "false");
  await expect(dialog.getByRole("textbox", { name: "钱包地址", exact: true })).toHaveCount(0);
  const oldResponse = page.waitForResponse((response) => response.url().endsWith("/private/api/wallet") && response.request().method() === "GET");
  releaseOldRead();
  await (await oldResponse).finished();
  await expect.poll(() => delayedReadFinished).toBe(true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // A response captured before the save must not restore its old address.
  await expect(dialog).not.toContainText(address);
  await dialog.getByLabel("Bitget Wallet 更多操作").click();
  await dialog.getByRole("button", { name: "修改钱包", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "钱包地址", exact: true })).toHaveValue(replacementAddress);
});

test("an old cache response cannot overwrite a replacement wallet or cancel its pending daily refresh", async ({ page }) => {
  await page.clock.install({ time: new Date(previewAt) });
  let walletChanged = false;
  let delayNextCache = false;
  let oldCacheCaptured = false;
  let dailyRequests = 0;
  let releaseOldCache;
  const oldCacheGate = new Promise((resolve) => { releaseOldCache = resolve; });
  const reads = await installLocalBgwPreview(page, {
    holdingAmount: () => walletChanged ? 789.12 : 123.45,
    beforeProductFulfill: async (payload, request) => {
      if (request.method() === "GET" && delayNextCache) {
        delayNextCache = false;
        oldCacheCaptured = true;
        // A response begun under the old configuration carries both the old
        // holding and its old "already done today" marker.
        payload.dailyRefresh = { day: "2026-10-06", completed: true };
        await oldCacheGate;
      } else if (walletChanged && request.method() === "POST") {
        dailyRequests += 1;
        payload.dailyRefreshPending = dailyRequests === 1;
        payload.dailyRefresh = { day: "2026-10-06", completed: dailyRequests > 1 };
        payload.cache.state = dailyRequests === 1 ? "syncing" : "fresh";
      } else if (walletChanged) {
        payload.dailyRefresh = { day: "2026-10-06", completed: false };
      }
    },
  });
  const replacementAddress = "0x2222222222222222222222222222222222222222";
  await page.route("**/private/api/wallet", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { address: walletChanged ? replacementAddress : address } });
    expect(route.request().method()).toBe("PUT");
    expect(route.request().postDataJSON()).toEqual({ address: replacementAddress });
    walletChanged = true;
    return route.fulfill({ json: { address: replacementAddress } });
  });
  await page.route("**/private/api/credentials", (route) => route.fulfill({ json: { sources: [], manualSources: [] } }));
  await page.route("**/private/api/preferences", (route) => route.fulfill({ json: { manualRefreshCooldownMinutes: 30 } }));
  const row = await openBgwPreview(page);
  await expect(page.getByRole("button", { name: "编辑持仓", exact: true })).toBeEnabled();
  await expect.poll(() => reads.products).toBe(1);
  const currentTime = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(currentTime + 1000));

  // Start the next ordinary cache poll and retain its full old payload.
  delayNextCache = true;
  await page.clock.runFor(60_000);
  await expect.poll(() => oldCacheCaptured).toBe(true);
  await page.locator(".action-menu-trigger").click();
  await page.getByRole("button", { name: "数据源设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "数据源设置" });
  await dialog.getByLabel("Bitget Wallet 更多操作").click();
  await dialog.getByRole("button", { name: "修改钱包", exact: true }).click();
  await dialog.getByRole("textbox", { name: "钱包地址" }).fill(replacementAddress);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByLabel("Bitget Wallet 更多操作")).toHaveAttribute("aria-disabled", "false");
  await expect.poll(() => dailyRequests).toBe(1);
  await expect(row.locator(".holding-summary")).toContainText("持仓 789.12");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const finishedBeforeRelease = reads.products;
  releaseOldCache();
  await expect.poll(() => reads.products).toBe(finishedBeforeRelease + 1);
  await page.clock.runFor(1);
  await expect(row.locator(".holding-summary")).toContainText("持仓 789.12");

  // The pending daily attempt must remain pending. Clearing it from the stale
  // response would turn this follow-up into a GET and fail the POST assertion.
  await page.clock.runFor(60_001);
  await expect.poll(() => dailyRequests).toBe(2);
  await expect.poll(() => reads.productMethods.at(-1)).toBe("POST");
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  await expect(row.locator(".holding-summary")).toContainText("持仓 789.12");
});
