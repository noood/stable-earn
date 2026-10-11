import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { formatAuditSummary, getAuditPolicy } from "./audit-security-policy.mjs";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("请通过 npm run audit:security 运行此检查。");
  process.exit(1);
}

function runAudit(label, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => resolve({ label, args, code: 1, stdout, stderr: [...stderr, Buffer.from(error.message)] }));
    child.on("close", (code) => resolve({ label, args, code: code ?? 1, stdout, stderr }));
  });
}

const results = await Promise.all([
  runAudit("完整依赖审计", ["audit"]),
  runAudit("生产依赖审计", ["audit", "--omit=dev"]),
]);

for (const result of results) {
  const blocking = result.label === "生产依赖审计";
  const status = result.code === 0
    ? "通过"
    : blocking
      ? `失败，退出码 ${result.code}（阻断）`
      : `有告警或审计错误，退出码 ${result.code}（不阻断）`;
  process.stdout.write(`\n=== ${result.label} · ${status} ===\n`);
  process.stdout.write(Buffer.concat(result.stdout));
  process.stderr.write(Buffer.concat(result.stderr));
}

const policy = getAuditPolicy(results[0], results[1]);
if (results[0].code !== 0 && results[1].code === 0) {
  process.stderr.write("\n注意：完整依赖审计有告警或审计错误，但生产依赖审计通过，因此不阻断本次检查。\n");
}
if (results[1].code !== 0) {
  process.stderr.write("\n错误：生产依赖审计未通过，本次检查将以失败结束。\n");
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  try {
    await appendFile(summaryPath, formatAuditSummary(policy), "utf8");
  } catch {
    process.stderr.write("注意：无法写入 GitHub Actions 摘要；审计结果仍可在运行日志中查看。\n");
  }
}

if (policy.exitCode !== 0) process.exitCode = policy.exitCode;
