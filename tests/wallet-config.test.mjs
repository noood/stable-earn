import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const firstAddress = `0x${"1".repeat(40)}`;
const secondAddress = `0x${"a".repeat(40)}`;

function fixture() {
  const db = sqliteDb();
  let userId = "alice";
  const load = moduleLoader({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/db": { getDatabase: async () => db, getUserIdentity: async () => userId ? { userId } : null },
  });
  return { db, load, route: load("@/app/private/api/wallet/route"), user: (value) => { userId = value; } };
}

function request(method, body, origin = "https://test") {
  return new Request("https://test/private/api/wallet", {
    method,
    headers: { origin, "content-type": "application/json" },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

test("wallet address parsing accepts full public addresses and rejects malformed/secret-like inputs", () => {
  const { normalizeWalletAddress } = moduleLoader()("@/lib/wallet-address");
  assert.equal(normalizeWalletAddress(` 0x${"Ab".repeat(20)} `), `0x${"ab".repeat(20)}`);
  for (const invalid of [null, undefined, 42, {}, [], "", "0x", "0x" + "0".repeat(40), "0x" + "1".repeat(39),
    "0x" + "1".repeat(41), "0x" + "g".repeat(40), "0x" + "1".repeat(64), "seed phrase words", firstAddress + "junk"]) {
    assert.equal(normalizeWalletAddress(invalid), null);
  }
});

test("wallet route requires identity and same-origin mutations, with private read responses", async () => {
  const f = fixture();
  f.user(null);
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await f.route[method](request(method, method === "PUT" ? { address: firstAddress } : undefined))).status, 401);
  f.user("alice");
  assert.equal((await f.route.PUT(request("PUT", { address: firstAddress }, "https://elsewhere"))).status, 403);
  assert.equal((await f.route.DELETE(request("DELETE", undefined, "https://elsewhere"))).status, 403);
  const empty = await f.route.GET(request("GET"));
  assert.equal(empty.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await empty.json(), { address: null });
  for (const invalid of ["{", "null", "[]", "{}", JSON.stringify({ address: firstAddress + "x" })]) {
    assert.equal((await f.route.PUT(request("PUT", invalid))).status, 400);
  }
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM wallet_configs").get().n, 0);
});

test("each user can save/read/delete only their own wallet", async () => {
  const f = fixture();
  assert.equal((await f.route.PUT(request("PUT", { address: firstAddress }))).status, 200);
  assert.deepEqual(await (await f.route.GET(request("GET"))).json(), { address: firstAddress });
  f.user("bob");
  assert.deepEqual(await (await f.route.GET(request("GET"))).json(), { address: null });
  assert.equal((await f.route.PUT(request("PUT", { address: secondAddress }))).status, 200);
  await f.route.DELETE(request("DELETE"));
  assert.deepEqual(await (await f.route.GET(request("GET"))).json(), { address: null });
  f.user("alice");
  assert.deepEqual(await (await f.route.GET(request("GET"))).json(), { address: firstAddress });
});

function insertProduct(f, owner, id, account) {
  const now = "2026-10-29T00:00:00.000Z";
  const payload = JSON.stringify({ id, accountId: account, productDataMode: "api", holdingDataMode: "api" });
  f.db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id,product_id,canonical_product_id,identity_key,payload,status,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,'active',?,?)`).run(owner, id, id, id, payload, now, now);
  f.db.sqlite.prepare("INSERT INTO holdings VALUES (?,?,100,?)").run(owner, id, now);
  f.db.sqlite.prepare("INSERT INTO holding_positions VALUES (?,?,?,100,NULL,NULL,'api',?)").run(owner, id, "position", now);
}

test("replacing a wallet clears its old balances atomically while retaining other users/accounts and history", async () => {
  const f = fixture();
  await f.route.PUT(request("PUT", { address: firstAddress }));
  insertProduct(f, "alice", "wallet-product", "bitget-wallet-morph");
  insertProduct(f, "alice", "exchange-product", "bitget-global");
  insertProduct(f, "bob", "wallet-product", "bitget-wallet-morph");
  f.db.sqlite.prepare("INSERT INTO sync_snapshots (owner_id,cache_key,payload) VALUES ('alice','private-products','{}')").run();
  f.db.sqlite.prepare("UPDATE refresh_control SET daily_day='2026-10-29' WHERE user_id='alice'").run();
  f.db.sqlite.prepare(`INSERT INTO product_change_events
    (owner_id,event_id,product_id,change_type,title,observed_at,source) VALUES ('alice','history','wallet-product','holding','持仓变化','2026-10-29T00:00:00.000Z','每日首次打开')`).run();
  assert.equal((await f.route.PUT(request("PUT", { address: secondAddress }))).status, 200);
  assert.equal(f.db.sqlite.prepare("SELECT * FROM holdings WHERE user_id='alice' AND product_id='wallet-product'").get(), undefined);
  assert.equal(f.db.sqlite.prepare("SELECT * FROM holding_positions WHERE user_id='alice' AND product_id='wallet-product'").get(), undefined);
  assert.equal(f.db.sqlite.prepare("SELECT status FROM product_catalog WHERE owner_id='alice' AND product_id='wallet-product'").get().status, "archived");
  assert.equal(f.db.sqlite.prepare("SELECT amount FROM holdings WHERE user_id='alice' AND product_id='exchange-product'").get().amount, 100);
  assert.equal(f.db.sqlite.prepare("SELECT amount FROM holdings WHERE user_id='bob' AND product_id='wallet-product'").get().amount, 100);
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_change_events").get().n, 1);
  assert.equal(f.db.sqlite.prepare("SELECT * FROM sync_snapshots WHERE owner_id='alice'").get(), undefined);
  assert.equal(f.db.sqlite.prepare("SELECT daily_day FROM refresh_control WHERE user_id='alice'").get().daily_day, null);
});

test("saving the unchanged wallet preserves cached balances; changing it revokes a pending sync lease", async () => {
  const f = fixture();
  await f.route.PUT(request("PUT", { address: firstAddress }));
  insertProduct(f, "alice", "wallet-product", "bitget-wallet-morph");
  await f.route.PUT(request("PUT", { address: firstAddress }));
  assert.equal(f.db.sqlite.prepare("SELECT amount FROM holdings WHERE user_id='alice'").get().amount, 100);
  const control = f.load("@/lib/refresh-control");
  const oldToken = await control.acquireRefresh(f.db, "alice");
  assert.ok(oldToken);
  await f.route.PUT(request("PUT", { address: secondAddress }));
  assert.equal(await control.renewRefresh(f.db, "alice", oldToken), false);
  await assert.rejects(f.db.batch([
    control.prepareRefreshCommitGuard(f.db, "alice", oldToken),
    f.db.prepare("INSERT INTO holdings VALUES ('alice','wallet-product',999,'later')").bind(),
  ]), /malformed JSON/);
  assert.equal(f.db.sqlite.prepare("SELECT * FROM holdings WHERE user_id='alice'").get(), undefined);
});

test("a second configuration mutation receives conflict and deletion cannot apply with a revoked token", async () => {
  const f = fixture();
  await f.route.PUT(request("PUT", { address: firstAddress }));
  const control = f.load("@/lib/refresh-control");
  const token = await control.supersedeRefreshForCredentialChange(f.db, "alice");
  assert.ok(token);
  assert.equal((await f.route.PUT(request("PUT", { address: secondAddress }))).status, 409);
  assert.equal((await f.route.DELETE(request("DELETE"))).status, 409);
  await control.releaseRefresh(f.db, "alice", token);
  await assert.rejects(f.load("@/lib/wallet-config").deleteWalletConfig(f.db, "alice", token), /malformed JSON/);
  assert.equal((await f.load("@/lib/wallet-config").loadWalletConfig(f.db, "alice")).address, firstAddress);
});

test("ordered wallet migration is idempotent and enforces normalized public addresses", () => {
  const sqlite = new DatabaseSync(":memory:");
  const migration = readFileSync(new URL("../drizzle/0022_wallet_configs.sql", import.meta.url), "utf8");
  sqlite.exec(migration);
  sqlite.exec(migration);
  sqlite.prepare("INSERT INTO wallet_configs VALUES (?,?,?)").run("alice", firstAddress, "now");
  for (const invalid of ["0x" + "z".repeat(40), "0x" + "a".repeat(41), "0x" + "0".repeat(40), "0x" + "A".repeat(40)]) {
    assert.throws(() => sqlite.prepare("INSERT INTO wallet_configs VALUES (?,?,?)").run("bob", invalid, "now"), /CHECK constraint failed/);
  }
  sqlite.close();
});
