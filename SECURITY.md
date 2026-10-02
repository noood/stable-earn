# Security Policy

## Reporting a vulnerability

请不要在公开 issue、讨论区或 pull request 中提交漏洞细节、API Key、Secret、Access 配置或个人数据。

请通过项目维护者提供的私下渠道报告，并尽量包含：

- 受影响的版本或提交；
- 可复现步骤；
- 影响范围；
- 不包含真实凭证的最小复现信息。

收到报告后，维护者会先确认问题、评估影响，再决定修复和公开说明的时间。

## Deployment responsibilities

部署者需要：

- 为 `/private/*` 配置 Cloudflare Access；
- 使用只读权限的交易所 API Key；
- 将 `CREDENTIAL_ENCRYPTION_KEY` 保存在 Worker Secret 中；
- 不把 `.env`、生产配置、D1 导出或日志中的个人数据提交到仓库。
