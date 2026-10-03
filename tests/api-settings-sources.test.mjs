import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("Bybit EU exposes separate read-only diagnostic credentials while its products remain manual", () => {
  const load = moduleLoader({ "cloudflare:workers": { env: {} } });
  const { credentialAccounts, credentialAccount, manualDataAccounts } = load("@/lib/credentials");
  const { accounts } = load("@/lib/seed-data");
  assert.deepEqual(Array.from(manualDataAccounts, (source) => source.id), ["mexc-ph", "mexc-uk"]);
  const eu = credentialAccount("bybit-eu");
  assert.equal(eu.requiresPassphrase, false);
  assert.match(eu.syncDescription, /只读 API 检查/);
  assert.match(eu.syncDescription, /不会进入日常同步/);
  const sources = [...credentialAccounts, ...manualDataAccounts];
  assert.equal(new Set(sources.map((source) => source.id)).size, sources.length);
  assert.ok(sources.every((source) => accounts.some((account) => account.id === source.id)));
});
