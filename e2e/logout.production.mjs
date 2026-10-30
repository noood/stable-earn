import { expect, test } from "@playwright/test";

test("production logout uses a same-origin request and blocks cross-site or GET logout", async ({ page, request }) => {
  // Account requests are synthetic failures; this test never reads production data.
  await page.route("**/private/api/**", (route) => route.fulfill({
    status: 403, json: { error: "Synthetic account requests are blocked" },
  }));
  await page.goto("/private");
  await page.locator(".action-menu-trigger").click();
  const requestPromise = page.waitForRequest((request) => new URL(request.url()).pathname === "/logout"
    && request.method() === "POST");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  const submitted = await requestPromise;
  expect((await submitted.allHeaders()).origin).toBe("http://127.0.0.1:3001");
  await expect(page).toHaveURL("http://127.0.0.1:3001/");
  const accepted = await request.post("/logout", { headers: { origin: "http://127.0.0.1:3001" }, maxRedirects: 0 });
  expect(accepted.status()).toBe(303);
  expect(accepted.headers()["set-cookie"]).toContain("CF_Authorization=");
  const blocked = await request.post("/logout", { headers: { origin: "https://external.example" } });
  expect(blocked.status()).toBe(403);
  expect(blocked.headers()["set-cookie"]).toBeUndefined();
  const legacy = await request.get("/logout");
  expect(legacy.status()).toBe(405);
  expect(legacy.headers()["set-cookie"]).toBeUndefined();
});
