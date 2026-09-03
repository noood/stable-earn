# Stable Earn

Stable Earn 是部署在 Cloudflare Workers 上的稳定币理财监控台，用于汇总持仓、比较 APR、计算高息剩余额度和预估收益。

- `/`：无需登录的固定 USDT 演示；修改只在当前页面生效，刷新后恢复。
- `/private/home`：通过 Cloudflare Access 登录，读取并保存当前用户的数据。
- 支持 USDT、USDC、USDGO、BTC，以及 Binance、Bybit、Bitget、OKX、MEXC 的部分产品。

数据仅用于监控和比较，不构成投资建议；最终结果以平台账户为准。

## 数据来源

产品信息与持仓分别标记为 API 或人工维护：API 字段保持只读；需要人工维护的产品由用户添加，或由账户中的实际持仓触发后补全。私人页面每天在上海时间 08:00 和 20:00 更新，也支持手动刷新。计划更新失败时会在 1 分钟和 5 分钟后重试，前两次失败不会改变用户看到的数据。

没有可靠数据时显示“待获取”或“待填写”；更新失败时可以继续使用最近一次成功缓存，并明确标注缓存时间。完整规则见 [数据状态说明](docs/DATA-STATES.md)。

## 安全

- Cloudflare Access 保护所有 `/private/*` 页面和接口，不同用户的数据相互隔离。
- 交易所凭据仅在服务端加密保存，完整 Key 和 Secret 不会返回浏览器。
- `CREDENTIAL_ENCRYPTION_KEY` 必须使用 Cloudflare Secret，不能提交到 Git。
- 交易所 API Key 只应开放读取权限，关闭交易、申购、赎回、转账和提现权限。
- 应用不包含交易、划转或提现操作。

## 本地开发

需要 Node.js 22.13 或更高版本。

```bash
npm ci
npm run dev
```

访问 <http://localhost:3000> 查看公开演示，访问 <http://localhost:3000/private/home> 查看私人页面的本地测试数据。本地私人页面不会写入生产 D1。

提交前运行：

```bash
npm run check
```

## 部署

部署前需要：

1. 在 Cloudflare Workers Builds 的私有环境变量中设置 `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`TEAM_DOMAIN` 和 `POLICY_AUD`。
2. 执行 `drizzle/` 中的 D1 migrations。
3. 设置 `CREDENTIAL_ENCRYPTION_KEY` Worker Secret。
4. 运行 `npm run deploy`，或让 Cloudflare Workers Builds 在 `main` 更新后自动部署。

部署脚本会根据这些私有变量生成临时 Wrangler 配置；公开仓库中的 `wrangler.jsonc` 只保留占位值，不应写入真实配置。

实例标识可以公开，但不具备通用性；复用本项目时必须替换。数据库迁移与代码部署相互独立，普通部署不会清空 D1。

已有环境升级时按文件顺序执行尚未运行的 migrations，再部署代码；历史 migration 必须保留，不应重复修改或删除。

## 文档

- [数据状态与展示规则](docs/DATA-STATES.md)
- [界面设计规范](docs/DESIGN-SYSTEM.md)

## License

[MIT](LICENSE)
