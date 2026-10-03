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

打开 <http://localhost:3000> 查看本地预览。开发环境使用模拟数据，不访问生产数据库或交易所账户。

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

生产部署需要：

- Cloudflare Workers
- Cloudflare D1
- Cloudflare Access（保护 `/private/*`）
- Cloudflare Queues（用于定时同步）
- 只读权限的交易所 API Key

部署配置使用以下环境变量和 Worker Secret。只提交变量名，不要提交真实值：

```text
CLOUDFLARE_ACCOUNT_ID
D1_DATABASE_ID
TEAM_DOMAIN
POLICY_AUD
CREDENTIAL_ENCRYPTION_KEY
```

运行：

```bash
npm run deploy
```

## 安全

安全要求和漏洞报告流程见 [SECURITY.md](SECURITY.md)。交易所 API Key 应使用只读权限，并关闭交易、转账、申购、赎回和提现权限。

## 许可证

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)。允许个人及符合许可证定义的非商业组织学习、修改和分发；商业用途不在许可范围内。
