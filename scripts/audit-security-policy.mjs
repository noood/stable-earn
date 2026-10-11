export function getAuditPolicy(fullAudit, productionAudit) {
  return {
    fullStatus: fullAudit.code === 0 ? "pass" : "warning",
    productionStatus: productionAudit.code === 0 ? "pass" : "fail",
    exitCode: productionAudit.code === 0 ? 0 : 1,
  };
}

export function formatAuditSummary(policy) {
  const fullResult = policy.fullStatus === "pass"
    ? "✅ 未发现问题"
    : "⚠️ 有告警或审计错误（详情见运行日志）";
  const productionResult = policy.productionStatus === "pass"
    ? "✅ 未发现问题"
    : "❌ 有问题或审计错误（详情见运行日志）";

  return [
    "## 依赖安全审计",
    "",
    "| 范围 | 结果 | 是否阻挡合并 |",
    "| --- | --- | --- |",
    `| 全部依赖（含开发依赖） | ${fullResult} | 否（仅提示） |`,
    `| 生产依赖 | ${productionResult} | 是 |`,
    "",
    "完整依赖审计用于展示所有依赖告警；只有生产依赖审计失败会让此检查返回失败。",
    "",
  ].join("\n");
}
