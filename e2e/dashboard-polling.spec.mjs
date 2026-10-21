import { expect, test } from "@playwright/test";

async function openPollingPreview(page) {
  await page.clock.install({ time: new Date("2026-10-21T03:00:00Z") });
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    window.setPollingTestVisibility = (nextHidden) => {
      hidden = nextHidden;
      document.dispatchEvent(new Event("visibilitychange"));
    };
    window.pollingTestCompletedProducts = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== "/private/api/products") return response;
      const originalJson = response.json.bind(response);
      response.json = async () => {
        try {
          return await originalJson();
        } finally {
          // Observe the task after parsing, not just the outgoing request or
          // network finish. The app's await/finally microtasks clear its in-flight
          // guard before this real browser task runs, even with paused fake time.
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            window.pollingTestCompletedProducts++;
            channel.port1.close();
            channel.port2.close();
          };
          channel.port2.postMessage(null);
        }
      };
      return response;
    };
  });
  const requests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/private/api/products") requests.push(request.method());
  });
  await page.goto("/private");
  await expect(page.getByRole("table")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: "编辑持仓", exact: true })).toBeEnabled();
  await waitForCompletedProducts(page, 1);
  const current = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(current + 1000));
  expect(requests).toEqual(["GET"]);
  return requests;
}

async function waitForCompletedProducts(page, count) {
  await expect.poll(() => page.evaluate(() => window.pollingTestCompletedProducts)).toBe(count);
}

test("background polling pauses and an overdue foreground return reads once, then waits a minute", async ({ page }) => {
  const requests = await openPollingPreview(page);
  await page.evaluate(() => window.setPollingTestVisibility(true));
  await page.clock.runFor(180_000);
  expect(requests).toEqual(["GET"]);
  await page.evaluate(() => window.setPollingTestVisibility(false));
  await expect.poll(() => requests.length).toBe(2);
  await waitForCompletedProducts(page, 2);
  await page.evaluate(() => window.setPollingTestVisibility(false));
  await page.clock.runFor(59_999);
  expect(requests).toEqual(["GET", "GET"]);
  await page.clock.runFor(1);
  await expect.poll(() => requests.length).toBe(3);
  await waitForCompletedProducts(page, 3);
  expect(requests).toEqual(["GET", "GET", "GET"]);
});

test("editing remains paused through a hidden/visible transition and resumes without queued catch-up bursts", async ({ page }) => {
  const requests = await openPollingPreview(page);
  await page.getByRole("button", { name: "编辑持仓", exact: true }).click();
  await page.evaluate(() => window.setPollingTestVisibility(true));
  await page.clock.runFor(180_000);
  await page.evaluate(() => window.setPollingTestVisibility(false));
  await page.clock.runFor(60_000);
  expect(requests).toEqual(["GET"]);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.clock.runFor(1);
  await expect.poll(() => requests.length).toBe(2);
  await waitForCompletedProducts(page, 2);
  await page.clock.runFor(59_000);
  expect(requests).toEqual(["GET", "GET"]);
});
