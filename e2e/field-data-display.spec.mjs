import { expect, test } from "@playwright/test";

async function withProductFields(page, patch) {
  await page.route("**/private/api/products**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("preview") !== "1") return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    const product = payload.products.find((item) => item.id === "preview-apr-six");
    Object.assign(product, patch);
    await route.fulfill({ response, json: payload });
  });
  await page.goto("/private?previewAt=2026-10-06T10%3A00%3A00.000Z");
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  const headline = patch.rateCoverage === "unavailable" ? "APR 未获取" : "6.00%";
  return page.locator("tr.product-row").filter({ hasText: "Bybit Global" })
    .filter({ has: page.locator(".product-rate-headline").filter({ hasText: headline }) });
}

for (const width of [1280, 375]) {
  test(`missing APR keeps its known quota in view and edit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const row = await withProductFields(page, {
      rateCoverage: "unavailable", aprStatus: "unavailable", capacityStatus: "available",
      tierStructureStatus: "complete",
      tiers: [{ id: "preview-apr-six-tier-0", min: 0, max: 200, apr: 0 }],
    });
    await expect(row.locator(".product-rate-headline")).toContainText("申购额度 · 0.00–200.00");
    await expect(row.locator(".product-rate-headline")).toContainText("APR 未获取");
    await expect(row).not.toContainText("额度未获取");
    await expect(row.locator(".holding-summary")).toContainText("还可申购 200.00 USDT");
    await expect(row.locator("td").nth(3)).toHaveText("—");
    await page.getByRole("button", { name: "编辑持仓" }).click();
    await expect(row.locator(".product-rate-headline")).toContainText("申购额度 · 0.00–200.00");
    await expect(row).not.toContainText("0.00%");
    await expect(row.locator(".manual-fields:empty")).toHaveCount(0);
  });
}

test("unknown tier bounds do not claim an open range, while confirmed unlimited bounds do", async ({ page }) => {
  const row = await withProductFields(page, {
    rateCoverage: "partial", aprStatus: "available", capacityStatus: "unavailable",
    tiers: [{ id: "preview-apr-six-tier-0", min: 0, max: null, apr: 6 }],
  });
  await expect(row.locator(".product-rate-headline")).toContainText("申购额度 · 上限未获取");
  await expect(row.locator(".product-rate-headline")).toContainText("6.00%");
  await expect(row).not.toContainText("0.00 以上");
  await expect(row).not.toContainText("不限额");
  await expect(row.getByRole("progressbar")).toHaveCount(0);

  await page.unroute("**/private/api/products**");
  const unlimited = await withProductFields(page, {
    rateCoverage: "complete", aprStatus: "available", capacityStatus: "available",
    tierStructureStatus: "complete",
    tiers: [{ id: "preview-apr-six-tier-0", min: 0, max: null, maxStatus: "unlimited", apr: 6 }],
  });
  await expect(unlimited.locator(".product-rate-headline")).toContainText("申购额度 · 0.00 以上");
  await expect(unlimited).toContainText("申购额度不限额");
  await expect(unlimited).not.toContainText("额度未获取");
});
