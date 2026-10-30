# 部署与数据库迁移

以下命令从仓库根目录执行。应用部署、数据库迁移和远程资源配置是独立步骤；发布前按[发布检查清单](RELEASE-CHECKLIST.md)核对。

## 需要准备

- Cloudflare 账号，以及已登录的 Wrangler（`npx wrangler login`）。
- 一个 D1 数据库，名称使用 `stablecoin-earn-monitor`。
- 一个 Queue，名称使用 `stable-earn-sync`。
- Cloudflare Access 应用，路径规则使用 `/private*`，覆盖 `/private` 页面入口及其子路径。如果新增其他以 `/private` 开头的公开路径，应重新检查匹配范围。
- 按数据源准备交易所只读 API Key，或已支持链上产品的钱包公开地址。交易所 Key 须关闭交易、转账、申购、赎回和提现权限；钱包接入不需要私钥或助记词。

## 第一次部署

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

首次安装须先按[新数据库初始化](#新数据库初始化)准备目标数据库，再继续部署。

2. 安装依赖并部署：

```bash
npm ci
npm run deploy
```

3. 在 Cloudflare Worker 的 Settings → Variables and Secrets 中添加 `CREDENTIAL_ENCRYPTION_KEY` Secret。它必须是 **32 字节随机密钥的 Base64 编码**；例如可在本机用 `openssl rand -base64 32` 生成，再直接填入 Cloudflare Secret。不要把密钥写进代码、README、`.env.example` 或 GitHub Issue。之后确认 Access 已保护 `/private*`（包括 `/private` 页面入口及其子路径），再开始使用应用。

## 数据库说明

[`drizzle/`](../drizzle/) 保留了历史 SQL 迁移文件，但当前部署命令不会自动执行它们；`CREATE TABLE IF NOT EXISTS` 也不会替已有表添加或修改列。生产首次安装应提前初始化数据库；升级已有部署前，应先备份 D1，核对 [`db/schema.ts`](../db/schema.ts)、相关历史迁移与现有表结构，再执行适用的迁移、验证后部署新代码。不要盲目重跑全部历史迁移，也不要把生产数据库 ID 或数据提交到仓库。

应用冷启动只读取一次 `product_history_meta` 版本标记；并发请求共享准备过程，已准备好的数据库不重复执行建表语句。空库的自动建表只是开发/容错路径，不替代生产迁移：完整初始化及同次业务查询可能超过 D1 Free 每次调用的查询数限制。

### 新数据库初始化

仅用于新建且没有业务数据的空库。先准备绑定目标账号和 D1 的本机私密 Wrangler 配置；如果尚无配置，可从 `wrangler.jsonc` 复制为被 Git 忽略的 `wrangler.local.jsonc`，在副本填入目标账号及数据库 ID。不要覆盖已有私密配置，也不要将其提交。

在仓库根目录按文件名顺序执行历史 SQL；子 shell 遇到错误即停止，不继续后面的迁移：

```bash
(
  set -e
  for migration in drizzle/*.sql; do
    npx wrangler d1 execute stablecoin-earn-monitor --remote --config wrangler.local.jsonc --file "$migration"
  done
)
```

成功后核对 `product_history_meta` 的版本为 `1`，`wallet_configs` 表和 `product_override_limits.first_tier_unlimited` 列存在，再部署应用。已有数据库按下面对应的升级步骤处理，不能用此循环重跑全部迁移。

### 历史摘要迁移（0021）

尚未完成 0021 的已有部署，须在合并触发自动部署**之前**，由单一操作者完成以下步骤：

1. 备份当前数据库，确认历史事件表及 `attention`、`read_at` 列已经存在（对应 0013、0017），且此前适用的迁移已完成。
2. 使用绑定到目标数据库的本机私密 Wrangler 配置，完整执行 `drizzle/0021_product_history_summaries.sql`。这是一次原子迁移，不要拆开回填、触发器和版本标记执行；部署脚本不会代做此步骤。
3. 确认 `product_history_meta` 中 `singleton = 1` 的 `version = 1`，并核对各账号摘要的事件总数、未读数与原历史一致，再合并部署。原始历史及已读状态不变；迁移后旧代码的插入、已读操作也由触发器维护摘要。
4. 部署成功后刷新页面，检查红点、历史分页、已读确认和后台暂停轮询；结合 D1 每日读/写行数验证消耗，不只看请求耗时。D1 Free 每日读行额度按 UTC 00:00（北京时间 08:00）重置。

0021 可重复执行，版本标记已就绪时不再次扫描历史回填或重置版本。需要回退应用时，可保留新增摘要表、缓存和触发器，旧代码仍可运行；不要为回退应用删除原历史或重置摘要版本。数据库恢复需另按备份方案处理。

部署环境变量和 Worker Secret 只保存在本机私密环境或 Cloudflare，不要提交真实值。

### 钱包配置迁移（0022）

BGW 接入增加 `wallet_configs` 表。新版本的同步流程会读取该表，必须在合并触发自动部署**之前**，由单一操作者完成：

1. 备份目标数据库并确认前序适用迁移（包括 0021）已经完成。
2. 使用绑定到目标数据库的本机私密 Wrangler 配置，完整执行 `drizzle/0022_wallet_configs.sql`；部署脚本不会自动迁移。
3. 只读核对 `wallet_configs` 包含 `user_id` 主键、`address`、`updated_at` 三列及 SQL 中的钱包地址约束，再合并部署。迁移只新增表，不回填钱包、不扫描持仓或历史。

0022 使用 `CREATE TABLE IF NOT EXISTS`，可重复执行，但不会修正已存在的错误表结构。应用回退时保留新增表及钱包配置，旧代码不使用该表；不要为了回退应用删除钱包配置。数据库恢复需另按备份方案处理。

### 人工额度模式迁移（0023）

从已有版本升级且 `product_override_limits` 尚无 `first_tier_unlimited` 列时，必须在合并触发自动部署**之前**执行；0022 已完成的部署无需重跑钱包迁移。

1. 备份目标 D1，确认前序适用迁移已完成，用 `PRAGMA table_info(product_override_limits);` 核对新列尚不存在。
2. 使用绑定到目标数据库的本机私密 Wrangler 配置，完整执行 [`drizzle/0023_manual_limit_mode.sql`](../drizzle/0023_manual_limit_mode.sql)。必须在新版 BGW 刷新改写目录之前迁移，才能保留旧版本明确采用的不限额设置。回填按账号与产品隔离，含已归档 BGW 产品，保留原有限额、APR、来源时间和历史。
3. 再查表结构确认新列存在；核对原 BGW 不限额记录的状态为 `1`，正数额度未改变。新列 `NULL` 兼容旧记录，`0` 为明确限额/待填写，`1` 为不限额且数值额度必须为 `NULL`，再继续部署和页面验证。

0023 包含一次性 `ALTER TABLE`，**不可整份重复执行**；已通过最新版完整建表的新数据库也不应再跑该迁移。若新列已存在但不确定是否完成回填，应先核对状态，不能直接重跑。回退时保留新增列和配置；旧界面无法完整表达新模式，恢复旧代码前应另行评估额度编辑的兼容性。

`wrangler.jsonc` 默认将 `SCHEDULED_SYNC_ENABLED` 设为 `false`，因此不会启用每日队列同步；每日首次打开和手动刷新仍可使用。若要启用定时同步，应先确认 Cloudflare Queues 已创建并绑定，再按自己的请求额度评估后修改该设置并重新部署。
