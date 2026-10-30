import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function loadLogoutRoute() {
  const load = moduleLoader({
    "next/server": {
      NextResponse: {
        json: (body, init) => Response.json(body, init),
        redirect: (url, status) => {
          const response = new Response(null, { status, headers: { location: String(url) } });
          response.cookies = {
            set({ name, value, expires, httpOnly, path, sameSite, secure }) {
              const attributes = [
                `${name}=${value}`,
                `Expires=${expires.toUTCString()}`,
                `Path=${path}`,
                ...(httpOnly ? ["HttpOnly"] : []),
                ...(secure ? ["Secure"] : []),
                `SameSite=${sameSite}`,
              ];
              response.headers.append("Set-Cookie", attributes.join("; "));
            },
          };
          return response;
        },
      },
    },
  });
  return load("@/app/logout/route");
}

test("same-origin POST clears the Access cookie and redirects to the public page", async () => {
  const route = loadLogoutRoute();
  const response = route.POST(new Request("https://stable.example/logout", {
    method: "POST",
    headers: { origin: "https://stable.example" },
  }));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://stable.example/");
  assert.match(response.headers.get("set-cookie") ?? "", /^CF_Authorization=;/);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("Origin:null is rejected even when Fetch Metadata says same-origin", async () => {
  const route = loadLogoutRoute();
  const response = route.POST(new Request("https://stable.example/logout", {
    method: "POST",
    headers: { origin: "null", "sec-fetch-site": "same-origin" },
  }));

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("cross-site, same-site, or missing request-origin evidence is rejected without clearing cookies", async () => {
  const route = loadLogoutRoute();
  const rejectedHeaders = [
    { origin: "https://attacker.example" },
    { origin: "null", "sec-fetch-site": "cross-site" },
    { origin: "null", "sec-fetch-site": "same-site" },
    { origin: "null" },
    { origin: "null", "sec-fetch-site": "none" },
    {},
  ];
  for (const headers of rejectedHeaders) {
    const response = route.POST(new Request("https://stable.example/logout", { method: "POST", headers }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal((await response.json()).error, "请求来源无效。");
  }
});

test("legacy GET does not clear cookies and asks the user to refresh", async () => {
  const route = loadLogoutRoute();
  const response = route.GET(new Request("https://stable.example/logout"));

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.match((await response.json()).error, /刷新后/);
});
