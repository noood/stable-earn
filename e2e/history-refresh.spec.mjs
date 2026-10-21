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

test("background history refresh fills multi-page gaps and preserves advancing older pagination", async ({ page }) => {
  const productId = "preview-apr-six";
  const at = (minute) => new Date(Date.UTC(2026, 9, 9) + minute * 60_000).toISOString();
  const makeEvent = (id, minute) => ({ ...event(productId, id, `分页记录 ${id}`), observedAt: at(minute), attention: false });
  let history = Array.from({ length: 9 }, (_, index) => makeEvent(`e${String(index + 1).padStart(3, "0")}`, index + 1));
  let loaderMocked = false;
  const cursors = [];
  await page.clock.install({ time: new Date(fixedTime) });
  // Replace only the local preview loader's network boundary. The real history
  // component still handles reconciliation, rendering and pagination.
  await page.route((url) => url.pathname.endsWith("/lib/product-history-preview.ts"), (route) => {
    loaderMocked = true;
    return route.fulfill({ contentType: "application/javascript", body: `
      export function createLocalProductHistoryPreviewLoader() {
        return async (productId, cursor) => {
          const params = new URLSearchParams({ preview: '1', productId });
          if (cursor !== null) params.set('cursor', cursor);
          const response = await fetch('/private/api/product-history?' + params);
          if (!response.ok) throw new Error('Local paged history failed');
          return response.json();
        };
      }
    ` });
  });
  await page.route("**/private/api/product-history**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET" || url.searchParams.get("preview") !== "1"
      || url.searchParams.get("productId") !== productId) {
      return route.fulfill({ status: 403, json: { error: "non-preview blocked" } });
    }
    const cursor = url.searchParams.get("cursor");
    cursors.push(cursor);
    const ordered = [...history].sort((left, right) => right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id));
    // Match the production keyset boundary rather than using shiftable offsets.
    const boundary = cursor === null ? null : JSON.parse(cursor);
    const remaining = ordered.filter((item) => !boundary || item.observedAt < boundary.observedAt
      || (item.observedAt === boundary.observedAt && item.id < boundary.id));
    const events = remaining.slice(0, 3);
    const last = events.at(-1);
    return route.fulfill({ status: 200, json: {
      events,
      nextCursor: remaining.length > events.length ? JSON.stringify({ observedAt: last.observedAt, id: last.id }) : null,
    } });
  });
  await page.route("**/private/api/products**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET" || new URL(request.url()).searchParams.get("preview") !== "1") {
      return route.fulfill({ status: 403, json: { error: "non-preview blocked" } });
    }
    const response = await route.fetch();
    const payload = await response.json();
    payload.changeEvents = [];
    payload.historySummaries = [{ productId, eventCount: history.length, unreadCount: 0 }];
    return route.fulfill({ response, json: payload });
  });
  await page.goto(`/private?previewAt=${encodeURIComponent(fixedTime)}`);
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  expect(loaderMocked).toBe(true);
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
  const row = page.locator("tr.product-row").filter({ hasText: "Bybit Global" })
    .filter({ has: page.locator(".product-rate-headline").filter({ hasText: "6.00%" }) });
  await row.locator(".product-history-trigger").click();
  const dialog = page.getByRole("dialog", { name: "产品变更记录" });
  await expect(dialog.locator(".product-history-event")).toHaveCount(3);
  await dialog.getByRole("button", { name: "加载更早记录" }).click();
  await expect(dialog.locator(".product-history-event")).toHaveCount(6);
  const deepCursor = JSON.stringify({ observedAt: at(4), id: "e004" });
  history = history.concat(Array.from({ length: 5 }, (_, index) => makeEvent(`e${String(index + 10).padStart(3, "0")}`, index + 10)),
    makeEvent("e006a", 6.5), makeEvent("e002a", 2.5));
  cursors.length = 0;
  await page.clock.runFor(61_000);
  await expect(dialog.locator(".product-history-event")).toHaveCount(12);
  await expect(dialog.getByText("分页记录 e006a", { exact: true })).toBeVisible();
  await expect(dialog.getByText("分页记录 e002a", { exact: true })).toHaveCount(0);
  expect(cursors.length).toBeGreaterThan(1);
  await dialog.getByRole("button", { name: "加载更早记录" }).click();
  await expect(dialog.locator(".product-history-event")).toHaveCount(15);
  expect(cursors.at(-1)).toBe(deepCursor);
  await dialog.getByRole("button", { name: "加载更早记录" }).click();
  await expect(dialog.locator(".product-history-event")).toHaveCount(16);
  await expect(dialog.getByRole("button", { name: "加载更早记录" })).toHaveCount(0);
  expect(await dialog.locator(".product-history-event-title > span:first-child").allTextContents())
    .toEqual([...history].sort((left, right) => right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id)).map((item) => item.title));
});
