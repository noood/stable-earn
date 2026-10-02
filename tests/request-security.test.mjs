import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("development auth bypass is restricted to loopback origins", () => {
  const { isLocalDevelopmentRequest } = moduleLoader()("@/lib/request-security");
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    assert.equal(isLocalDevelopmentRequest(new Request("http://localhost:3000/private/api/session")), true);
    assert.equal(isLocalDevelopmentRequest(new Request("http://127.0.0.1:8787/private/api/session")), true);
    assert.equal(isLocalDevelopmentRequest(new Request("https://stable.example/private/api/session")), false);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("development auth bypass is disabled outside development", () => {
  const { isLocalDevelopmentRequest } = moduleLoader()("@/lib/request-security");
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.equal(isLocalDevelopmentRequest(new Request("http://localhost:3000/private/api/session")), false);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
