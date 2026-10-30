# Stable Earn

Stable Earn 是一个基于 Cloudflare Workers 的稳定币与 BTC 理财监控台，用于集中查看交易所及已支持的链上理财产品、APR、额度、持仓和预估收益。

## 主要功能

- 支持 USDT、USDC、USDGO、BTC，以及活期、定期和活动型产品。
- 按平台能力使用交易所 API、钱包公开地址同步或手动维护数据。
- 展示阶梯 APR、额度、持仓、到期信息、预估收益和变更记录，支持多账号隔离。

平台和配置方式统一见[数据源设置](docs/DATA-SOURCES.md)。数据仅用于监控和比较，不构成投资建议；最终结果以对应平台账户为准。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm ci
npm run dev
```

打开 <http://localhost:3000>。默认使用模拟产品与持仓，不连接生产 D1；主动配置真实凭证并运行 API 检查时，仍会请求交易所接口。场景与验证命令见[开发指南](CONTRIBUTING.md)。

## 文档导航

| 你要做什么 | 文档 |
| --- | --- |
| 配置交易所、钱包或手动产品 | [数据源设置与支持范围](docs/DATA-SOURCES.md) |
| 开发、预览、测试与了解模块分工 | [开发与贡献](CONTRIBUTING.md) |
| 自托管、升级或执行数据库迁移 | [部署与数据库迁移](docs/DEPLOYMENT.md) |
| 理解缓存、刷新、收益和目录行为 | [数据规则](docs/DATA-STATES.md) |
| 实现字段解析或产品身份 | [APR 与额度规则](docs/API-APR-CAPACITY-RULES.md)、[产品身份](docs/PRODUCT-IDENTITY.md) |
| 修改界面或排查问题 | [设计规范](docs/DESIGN-SYSTEM.md)、[诊断说明](docs/DIAGNOSTICS.md) |
| 核对交易所 API 或准备发布 | [平台能力与核验依据](docs/PLATFORM-CAPABILITIES.md)、[发布清单](docs/RELEASE-CHECKLIST.md) |

使用、开发与部署步骤各自在对应指南维护；业务规则、设计规则和接口证据分别维护。

## 安全与许可证

凭证权限、隐私边界及漏洞报告见 [SECURITY.md](SECURITY.md)。

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)，允许许可证定义范围内的非商业使用；商业用途不在许可范围内。第三方依赖、字体及品牌素材的义务和待确认项见[第三方许可证盘点](docs/THIRD-PARTY-LICENSES.md)。
