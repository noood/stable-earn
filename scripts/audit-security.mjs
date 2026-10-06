import { spawn } from "node:child_process";

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
  process.stdout.write(`\n=== ${result.label} · ${result.code === 0 ? "通过" : `退出码 ${result.code}`} ===\n`);
  process.stdout.write(Buffer.concat(result.stdout));
  process.stderr.write(Buffer.concat(result.stderr));
}

if (results.some((result) => result.code !== 0)) process.exitCode = 1;
