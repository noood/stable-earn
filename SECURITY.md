# Security Policy

## Reporting a vulnerability

仓库已启用 GitHub 私下漏洞报告。请通过 **Security → Report a vulnerability** 私下提交，不要在公开 issue、讨论区或 pull request 中披露漏洞细节、API Key、Secret、Access 配置或个人数据。报告时尽量包含：

- 受影响的版本或提交；
- 可复现步骤；
- 影响范围；
- 不包含真实凭证的最小复现信息。

收到报告后，维护者会先确认问题、评估影响，再决定修复和公开说明的时间。

安全审计发现的依赖告警应记录受影响包、依赖路径、运行时是否可达和处置决定。暂缓修复不代表漏洞已解决；后续发布前需重新审计并复核风险。

## Deployment responsibilities

应用对账户写操作验证请求来源；退出登录通过同源 POST 发起。

部署者需要：

- 为 `/private*` 配置 Cloudflare Access，确保同时覆盖不带尾斜杠的 `/private` 页面入口和其子路径；新增相同前缀的公开路由时重新检查匹配范围；
- 使用只读权限的交易所 API Key；
- 将 `CREDENTIAL_ENCRYPTION_KEY` 保存在 Worker Secret 中；
- 不把 `.env`、生产配置、D1 导出或日志中的个人数据提交到仓库。

## Public wallet addresses

链上理财接入仅接收钱包公开地址，不要求私钥、助记词或签名。公开地址按用户隔离保存在 D1，当前不作应用层加密；只读查询会将该地址发送至对应链的公开 RPC 服务。交易所密钥仍沿用加密保存机制。

钱包更换或移除会清除对应的当前持仓、使旧刷新失效；产品资料与变更历史保留。读取失败、零值与清理范围以[数据规则](docs/DATA-STATES.md#bitget-wallet--morph)为准。
