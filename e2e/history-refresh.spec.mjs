import { expect, test } from "@playwright/test";

const fixedTime = "2026-10-10T10:00:00.000Z";
const event = (productId, id, title) => ({
  id, productId, type: "rate", title, before: "8.00%", after: "5.00%",
  observedAt: fixedTime, source: "手动刷新", attention: true,
});

async function previewSnapshotFixture(page, productId, initialEvents = []) {
  let fixture;
  let refreshedEvents = initialEvents;
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.route("**/private/api/products**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Test only the local preview: never forward a mutation to a real account.
    if (url.searchParams.get("preview") !== "1") return route.fulfill({ status: 403, json: { error: "non-preview blocked" } });
    if (request.method() === "GET") {
      const response = await route.fetch();
      fixture = await response.json();
      fixture.changeEvents = fixture.changeEvents.filter((item) => item.productId !== productId).concat(initialEvents);
      fixture.cache.cooldownUntil = null;
      return route.fulfill({ response, json: fixture });
    }
    expect(request.method()).toBe("POST");
    const payload = structuredClone(fixture);
    payload.changeEvents = payload.changeEvents.filter((item) => item.productId !== productId).concat(refreshedEvents);
    payload.cache.cooldownUntil = null;
    return route.fulfill({ status: 200, json: payload });
  });
  await page.goto(`/private?previewAt=${encodeURIComponent(fixedTime)}`);
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  return {
    refresh: async (nextEvents) => {
      refreshedEvents = nextEvents;
      await page.locator(".action-menu-trigger").click();
      await page.locator(".action-menu-popover").getByRole("button", { name: "手动刷新", exact: true }).click();
      await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
    },
  };
}

test("same-page refresh shows new history without losing loaded older pages or clearing it before confirmation", async ({ page }) => {
  const productId = "preview-apr-six";
  const fixture = await previewSnapshotFixture(page, productId);
  const row = page.locator("tr.product-row").filter({ hasText: "Bybit Global" })
    .filter({ has: page.locator(".product-rate-headline").filter({ hasText: "6.00%" }) });
  const trigger = row.locator(".product-history-trigger");
  const dialog = page.getByRole("dialog", { name: "产品变更记录" });
  await trigger.click();
  await expect(dialog.locator(".product-history-event")).toHaveCount(3);
  await dialog.getByRole("button", { name: "加载更早记录" }).click();
  await expect(dialog.locator(".product-history-event")).toHaveCount(6);
  await page.getByRole("heading", { name: "USDT 持仓" }).click();
  await expect(dialog).toHaveCount(0);

  await fixture.refresh([event(productId, "new-after-refresh", "刷新后的首档 APR 下调")]);
  await expect(trigger).toHaveAccessibleName("查看变更记录，有需要关注的变化");
  await trigger.click();
  await expect(dialog.getByText("刷新后的首档 APR 下调")).toBeVisible();
  await expect(dialog.locator(".product-history-event")).toHaveCount(7);
  // Latest first-page confirmation is still pending at this point.
  await expect(trigger).toHaveAccessibleName("查看变更记录，有需要关注的变化");
  await expect(trigger).toHaveAccessibleName("查看变更记录");
  await expect(dialog.locator(".product-history-event")).toHaveCount(7);
});

test("a failed latest history read leaves unread attention visible until a successful retry", async ({ page }) => {
  const productId = "by-g-usdt-short-fixed";
  await previewSnapshotFixture(page, productId, [event(productId, `local-${productId}-history-1`, "尚未确认的降息记录")]);
  const row = page.locator("tr.product-row").filter({ hasText: "Bybit Global" }).filter({ hasText: "8.80%" });
  const trigger = row.locator(".product-history-trigger");
  const dialog = page.getByRole("dialog", { name: "产品变更记录" });
  await trigger.click();
  await expect(dialog.getByRole("button", { name: "加载失败，点击重试" })).toBeVisible();
  await expect(trigger).toHaveAccessibleName("查看变更记录，有需要关注的变化");
  await dialog.getByRole("button", { name: "加载失败，点击重试" }).click();
  await expect(trigger).toHaveAccessibleName("查看变更记录，有需要关注的变化");
  await expect(dialog.locator(".product-history-event")).toHaveCount(3);
  await expect(trigger).toHaveAccessibleName("查看变更记录");
});
