# Cloudflare 预览环境待办计划

状态：待办，尚未实施。

## 目标

为非 `main` 分支提供受保护的 Cloudflare 预览版本，让代码先在预览环境验证，再通过 GitHub PR 合并到 `main` 部署生产。复用同一份虚构测试样例，不维护两套手工数据；预览和生产的数据库、队列、密钥及访问规则必须隔离。

## 当前已核实状态

- Cloudflare Worker `stable` 的生产分支为 GitHub `main`；推送到 `main` 会触发生产构建/部署。
- Cloudflare 的“Builds for Preview branches”目前关闭；Preview Base 的运行变量和绑定目前为空。
- Cloudflare Production 中 `SCHEDULED_SYNC_ENABLED` 当前值为 `false`。
- 仓库已有本地模拟数据：`lib/preview-fixtures.ts` 提供产品样例，`lib/local-preview.ts` 组合持仓、缓存和变更历史；相关场景由测试覆盖。
- 本地预览被限制为 `NODE_ENV=development` 且 localhost 请求，尚未接入远程 Cloudflare 预览；仓库没有把这套样例导入 D1 的通用脚本。
- `wrangler.jsonc` 定义 D1 绑定 `DB`、队列绑定 `SYNC_QUEUE`（当前队列名为 `stable-earn-sync`），并将 `CREDENTIAL_ENCRYPTION_KEY` 声明为必需 Secret。`scripts/deploy.mjs` 还需要 Cloudflare 账户、D1、Access 域名和 audience 等构建/部署变量。
- 当前 Cloudflare 预览构建设置中显示的 Preview command 是 `npx wrangler preview`。启用前必须核实该命令在 Workers Builds 中的实际作用，以及分支预览如何部署，不能假设它天然与生产 Worker/绑定隔离。

## 实施清单

### 1. 先确定分支预览的部署方式

- 核实 Cloudflare Workers Builds 对非生产分支的触发方式、预览 URL、构建与部署命令，以及预览版本和 `stable` 生产版本之间的隔离方式。
- 确认推送功能分支不会更新 `stable`、改写生产版本或使用生产 D1/队列；若当前 `npm run deploy` 或 Worker 名称不能保证隔离，先设计明确的 preview 部署配置。
- 确认 PR 更新和普通分支 push 分别会不会触发预览构建，记录可观察的成功/失败入口。
- 未通过这项检查前，不打开预览构建开关。

### 2. 让本地样例可被受控的远程预览复用

- 将现有预览样例作为唯一数据源；不要另手工维护一套 Cloudflare 样例。
- 为 Cloudflare 预览增加明确的非生产开关，使预览版可以安全读取同一份虚构样例。不能只依赖 `?preview=1` 之类 URL 参数，也不能移除 localhost/开发环境保护后让生产能够进入样例模式。
- 本地开发和 Cloudflare 预览分别运行，各自的运行状态隔离；如果预览需要持久化用户编辑，则用独立 Preview D1，并从同一份样例生成初始数据，而不是连接本地或生产数据库。
- 增加测试，证明预览模式可用、生产无法启用预览样例、生产用户数据不会被覆盖。

### 3. 建立并配置隔离的 Preview 资源

- 创建独立 Preview D1（如 `stable-earn-preview`），不复用生产 D1，不复制真实用户凭证。
- 若预览要测试队列/同步，创建独立 Preview 队列，并将 `SYNC_QUEUE` 绑定到它。当前配置指向 `stable-earn-sync`，须通过 Preview 专用配置覆盖或显式禁用该绑定，不能让预览 Worker 消费生产队列。
- Preview 的 `SCHEDULED_SYNC_ENABLED` 明确设为 `false`。仅在将来需要测试同步时，再另行设计可控的同步测试流程。
- 给预览 Worker 配置 Cloudflare Access，只允许项目所有者/指定测试者；不要沿用会让所有正式用户访问预览的宽泛策略。
- Preview 配置使用独立的 Access 参数和独立 `CREDENTIAL_ENCRYPTION_KEY`。该加密密钥不是交易所 API key，不提交到 Git；默认 UI 测试不配置真实交易所凭证。
- 仅填写运行预览所需的构建变量和资源绑定；账户标识可按 Cloudflare 所需复用，但 D1 ID、队列和敏感 Secret 必须使用 Preview 对应项。

### 4. 配置并小范围试启 Cloudflare 预览构建

- 在完成前述资源和代码隔离后，设置 Preview Base 的变量、Secret、D1/队列绑定和 Access 规则。
- 核实 Preview build/deploy command、分支规则及产出的预览 URL；必要时更新 Wrangler/部署脚本配置，使预览部署不会覆盖 `stable`。
- 最后才开启 “Builds for Preview branches”。先用临时功能分支验证，不用 `main` 试开关。

### 5. 预览环境验收

- 推送测试功能分支，确认 GitHub CI 与 Cloudflare 预览构建各自状态可见。
- 确认预览 URL 受 Access 保护，未经授权访问会被拒绝。
- 确认页面使用同一份虚构样例，预览 D1/队列与生产完全分开，且没有使用真实交易所凭证。
- 检查主要页面、私有 API、编辑/刷新交互和构建资源；确认预览版不会触发自动同步。
- 在 Cloudflare 部署记录中确认此次只产生预览版本，`stable` 生产部署版本未变化。

## 启用后的日常开发与发布流程

1. 从最新 `main` 创建本地功能分支，在该分支完成开发。
2. 本地运行项目检查与功能测试；推送功能分支到 GitHub。
3. Cloudflare 自动构建该非生产分支的预览版本；等待 GitHub CI 和 Cloudflare 预览构建完成。
4. 通过受保护的预览 URL 检查页面和交互；有问题就在原功能分支修复并再次推送。
5. 验证通过后，在 GitHub 创建/更新 PR。按发布清单检查后合并进 `main`。
6. 合并更新 `main` 后，Cloudflare 按现有生产流程部署 `stable`；检查 Cloudflare 生产部署结果和关键页面。
7. 任何直接推送到 `main` 仍视为生产发布，不作为预览测试手段。

## 完成标准

- 一份虚构样例定义同时供本地预览和 Cloudflare 预览使用，无需人工维护两份。
- 分支预览经过 Access 保护，使用隔离的 D1/队列/密钥；没有真实交易所凭证。
- 明确证明功能分支部署不会影响 `stable` 生产版本。
- 有自动化测试覆盖预览样例模式的环境边界，且本地检查、构建和预览冒烟验证通过。
- 日常流程和故障排查入口已记录；完成验收前保持预览构建关闭。

## 明确不在本待办中的操作

- 当前不启用 Cloudflare 预览分支构建。
- 当前不创建 D1、Queue、Access 应用或 Preview Secret。
- 当前不部署、修改 GitHub/Cloudflare 远程设置，也不向预览环境录入真实 API 凭证。
