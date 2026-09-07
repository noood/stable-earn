import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function fixture(fetch) {
  const logs = [];
  const load = moduleLoader({}, {
    fetch, console: { info: (record) => logs.push(record), warn: (record) => logs.push(record) },
    setTimeout: (callback) => { callback(); return 1; },
  });
  return { logs, ...load("@/lib/sync-diagnostics"), ...load("@/lib/exchange-fetch") };
}

test("HTTP and API codes remain distinct, without logging signed queries or response data", async () => {
  const f = fixture(async () => Response.json({ code: -1021, msg: "SECRET-BODY", balance: 987654321 }));
  await f.withSyncDiagnostics("cloudflare:secret@example.test", { trigger: "scheduled", attempt: 3, runId: "run-a" }, () =>
    f.withSyncPlatform("binance-global", async () => {
      const response = await f.exchangeFetch("https://api-gcp.binance.com/sapi/v1/simple-earn/flexible/list?asset=USDT&signature=SECRET-SIGN&timestamp=123456789", { headers: { "X-MBX-APIKEY": "SECRET-KEY" } });
      await f.readExchangeJson(response);
    }));
  assert.equal(f.logs[0].httpStatus, 200);
  assert.equal(f.logs[0].endpoint, "/sapi/v1/simple-earn/flexible/list");
  assert.equal(f.logs[0].asset, "USDT");
  assert.equal(f.logs[1].apiCode, "-1021");
  assert.equal(f.logs[0].requestId, f.logs[1].requestId);
  assert.ok(f.logs.every((r) => r.trigger === "scheduled" && r.attempt === 3 && r.platform === "binance-global"));
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET|secret@example|987654321|123456789|signature/);
});

test("HTTP retry keeps its two statuses and does not add any new requests", async () => {
  let calls = 0;
  const f = fixture(async () => new Response("{}", { status: ++calls === 1 ? 429 : 200 }));
  await f.withSyncDiagnostics("user", { trigger: "manual", attempt: 1 }, async () => {
    const response = await f.exchangeFetch("https://api.bitget.com/api/v2/public/time");
    assert.equal(response.status, 200);
  });
  assert.equal(calls, 2);
  assert.deepEqual(f.logs.map((r) => r.httpStatus), [429, 200]);
  assert.deepEqual(f.logs.map((r) => r.requestAttempt), [1, 2]);
});

test("timeouts and network failures are classified without exposing exception messages", async () => {
  for (const [error, expected] of [[new DOMException("SECRET", "AbortError"), "timeout_or_abort"], [new TypeError("SECRET"), "network_or_type_error"]]) {
    const f = fixture(async () => { throw error; });
    await assert.rejects(f.withSyncDiagnostics("user", { trigger: "manual", attempt: 1 }, () => f.exchangeFetch("https://api.bitget.com/api/v2/public/time")), (e) => e === error);
    assert.equal(f.logs[0].outcome, expected);
    assert.doesNotMatch(JSON.stringify(f.logs), /SECRET/);
  }
});

test("HTML/non-JSON bodies are classified without logging body text", async () => {
  const f = fixture(async () => new Response("<html>SECRET-BODY</html>", { status: 403 }));
  await f.withSyncDiagnostics("user", { trigger: "manual", attempt: 1 }, async () => {
    await assert.rejects(f.readExchangeJson(await f.exchangeFetch("https://api.bitget.com/api/v2/public/time")));
  });
  assert.equal(f.logs[0].httpStatus, 403);
  assert.equal(f.logs[1].event, "exchange_body_error");
  assert.equal(f.logs[1].errorKind, "invalid_json");
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET/);
});

test("parallel users and platforms keep isolated contexts; user references survive retries", async () => {
  const f = fixture(async () => { await Promise.resolve(); return Response.json({ code: "00000" }); });
  const run = (user, platform, runId, attempt) => f.withSyncDiagnostics(user, { trigger: "scheduled", attempt, runId }, () => f.withSyncPlatform(platform, async () => {
    await Promise.resolve();
    await f.exchangeFetch("https://api.bitget.com/api/v2/public/time");
  }));
  await Promise.all([run("first@example.test", "binance-global", "one", 1), run("second@example.test", "bitget-global", "two", 1)]);
  await run("first@example.test", "binance-global", "one", 2);
  const one = f.logs.filter((r) => r.runId === "one");
  const two = f.logs.find((r) => r.runId === "two");
  assert.equal(one.length, 2);
  assert.equal(one[0].userRef, one[1].userRef);
  assert.notEqual(one[0].userRef, two.userRef);
  assert.ok(one.every((r) => r.platform === "binance-global"));
  assert.equal(two.platform, "bitget-global");
  assert.doesNotMatch(JSON.stringify(f.logs), /@example/);
});

