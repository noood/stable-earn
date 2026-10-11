import assert from "node:assert/strict";
import test from "node:test";
import { formatAuditSummary, getAuditPolicy } from "../scripts/audit-security-policy.mjs";

test("development dependency findings are reported but do not fail the audit", () => {
  const policy = getAuditPolicy({ code: 1 }, { code: 0 });

  assert.deepEqual(policy, {
    fullStatus: "warning",
    productionStatus: "pass",
    exitCode: 0,
  });
  const summary = formatAuditSummary(policy);
  assert.match(summary, /全部依赖（含开发依赖）.*否（仅提示）/);
  assert.match(summary, /生产依赖.*未发现问题/);
});

test("production dependency findings fail the audit even when the full audit passes", () => {
  const policy = getAuditPolicy({ code: 0 }, { code: 1 });

  assert.deepEqual(policy, {
    fullStatus: "pass",
    productionStatus: "fail",
    exitCode: 1,
  });
  const summary = formatAuditSummary(policy);
  assert.match(summary, /生产依赖.*有问题.*\| 是/);
});

test("both audit scopes retain independent statuses", () => {
  const policy = getAuditPolicy({ code: 1 }, { code: 1 });

  assert.deepEqual(policy, {
    fullStatus: "warning",
    productionStatus: "fail",
    exitCode: 1,
  });
  const summary = formatAuditSummary(policy);
  assert.match(summary, /全部依赖（含开发依赖）.*仅提示/);
  assert.match(summary, /生产依赖.*有问题或审计错误.*\| 是/);
});
