import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("account, credential and manual-source labels use the same display definition", () => {
  const load = moduleLoader({ "cloudflare:workers": { env: {} } });
  const { accountDisplayNames } = load("@/lib/platform-display");
  const { accounts } = load("@/lib/seed-data");
  const { credentialAccounts, manualDataAccounts } = load("@/lib/credentials");

  assert.deepEqual(accounts.map(({ id }) => id), Object.keys(accountDisplayNames));
  for (const account of accounts) assert.equal(account.name, accountDisplayNames[account.id]);
  for (const account of [...credentialAccounts, ...manualDataAccounts]) {
    assert.equal(account.label, accountDisplayNames[account.id]);
  }
  assert.equal(credentialAccounts.length, 5);
  assert.deepEqual(manualDataAccounts.map(({ id }) => id), ["bybit-eu", "mexc-ph", "mexc-uk"]);
});

test("capability labels only combine the two known MEXC markets, not account identity", () => {
  const load = moduleLoader();
  const { accountDisplayNames, capabilityPlatformName } = load("@/lib/platform-display");
  for (const [id, label] of Object.entries(accountDisplayNames)) {
    assert.equal(capabilityPlatformName(id), id === "mexc-ph" || id === "mexc-uk" ? "MEXC" : label);
  }
  assert.notEqual(accountDisplayNames["mexc-ph"], accountDisplayNames["mexc-uk"]);
  assert.equal(capabilityPlatformName("mexc-future"), "mexc-future");
  assert.equal(capabilityPlatformName("unknown-account"), "unknown-account");
});
