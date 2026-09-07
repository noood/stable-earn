import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("Bybit EU shares the manual platform list without offering unsupported credentials", () => {
  const load = moduleLoader({ "cloudflare:workers": { env: {} } });
  const { credentialAccounts, credentialAccount, manualDataAccounts } = load("@/lib/credentials");
  const { accounts } = load("@/lib/seed-data");
  assert.deepEqual(Array.from(manualDataAccounts, (source) => source.id), ["bybit-eu", "mexc-ph", "mexc-uk"]);
  const eu = manualDataAccounts.find((source) => source.id === "bybit-eu");
  assert.match(eu.syncDescription, /USDT 产品利率自动获取/);
  assert.match(eu.syncDescription, /持仓.*手动维护/);
  assert.equal(credentialAccount("bybit-eu"), null);
  const sources = [...credentialAccounts, ...manualDataAccounts];
  assert.equal(new Set(sources.map((source) => source.id)).size, sources.length);
  assert.ok(sources.every((source) => accounts.some((account) => account.id === source.id)));
});
