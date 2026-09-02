# Stable Earn

Stable Earn 是部署在 Cloudflare Workers 上的稳定币理财监控台，用于汇总持仓、比较 APR、计算剩余高息额度和预估收益。

- `/`：无需登录的固定 USDT 演示；修改只在当前页面生效，刷新后恢复。
- `/private/home`：通过 Cloudflare Access 登录，读取并保存当前用户的数据。
- 支持 USDT、USDC、USDGO、BTC，以及 Binance、Bybit、Bitget、OKX、MEXC 的部分产品。

数据仅用于监控和比较，不构成投资建议；最终结果以平台账户为准。

## 数据来源

产品和持仓分别标记为 API 或人工维护：API 数据保持只读，接口无法覆盖的独立产品才允许人工维护。私人页面每天在上海时间 08:00 和 20:00 更新，也支持手动刷新。

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

产品目录迁移使用 `drizzle/0004_product_catalog.sql`：目录按账号保存内部产品 ID、平台身份和归档状态；新用户不会预置所有平台，公开 API 或账户 API 成功发现产品后才加入目录，人工产品由用户主动添加。API 身份变化会生成新行，旧行只归档不覆盖。资格确认字段迁移使用 `drizzle/0005_eligibility_confirmation.sql`。已有环境升级时按顺序执行 migrations，再部署代码。

## 文档

- [数据状态与展示规则](docs/DATA-STATES.md)
- [界面设计规范](docs/DESIGN-SYSTEM.md)

## License

[MIT](LICENSE)
