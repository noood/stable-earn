import { expect, test } from "@playwright/test";

test("production loopback requests cannot enable private preview data or bypass authentication", async ({ request }) => {
  for (const path of ["products", "holdings", "wallet", "credentials"]) {
    const response = await request.get(`/private/api/${path}?preview=1&syncScenario=success`);
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: expect.any(String) });
  }
});
