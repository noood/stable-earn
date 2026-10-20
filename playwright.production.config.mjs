import { defineConfig } from "@playwright/test";

// Exercise the real production bundle with entirely intercepted account APIs.
// Build first; this server never receives credentials or accesses production D1.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.production.mjs",
  outputDir: "./test-results/production",
  workers: 1,
  reporter: "list",
  timeout: 20_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:3001", browserName: "chromium", headless: true,
    screenshot: "only-on-failure", trace: "retain-on-failure", viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: "npx wrangler dev --config dist/server/wrangler.json --local --ip 127.0.0.1 --port 3001 --inspector-port 0 --persist-to .wrangler/production-e2e",
    url: "http://127.0.0.1:3001/private", reuseExistingServer: false, timeout: 120_000,
  },
});
