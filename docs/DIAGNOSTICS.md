# 诊断入口与一次性探针

本文是项目诊断能力的单一索引。它区分页面启动诊断、平台能力检查器和专项只读探针，避免把它们误认为同一种工具或稳定的公开 API。

## 使用边界

- `/private` 页面返回静态页面外壳，不在页面路由本身验证应用登录；用户数据 API 会验证应用身份。部署环境可再用 Cloudflare Access 保护页面和 API。当前线上 Access 路径规则为 `/private*`，覆盖 `/private` 入口及其子路径；自托管时应确认规则也匹配不带尾斜杠的入口。
- 下表的专项探针会使用当前用户已保存的交易所只读凭证调用交易所接口。不要为了探针创建带交易/提现权限的密钥。
- 专项探针不写入产品、持仓、缓存或历史数据。`bitget-usdgo` 会写入脱敏的应用诊断日志；能力检查器只在检测到平台限流时记录用户冷却时间。
- 探针是维护/排查入口，不承诺为长期稳定 API；路径会随对应代码版本部署而存在。不要向用户文档或外部服务宣传这些路由。
- 手动探针可能触发交易所限流。每次排查只运行所需的最窄范围，不要为了单个币种运行全平台检查。

## 入口总览

| 类型 | 入口 | 作用与范围 | 调用和副作用 |
| --- | --- | --- | --- |
| 页面启动诊断 | 私有页面 URL 加 `?diagnostics=1`；已有查询参数时用 `&diagnostics=1` | 显示页面启动步骤、相关接口 HTTP 状态和通用失败类别；不提供上游响应正文 | 浏览器内临时显示，不保存或上报诊断面板内容；适合用户协助排查页面初始化问题 |
| 平台能力检查器 | 设置页“API 检测”；`POST /private/api/diagnostics/platform-capabilities` | 检查代码已知的平台 API 能力，覆盖产品/APR 与持仓；不是未知接口发现器 | 只读调用已配置账号；限流时会保存该用户的冷却时间；报告不写入产品或持仓 |
| Bitget 产品专项探针 | `GET` 或 `POST /private/api/diagnostics/bitget-products` | 默认检查 Bitget 产品资料；可用 `?asset=USDC&productId=...` 指定单产品容量检查 | 只读产品接口，不读取持仓；当前 Worker 实例内每用户 30 秒冷却，不保证跨实例或实例重启后仍生效 |
| Binance 定期产品专项探针 | `GET` 或 `POST /private/api/diagnostics/binance-locked-products` | 检查已配置 Binance Global/Bahrain 账号的定期产品 APR、额度和申购状态；不会请求持仓 | 每个已配置账号最多一次产品列表请求；当前 Worker 实例内每用户 30 秒冷却，不保证跨实例或实例重启后仍生效 |
| Binance 活期档位专项探针 | `GET` 或 `POST /private/api/diagnostics/binance-usdc-tiers?asset=USDC` | 检查 USDC 活期 APR 档位；`asset` 支持 USDC、USDT、BTC，省略时默认为 USDC | 每个已配置 Binance 账号最多一次公开产品列表请求；不读持仓、不写产品/缓存/历史；当前 Worker 实例内每用户 30 秒冷却，不保证跨实例或实例重启后仍生效 |
| Bitget USDGO 专项探针 | `POST /private/api/diagnostics/bitget-usdgo` | 一次读取 Bitget USDGO 产品与持仓接口能力，返回脱敏状态/计数 | 不写 D1 业务数据；会记录脱敏应用诊断字段；没有跨请求冷却 |

专项 API 路由既接受已登录的同站 GET，也接受经过同源校验的 POST；`bitget-usdgo` 仅提供 POST。所有路由都不接受匿名调用。

## 如何选择

1. 页面打不开、启动卡住或 UI 显示初始化错误：先用页面启动诊断；它只能说明浏览器到应用接口的状态，不能证明上游交易所实际返回了什么。
2. 要确认项目内已知 API 能力或多平台同步状态：从设置页运行平台能力检查器。它范围较广，只有确实需要跨平台盘点时才运行。
3. 已把问题缩小到某平台/币种/产品时：选择上表对应的专项探针，避免重复运行通用检查器。
4. 要判断线上上游响应内容：以应用明确记录且脱敏的诊断字段为证据；Worker 请求日志中的 URL、HTTP 状态或 `outcome=ok` 本身不能说明产品数据字段是否正确。

## 代码与测试索引

- 页面诊断：`app/components/startup-diagnostics.tsx`；`e2e/private-shell.spec.mjs`
- 平台能力检查器：`lib/platform-capability-probe.ts`、`app/private/api/diagnostics/platform-capabilities/route.ts`；`tests/platform-capability-probe.test.mjs`、`tests/platform-capability-probe-route.test.mjs`
- Bitget 产品：`app/private/api/diagnostics/bitget-products/route.ts`；`tests/bitget-product-evidence.test.mjs`
- Binance 定期产品：`app/private/api/diagnostics/binance-locked-products/route.ts`；`tests/binance-locked-product-diagnostic-route.test.mjs`
- Binance 活期档位：`app/private/api/diagnostics/binance-usdc-tiers/route.ts`；`tests/binance-usdc-tier-diagnostic-route.test.mjs`
- Bitget USDGO：`app/private/api/diagnostics/bitget-usdgo/route.ts`；`tests/bitget-usdgo-probe-route.test.mjs`

添加、改名或删除诊断入口时，同步更新本索引和对应测试；若专项探针不再使用，应在同一变更中审查并移除其路由、实现和测试，避免留下无法解释的入口。