test("text body read failures retain the request context without exposing body errors", async () => {
  const response = new Response("unused");
  response.text = async () => { throw new TypeError("SECRET-BODY-ERROR"); };
  const f = fixture(async () => response);
  await f.withSyncDiagnostics("user", { trigger: "scheduled", attempt: 2 }, () =>
    f.withSyncPlatform("bitget-global", async () => {
      await assert.rejects(f.readExchangeText(await f.exchangeFetch("https://api.bitget.com/api/v2/earn/savings/assets")));
    }));
  const error = f.logs.at(-1);
  assert.equal(error.event, "exchange_body_error");
  assert.equal(error.requestId, f.logs[0].requestId);
  assert.equal(error.platform, "bitget-global");
  assert.equal(error.errorKind, "network_or_type_error");
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET/);
});

test("unknown destinations and non-numeric API codes are redacted", async () => {
  const f = fixture(async () => Response.json({ code: "SECRET-CODE" }));
  await f.withSyncDiagnostics("user", { trigger: "initial", attempt: 1 }, async () => {
    await f.readExchangeJson(await f.exchangeFetch("https://secret-host.example/secret-path?coin=SECRET-ASSET"));
  });
  assert.equal(f.logs[0].host, "custom_host");
  assert.equal(f.logs[0].endpoint, "other_endpoint");
  assert.equal(f.logs[1].apiCode, "non_numeric");
  assert.doesNotMatch(JSON.stringify(f.logs), /secret|SECRET/);
});

test("runtime subrequest exhaustion is explicit, not inferred from a generic zero-duration error", async () => {
  for (const [message, expected] of [["Too many subrequests. SECRET", "subrequest_limit_exceeded"], ["unrelated SECRET", "error"]]) {
    const f = fixture(async () => { throw Error(message); });
    await assert.rejects(f.withSyncDiagnostics("user", { trigger: "scheduled", attempt: 3 }, () => f.exchangeFetch("https://api.bitget.com/api/v2/public/time")));
    assert.equal(f.logs[0].outcome, expected);
    assert.doesNotMatch(JSON.stringify(f.logs), /SECRET/);
  }
});

test("access denial reasons use response evidence and never emit response text", async () => {
  for (const [status, body, reason] of [
    [451, JSON.stringify({ code: 0, msg: "Service unavailable from a restricted location SECRET" }), "region_restricted"],
    [403, "<html>The distribution is configured to block access from your country SECRET</html>", "region_restricted"],
    [403, JSON.stringify({ retMsg: "access too frequent SECRET" }), "rate_limited"],
    [403, JSON.stringify({ msg: "Unmatched IP SECRET" }), "ip_not_allowed"],
    [403, "<html>Forbidden SECRET</html>", "access_denied_unknown"],
    [451, "<html>Forbidden SECRET</html>", "access_denied_unknown"],
  ]) {
    const f = fixture(async () => new Response(body, { status }));
    await f.withSyncDiagnostics("user", { trigger: "manual", attempt: 1 }, async () => {
      try { await f.readExchangeJson(await f.exchangeFetch("https://api.bybit.com/v5/earn/product")); } catch { /* HTML is still rejected. */ }
    });
    assert.equal(f.logs.at(-1).accessReason, reason);
    assert.doesNotMatch(JSON.stringify(f.logs), /SECRET|<html>|restricted location/);
  }
});

test("Bitget text responses share reason classification; only validated trace headers are logged", async () => {
  const f = fixture(async () => new Response("<html>access too frequent SECRET</html>", { status: 403, headers: {
    "content-type": "text/html", "cf-ray": "a370cf99ab6188cc-HKG", "x-request-id": "SECRET", "set-cookie": "SECRET",
  } }));
  await f.withSyncDiagnostics("user", { trigger: "manual", attempt: 1 }, async () => {
    const response = await f.exchangeFetch("https://api.bitget.com/api/v2/earn/savings/assets");
    f.logExchangePayload(response, null, await f.readExchangeText(response));
  });
  assert.equal(f.logs[0]["cf-ray"], "a370cf99ab6188cc-HKG");
  assert.equal(f.logs[0].responseType, "html");
  assert.equal(f.logs.at(-1).accessReason, "rate_limited");
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET|set-cookie|x-request-id/);
});
