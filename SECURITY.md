# Security Policy

## Reporting a vulnerability

请不要在公开 issue、讨论区或 pull request 中提交漏洞细节、API Key、Secret、Access 配置或个人数据。

截至 2026-10-03，只读检查确认 `noood/stable-earn` 尚未启用 GitHub 私下漏洞报告，且仓库所有者公开资料没有列出电子邮箱或网站。维护者公开征集报告前，应先启用该功能或在此补充经过确认的私下联系方式。当前本文件尚未提供可直接提交漏洞细节的私下渠道；请勿在公开 issue、讨论区或 pull request 中披露漏洞细节。报告时尽量包含：

- 受影响的版本或提交；
- 可复现步骤；
- 影响范围；
- 不包含真实凭证的最小复现信息。

收到报告后，维护者会先确认问题、评估影响，再决定修复和公开说明的时间。

安全审计发现的依赖告警应记录受影响包、依赖路径、运行时是否可达和处置决定。暂缓修复不代表漏洞已解决；后续发布前需重新审计并复核风险。

## Deployment responsibilities

部署者需要：

- 为 `/private/*` 配置 Cloudflare Access；
- 使用只读权限的交易所 API Key；
- 将 `CREDENTIAL_ENCRYPTION_KEY` 保存在 Worker Secret 中；
- 不把 `.env`、生产配置、D1 导出或日志中的个人数据提交到仓库。
