# Stable Earn

Stable Earn 是一个用于查看加密资产理财持仓、比较 APR 和估算收益的 Cloudflare Workers 应用。

## 功能

- 公开演示页：访问 `/` 查看固定的 USDT 示例数据。
- 私人页面：访问 `/private/home`，通过 Cloudflare Access 查看自己的数据。
- 支持 USDT、USDC、USDGO、BTC，以及 Binance、Bybit、Bitget、OKX、MEXC 的部分产品。
- Binance 账户 API 同步 Simple Earn 活期（Flexible）和定期（Locked）产品、APR 与持仓。
- 产品信息和持仓可以来自交易所 API，也可以手动维护。

数据仅用于监控和比较，不构成投资建议；最终结果以平台账户为准。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm ci
npm run dev
```

打开 <http://localhost:3000> 查看公开演示。私人页面在本地使用测试数据，不会写入生产数据库。

提交修改前运行：

```bash
npm run check
```

包含代码检查、类型检查、自动化测试和构建；单独运行测试用 `npm test`。
测试不需要交易所密钥或线上数据库；本地模拟场景见 [测试说明](docs/DATA-STATES.md#验证方式)。

## 部署到 Cloudflare

1. 创建 Cloudflare Workers、D1 数据库和 Cloudflare Access 应用，并让 Access 保护 `/private/*` 路径。
2. 在部署环境中设置以下变量：
   - `CLOUDFLARE_ACCOUNT_ID`
   - `D1_DATABASE_ID`
   - `TEAM_DOMAIN`
   - `POLICY_AUD`
3. 设置 Worker Secret：`CREDENTIAL_ENCRYPTION_KEY`。
4. 在 Cloudflare Queues 中创建队列 `stable-earn-sync`（首次部署或升级时只需创建一次）。生产者、消费者及重试配置由部署写入；若改名，请同步修改 `wrangler.jsonc` 中的两处队列名。
5. 按顺序执行 `drizzle/` 中尚未执行的 D1 migration。
6. 运行 `npm run deploy`，或使用 Cloudflare Workers Builds 自动部署。

`wrangler.jsonc` 只包含占位值。不要把真实账号、数据库 ID、Access 配置或密钥提交到 Git。部署后需要在应用中配置只读权限的交易所 API Key，并关闭交易、转账、申购、赎回和提现权限。公开演示不需要这些 Cloudflare 配置；私人页面需要使用者自己的 Workers、D1、Access 和 API Key。

计划任务按 UTC 23:00 执行，对应上海时间每天 07:00；失败或部分失败后等 3 分钟再试一次，每次使用独立任务额度。每天首次打开已登录页面还会刷新一次（按账号、上海日期计算，成功失败均计次），当天再次打开只读缓存；主动手动刷新保留原冷却设置。队列可能有投递延迟，并非保证整点完成。普通部署不会清空 D1 数据。

同步失败时，在 Worker 的 Observability / Events 中查找 `sync_finished`，查看[诊断日志说明](docs/DATA-STATES.md#同步诊断日志)。日志从部署后开始记录，不包含密钥或持仓金额。

## 开发文档

- [数据状态与展示规则](docs/DATA-STATES.md)：产品目录、持仓、收益和同步状态。
- [界面设计规范](docs/DESIGN-SYSTEM.md)：颜色、间距、组件和响应式规则。

## 使用许可

本项目采用 [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)。
允许个人及符合许可证定义的非商业组织学习、修改和分发；商业用途不在许可范围内。
详情见 [LICENSE](LICENSE)。
