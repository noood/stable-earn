# Stable Earn

Stable Earn 是一个基于 Cloudflare Workers 的稳定币与 BTC 理财监控台，用于集中查看不同平台的理财产品、APR、额度、持仓和预估收益。

## 主要功能

- 支持 USDT、USDC、USDGO 和 BTC。
- 对接 Binance、Bybit、Bitget 和 OKX 等平台。
- 支持活期、定期和活动型产品。
- 展示 APR、阶梯额度、持仓、到期信息和预估收益。
- 支持 API 同步产品与持仓，也支持手动维护产品。
- 支持多账号数据隔离和 API 产品隐藏。

数据仅用于监控和比较，不构成投资建议；最终结果以对应平台账户为准。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm ci
npm run dev
```

打开 <http://localhost:3000> 查看本地预览。日常页面使用模拟产品与持仓数据，不访问生产数据库。若在本地配置真实交易所凭证并主动运行 API 检查，检查仍会请求交易所接口。

常用检查：

```bash
npm test       # 自动化测试
npm run verify # lint、类型检查和测试
npm run check  # verify 加生产构建
npx playwright install chromium # 首次运行浏览器测试时安装 Chromium
npm run test:e2e # 启动本地预览并运行 Playwright 浏览器检查
```

发布前核对范围见 [发布检查清单](docs/RELEASE-CHECKLIST.md)。浏览器测试只访问本地预览与模拟数据，不连接生产账号或 D1。

## 自托管部署

### 需要准备

- Cloudflare 账号，以及已登录的 Wrangler（`npx wrangler login`）。
- 一个 D1 数据库，名称使用 `stablecoin-earn-monitor`。
- 一个 Queue，名称使用 `stable-earn-sync`。
- Cloudflare Access 应用，保护网站的 `/private/*` 路径。
- 交易所只读 API Key；关闭交易、转账、申购、赎回和提现权限。

### 第一次部署

1. 在 Cloudflare 创建 D1 数据库和 Queue：

```bash
npx wrangler d1 create stablecoin-earn-monitor
npx wrangler queues create stable-earn-sync
```

将 D1 返回的数据库 ID、Cloudflare 账号 ID、Access 团队域名和 Access 应用的 Audience 分别配置为私密环境变量：

```text
CLOUDFLARE_ACCOUNT_ID
D1_DATABASE_ID
TEAM_DOMAIN
POLICY_AUD
```

这些值由 `npm run deploy` 生成部署配置时读取；生成的配置文件不会提交到 Git。

2. 安装依赖并部署：

```bash
npm ci
npm run deploy
```

3. 在 Cloudflare Worker 的 Settings → Variables and Secrets 中添加 `CREDENTIAL_ENCRYPTION_KEY` Secret。它必须是 **32 字节随机密钥的 Base64 编码**；例如可在本机用 `openssl rand -base64 32` 生成，再直接填入 Cloudflare Secret。不要把密钥写进代码、README、`.env.example` 或 GitHub Issue。之后确认 Access 已保护 `/private/*`，再开始使用应用。

### 数据库说明

第一次访问需要数据库的功能时，应用会自动创建缺少的数据表和索引。`drizzle/` 保留了历史 SQL 迁移文件，但当前部署命令不会自动执行它们；`CREATE TABLE IF NOT EXISTS` 也不会替已有表添加或修改列。升级已有部署前，应先备份 D1，核对 `db/schema.ts`、相关历史迁移与现有表结构；若结构有变化，先准备并验证对应迁移，再部署新代码。不要把生产数据库 ID 或数据提交到仓库。

部署环境变量和 Worker Secret 只保存在本机私密环境或 Cloudflare，不要提交真实值。

`wrangler.jsonc` 默认将 `SCHEDULED_SYNC_ENABLED` 设为 `false`，因此不会启用每日队列同步；每日首次打开和手动刷新仍可使用。若要启用定时同步，应先确认 Cloudflare Queues 已创建并绑定，再按自己的请求额度评估后修改该设置并重新部署。

## 安全

安全要求和漏洞报告流程见 [SECURITY.md](SECURITY.md)。交易所 API Key 应使用只读权限，并关闭交易、转账、申购、赎回和提现权限。

## 许可证

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)。允许个人及符合许可证定义的非商业组织学习、修改和分发；商业用途不在许可范围内。
