# 开发与贡献

首次运行见 [README](README.md#本地运行)。本文件维护本地预览、验证命令和代码组织；生产部署及数据库迁移见[部署指南](docs/DEPLOYMENT.md)。

## 本地预览

默认预览使用虚构的产品、持仓和历史，不连接生产 D1。模拟入口仅在开发环境的 localhost 请求中启用；不要把 URL 参数当作生产预览开关。

| 场景 | 本地地址 |
| --- | --- |
| 普通私人页 | <http://localhost:3000/private> |
| USDC 持仓（含 BGW 产品与 APR 编辑） | <http://localhost:3000/private?asset=USDC> |
| 页面模块加载失败 | <http://localhost:3000/private?moduleScenario=error> |
| 产品与持仓读取失败 | <http://localhost:3000/private?syncScenario=both-read-error> |

普通 USDC 预览包含 BGW 合成产品、123.45 USDC 持仓及可编辑的 6.72% APR，未配置钱包也可测试。保存只影响预览，不访问主网或生产 D1。测试使用虚构地址、交易与金额，不复制真实账户资料或截图。

若配置真实交易所凭证并主动运行 API 检查，仍会请求交易所接口；默认 UI 测试与这类真实接口核验分开。诊断和专项探针的选择见[诊断说明](docs/DIAGNOSTICS.md)。远程分支预览尚未实施，见[待办计划](docs/PREVIEW-ENVIRONMENT-PLAN.md)。

## 测试与检查

日常先跑与改动直接相关的快速检查；UI 或用户行为改动还要运行对应的本地 Playwright E2E：

```bash
npm run test:file -- tests/data-states.test.mjs
npx eslint lib/product-status.ts app/components/dashboard/product-row.tsx

# 首次运行浏览器测试前安装 Chromium
npx playwright install chromium
npm run test:e2e -- --grep "known quota|known first tier"
```

- `npm test` 执行全部离线测试，覆盖同步状态、身份映射、历史分页及数据边界。
- Playwright 默认复用 localhost:3000；服务未运行时自行启动。测试使用单 worker，不同时启动多套测试访问这个共享服务。
- 浏览器测试覆盖加载、币种切换、编辑及键盘操作、历史、保存/移除和窄屏；账户写入由合成响应拦截，不连接生产账号或 D1。
- 生产部署前，在最终候选代码上完整运行一次 `npm run test:e2e`，并按[发布清单](docs/RELEASE-CHECKLIST.md)审阅结果。

PR 的 GitHub Actions 统一运行 `npm run check` 和安全审计，不运行 E2E。正常开发不必在本地重复整套 CI；修改 CI/测试基础设施、CI 不可用或需要完整本地复核时运行：

```bash
npm run check
npm run audit:security
```

`check` 包含 lint、类型检查、离线测试及生产构建。审计中，生产依赖失败会阻止该检查通过；开发工具告警会展示。只有将相应检查配置为 `main` 的必需状态，才会阻止不合格的 PR 合并。

生产构建的历史摘要、按需加载与声明文件另用以下命令验证：

```bash
npm run build
npx playwright test --config=playwright.production.config.mjs
```

它在 127.0.0.1:3001 临时启动生产构建，账户接口使用合成响应，不使用凭证或生产 D1；运行前确保端口空闲。常规开发预览的 E2E 仍使用 `npm run test:e2e`。

### 截图基线

仓库目前只维护 macOS（`darwin`）基线，覆盖桌面和 375px 窄屏。其他系统需先生成并人工审阅对应平台的基线，不跨系统比较；只有确认视觉变化符合预期后才更新。

本地预览可使用 `previewAt=2026-10-06T10:00:00.000Z` 固定模拟数据时间，浏览器测试另固定页面时钟。此参数在生产环境不启用。

## 代码组织

- `app/page.tsx` 与 `app/private/private-dashboard-client.tsx` 负责页面入口；共用 `app/components/dashboard/dashboard.tsx`。私人页面保留静态外壳及客户端延迟加载，不从公共页面入口反向导入。
- `scripts/startup-assets.mjs` 根据客户端模块图生成启动资源映射；私人页预加载、资源诊断和生产浏览器测试共用。产物位于 `dist/`，不提交到 Git；服务端嵌入的是本次构建数据，不在请求时读取本地文件。
- `app/components/dashboard/` 内的产品行、输入和日期控件负责展示及交互；Dashboard 统一协调加载、刷新、草稿和保存。子控件通过回调交接修改，不自行保存数据。
- `lib/private-sync/types.ts` 与 `status.ts` 维护同步内部类型、状态及文案；`snapshots.ts` 聚合平台读取，`payload.ts` 合并缓存与目录并准备保存方案，`service.ts` 统一执行刷新及提交。
- 产品 HTTP 接口保留鉴权、同源校验、请求参数、刷新门控和响应；`lib/scheduled-sync.ts` 负责队列调度，直接调用同步服务。读取和候选合并层不提交数据，保存顺序与运行锁由服务协调。

数据行为以 [数据规则](docs/DATA-STATES.md)为准，字段解析见 [APR 与额度规则](docs/API-APR-CAPACITY-RULES.md)，已核验接口见 [平台能力矩阵](docs/PLATFORM-CAPABILITIES.md)。模块整理不另定义业务规则。

链上持仓入口为[公开 RPC 适配器](lib/integrations/bitget-wallet.ts)、[钱包配置](lib/wallet-config.ts)和[产品声明](lib/bitget-wallet-product.ts)。对应的[浏览器测试](e2e/bitget-wallet.spec.mjs)、[适配器测试](tests/bitget-wallet.test.mjs)和[同步测试](tests/bitget-wallet-sync.test.mjs)分别覆盖交互、区块读取及失败回退。
