# Stable Earn

Stable Earn 是运行在 Cloudflare Workers 上的稳定币与 BTC 理财监控台。

## 主要功能

- 支持 USDT、USDC、USDGO、BTC，以及活期、定期和活动型产品。
- 按平台能力使用交易所 API、钱包公开地址同步或手动维护数据。
- 展示阶梯 APR、额度、持仓、到期信息、预估收益和变更记录，支持多账号隔离。

数据仅用于监控和比较，不构成投资建议；最终结果以对应平台账户为准。

## 在线演示

[打开演示](https://stable.noood.workers.dev/)。未登录时显示模拟数据。

## 本地运行

本地使用模拟数据，无需配置 Cloudflare、交易所 API 或钱包地址。

### 使用 AI 启动

将以下内容交给有本机终端权限的 AI，按[启动 Skill](skills/stable-earn-preview/SKILL.md)运行：

> 请在本机启动 https://github.com/noood/stable-earn 的模拟预览。先阅读仓库中的 `skills/stable-earn-preview/SKILL.md`，按 README 安装和启动。确认页面可用后保持服务运行，并说明停止和再次启动的方法。

### 手动启动

1. 安装 [Node.js LTS](https://nodejs.org/zh-cn/download)，版本至少为 **22.13**。安装后重新打开终端，可用 `node --version` 查看版本。
2. 在 [GitHub 仓库](https://github.com/noood/stable-earn)点击 **Code → Download ZIP**，解压；也可以用 Git 克隆。
3. 在项目文件夹（包含 `package.json`）打开终端。Windows：在文件资源管理器地址栏输入 `powershell` 后回车。macOS：打开“终端”，输入 `cd `（末尾有空格），将项目文件夹拖入窗口后回车。
4. 依次运行以下命令，首次安装依赖需要联网：

```bash
npm ci
npm run dev
```

看到 `Local: http://localhost:3000/` 后，在浏览器打开：

| 页面 | 地址 |
| --- | --- |
| 公开演示页 | <http://localhost:3000> |
| 私人页模拟，可编辑 | <http://localhost:3000/private> |

保持终端运行，按 **Ctrl+C** 停止。下次在项目文件夹运行 `npm run dev` 重新启动。

### 模拟数据

持仓、新增产品和移除操作不会写入数据库，刷新后恢复样例；部分产品设置保存在当前浏览器。页面中的 API 失败、缓存和资料缺失包含预设的测试场景。

主动填写真实凭证并运行 API 检查会请求交易所。保存范围、启动问题和测试场景见[本地预览说明](CONTRIBUTING.md#本地预览)。

## 部署到 Cloudflare

首次部署、环境配置、版本升级和数据库迁移见[部署指南](docs/DEPLOYMENT.md)。

## 文档

| 内容 | 文档 |
| --- | --- |
| 配置交易所、钱包或手动产品 | [数据源设置与支持范围](docs/DATA-SOURCES.md) |
| 开发、预览、测试与了解模块分工 | [开发与贡献](CONTRIBUTING.md) |
| 理解缓存、刷新、收益和目录行为 | [数据规则](docs/DATA-STATES.md) |
| 实现字段解析或产品身份 | [APR 与额度规则](docs/API-APR-CAPACITY-RULES.md)、[产品身份](docs/PRODUCT-IDENTITY.md) |
| 修改界面或排查问题 | [设计规范](docs/DESIGN-SYSTEM.md)、[诊断说明](docs/DIAGNOSTICS.md) |
| 核对交易所 API 或准备发布 | [平台能力与核验依据](docs/PLATFORM-CAPABILITIES.md)、[发布清单](docs/RELEASE-CHECKLIST.md) |

## 安全与许可证

凭证权限、隐私边界及漏洞报告见 [SECURITY.md](SECURITY.md)。

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)，允许许可证定义范围内的非商业使用；商业用途不在许可范围内。第三方依赖、字体及品牌素材的义务和待确认项见[第三方许可证盘点](docs/THIRD-PARTY-LICENSES.md)。
