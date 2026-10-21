import { expect, test } from "@playwright/test";

test("production serves complete known third-party notices as a static resource", async ({ request }) => {
  const response = await request.get("/third-party-notices.txt");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/plain");
  const body = await response.text();
  for (const notice of [
    "react@19.3.1", "Meta Platforms, Inc. and affiliates", "@unpic/core@1.0.3",
    "Yuxi (Evan) You and Vite contributors", "Cloudflare, Inc.", "whitequark",
    "Faisal Salman", "Scott Motte", "Geist and Geist Mono", "SIL OPEN FONT LICENSE Version 1.1",
    "OTHER DEALINGS IN THE FONT SOFTWARE.", "unpic@4.2.2",
    "complete upstream copyright notice remains unconfirmed",
  ]) expect(body).toContain(notice);
  // Only client packages are exposed here. Server-only licenses stay in the server artifact.
  expect(body).not.toContain("jose@6.2.12");
});
