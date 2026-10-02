# Stable Earn

Stable Earn 是一个基于 Cloudflare Workers 的跨平台理财监控台，用于查看稳定币与 BTC 理财产品的 APR、阶梯额度、持仓和预估收益。

## 项目特点

- 支持 USDT、USDC、USDGO 和 BTC。
- 对接 Binance、Bybit、Bitget、OKX；MEXC 等未接入实时 API 的产品可手动维护。
- 同时支持活期、定期和活动型产品。
- 区分产品信息与持仓信息，分别处理 API、缓存、部分同步和失败状态。
- 支持 APR 阶梯计算、持仓收益估算、产品隐藏和手动产品维护。
- 私人数据通过 Cloudflare Access 保护，交易所凭证按用户隔离保存。

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
```

## 部署概览

生产环境需要：

- Cloudflare Workers
- Cloudflare D1
- Cloudflare Access，并保护 `/private/*`
- Cloudflare Queues（用于后台同步）
- 只读权限的交易所 API Key

部署脚本从私有环境变量读取以下配置，不应把真实值写入仓库：

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

首次部署前请确认目标 D1 已按项目版本说明完成所需初始化。部署不会自动清空数据库。

## 安全说明

- 私人 API 要求有效的 Cloudflare Access JWT。
- 交易所凭证使用 AES-GCM 加密后写入 D1，密钥只通过 Worker Secret 提供。
- API Key 应使用只读权限，并关闭交易、转账、申购、赎回和提现权限。
- `.env*`、部署配置和生成文件已加入忽略规则；不要提交密钥、个人数据或生产数据库导出。
- 安全问题请按照 [SECURITY.md](SECURITY.md) 的方式私下报告。

## 文档

- [数据状态与展示规则](docs/DATA-STATES.md)
- [产品身份与 ID 规则](docs/PRODUCT-IDENTITY.md)
- [界面设计规范](docs/DESIGN-SYSTEM.md)

## 许可

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)。允许个人及符合许可证定义的非商业组织学习、修改和分发；商业用途不在许可范围内。
