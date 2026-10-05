# 平台 APR 与额度规则台账

核对日期：2026-10-05。范围：活期/定期 Earn 的利率含义、梯度和金额额度。此文分开记录官方规则、项目现有代码和仍需实际回包确认的部分；**它不是本次运行时代码变更说明**。

## 汇总表：API 回了什么、我们怎么理解、会怎样影响指标

本表按用户要求统一为四列。证据来源分清三种：浏览器直接看到的公开 JSON、用户运行的脱敏应用诊断、以及只记录请求状态/条数的 Worker 日志。它们不能互相冒充。

| 平台／产品／币种 | API 实际返回了什么 | 利率与额度怎么理解 | 对高息额度、首档指标的影响 |
|---|---|---|---|
| Binance Global / Bahrain 活期：USDT、USDC、BTC、USDGO | 11:51 左右的脱敏诊断字段：USDT 有基础 `latestAnnualPercentageRate=2.768876%` 和 0–1,000 USDT 的 `tierAnnualPercentageRate=4%`；USDC 有基础 APR `2.231321%`、未报奖励档；BTC 有基础 APR 和有限额奖励档；USDGO 请求成功但没有产品行。不是原始完整 JSON。 | Binance 官方说明：基础实时 APR 适用于持仓，Bonus Tiered APR 是额外奖励，所以 USDT 首档应按约 2.768876% + 4% = 6.768876% 理解；奖励档以外仍按基础 APR。没有奖励档表示本次没报额外奖励，不表示基础 APR 缺失，也不表示申购不限额。 | USDT 已知 0–1,000 的总 APR 超过 6%，名义高息上限为 1,000，剩余量还要扣同产品的已知持仓；USDC 当前 APR 低于 6%，没有高息额度；BTC 具体档值须看原样本，不能在此臆算；USDGO 本次无产品行，不参与。缺额度字段不能显示“不限”。 |
| Binance Global / Bahrain 定期：USDT、USDC、BTC、USDGO | Worker 日志显示 Global 产品列表 103 行、Bahrain 93 行且请求完整；但日志不含逐条原始利率/额度字段。 | 官方产品列表字段需要按具体产品区分基础收益、额外奖励、申购量和售罄状态；不能因接口成功就假定每行字段齐全。 | 目前不能可靠算哪些定期产品达到 6%、首档额度是多少；需拿到脱敏产品字段样本后才能把它们纳入高息和首档指标。 |
| Bybit Global 活期：USDT、USDC、BTC | 本轮内嵌浏览器实际打开 `/v5/earn/product?category=FlexibleSaving`，完整返回 251 行（`retCode=0`，18:01:03 GMT+8）。USDT 顶层 2.3%，0–200 为 7.3%，200 至 `max=-1` 为 2.3%；USDC 顶层 2.23%，0–200 为 5.23%，之后 2.23%；BTC 顶层 0.1%，0–0.003 为 0.4%，之后 0.1%。 | 用户已确认梯度值是每档最终利率，不是额外奖励，所以不再加顶层 APR；回包也显示顶层 APR 与末档相同。`maxStakeAmount` 是最大申购量；`remainingPoolAmount` 虽然也返回，但当前官方活期字段资料没有定义其范围。梯度里的 `max=-1` 确实返回了；定期文档明确同类标记含义，但活期字段文档未单独定义。 | 首档分别是 7.3%/200、5.23%/200、0.4%/0.003。按现行 6% 门槛，只有 USDT 首档属于高息，名义高息额度最多 200（剩余要扣该产品持仓）；USDC、BTC不计高息。所有首档 APR 和金额边界均可比较；是否把活期 `-1` 认作开放末档，建议暂按 API 哨兵值处理、明确记录为“活期文档未明说”，且不得因此把整个产品可买额度显示为不限。 |
| Bybit EU 活期：USDT、USDC、BTC | 本轮内嵌浏览器实际打开 EU 同一接口，完整返回 20 行（`retCode=0`，18:01:09 GMT+8）。三者分别为 1.4%、1.02%、1.2%，`tierAprDetails=[]`；API 同时返回 `maxStakeAmount` 和 `remainingPoolAmount`。 | 用户确认 EU 这几项没有梯度，是单档产品；因此有效顶层 APR 就是这一个档位的利率，不是 API 缺失，也不代表无限额度。公开资料把 `maxStakeAmount` 说明为申购上限；`remainingPoolAmount` 的账号/产品范围未确认。 | 三种币的单档 APR 都低于 6%，当前没有高息额度；持仓收益可按单一 APR 估算。可列出单档 APR，但因申购上限和剩余量不是已确认的账号剩余额度，不把它当作“尚可买入数量”或不限额。 |
| Bybit Global 定期：USDT、USDC、BTC、USDGO | 旧 Worker 日志有 11 条产品行，但只记录状态和裁剪摘要；本轮直接打开定期 JSON 仍被内嵌浏览器本地拦截。 | 官方 Global 定期文档规定 `tieredApyList` 的每档 APY，`max="-1"` 明确表示该档无上限；`interestCoinApyList` 可能是另一奖励币种，不能把不同币种的 APY 直接相加。 | 规则可按官方字段解释，但本次没有原始产品行，无法核对这四种币当前档位或达到 6% 的额度；这些产品先不进入可信高息/首档合计。 |
| Bybit EU 定期：USDT、USDC、BTC、USDGO | 旧日志无 EU 定期行；本轮直接打开 EU 定期 JSON 被浏览器本地拦截。 | 没有 EU 独立 Earn 字段说明，也没有当前实际产品回包。不能把 Global 的实际产品清单冒充 EU 回包。 | 该地区定期首档和高息额度暂不计算；需要用户以后提供一次 EU 产品 JSON，才可补实测字段。 |
| Bitget Global 活期：USDT、USDC | 用户运行的只读产品诊断返回 USDT 6 行、USDC 3 行。`apyType=single` 的例子：USDT 10%、USDC 8%，各有 0–10,000,000 的 APY 范围；normal ladder：USDT 0–300 为 8.02%、300–120,000,000 为 3.36%；USDC 0–300 为 6.66%、300–1,000,000 为 1.87%。另有 VIP 产品，均是不同产品 ID。 | `apyType=single` 是单利率，`ladder` 才是梯度；`currentApy` 是接口给出的各产品／档位 APY，没有第二个基础利率可加。VIP 与 normal 是不同产品，不能把两行相加。`singleMaxAmount` 是单笔申购最大值；`remainingAmount` 的统计范围未定义，不等同持仓或确定的全局剩余额度。 | USDT 10% 单利率产品、USDC 8% 单利率产品，以及两币 0–300 的 normal 梯度均超过 6%；其已知 APY 范围可识别，但可用余额要按具体产品的实际持仓扣减。VIP 产品单列且须满足资格；不能把 `remainingAmount` 当剩余额度，也不能把 single 误标成“缺梯度”。 |
| Bitget Global 定期：USDT、USDC、BTC、USDGO | 用户只读诊断：USDT 有 normal 7 天 1.30%、VIP 7 天 3.00%、VIP 14 天 3.20% 的 single 产品；USDC、BTC、USDGO 本次没有定期行。详情抽样仅查到 USDT normal 7 天。 | `currentApy` 是该独立产品的 APY；每个 single 产品本身不需要梯度。额度详情里的 `singleMaxAmount` 是单笔上限，`remainingAmount` 范围未定义。 | 这些 USDT 定期样本都低于 6%，不计高息额度；已知单一 APY 可展示，但这组样本没有高息首档。USDC/BTC/USDGO 只是本次无返回，不代表平台永久不支持。 |
| OKX 普通 Earn、MEXC Earn | 当前项目没有可用的普通 Earn 产品 APR 接口；没有发出产品 API 请求。 | “项目没接入”不是“交易所没有产品”，也不是一次成功空返回。 | 当前无法从 API 计算这些平台的高息额度或首档；若要纳入，需先单独接入产品资料来源。 |

此前应用诊断的时间约为 **2026-10-05 11:51 GMT+8**；本轮 Bybit 活期接口响应的服务器时间为 **18:01 GMT+8**。Worker 请求日志中的 `outcome=ok` 或行数只证明请求流程/列表读取状态，不能证明日志里没有记录的原始 APR、额度字段。

## 本轮浏览器重查结果

代理恢复后，我在 Codex 内嵌浏览器直接读取了 Bybit Global 与 EU 的活期公开 JSON；两边都成功返回 `retCode=0`，没有读取持仓、调用写入接口或改动生产数据。Global 返回 251 行，EU 返回 20 行。用户确认 Global 的 `tierAprDetails` 数值是每档最终利率而不是额外奖励；用户也确认 EU 这三种币的空梯度是单档产品。

Global 与 EU 的定期产品 URL 本轮各自重试后仍显示浏览器本地拦截（`ERR_BLOCKED_BY_CLIENT`），所以这不是交易所返回的失败。按用户要求不再循环尝试：Global 暂用旧日志中“11 行”这一有限证据，但日志没有原始产品字段；EU 定期仍无当前返回证据。两个定期接口的实际字段待用户以后提供 JSON。

Global 活期的梯度首档从 0 起且连续，末档原始 `max` 是 `-1`；顶层 `estimateApr` 与末档值相同。EU 则是有效 APR 加空梯度，经用户确认是单档。两边都返回了 `maxStakeAmount` 和 `remainingPoolAmount`；前者是最大申购量，不是账号当前剩余可买金额，后者的统计范围没有在本次查到的官方字段资料中定义。Global 活期梯度 `max=-1` 可暂作为“该利率档没有列出有限上界”的 API 哨兵值，但不能等同于整款产品对单个用户不限额；这是样本推断，不是活期官方明文。

### Bitget 当前回包与官方字段对照

用户从已登录的 Bitget 产品诊断入口提供了实际回包。诊断对 USDT、USDC、BTC、USDGO 各读一次 `/api/v2/earn/savings/product?filter=available_and_held`，再抽取可用的产品形状代表读取最多 4 条 `/api/v2/earn/savings/subscribe-info`；本次共 7 次请求，没有调用 `/savings/assets` 等持仓接口，也没有写入数据。

| 当前账号返回的产品 | 回包中的 APY 形状 |
|---|---|
| USDT 活期，normal，single | 一个 `currentApy=10%` 的区间，0–10,000,000 |
| USDT 活期，normal，ladder | 0–300 为 8.02%；300–120,000,000 为 3.36% |
| USDT 活期，VIP，ladder | 0–300,000 为 4%；300,000–50,000,000 为 2.88% |
| USDT 定期，7 天 normal / 7 天 VIP / 14 天 VIP，均 single | 分别为 1.30%、3.00%、3.20%；各自只有一个 APY 区间 |
| USDC 活期，normal，single | 一个 `currentApy=8%` 的区间，0–10,000,000 |
| USDC 活期，normal，ladder | 0–300 为 6.66%；300–1,000,000 为 1.87% |
| USDC 活期，VIP，single | 一个 `currentApy=2.28%` 的区间，0–10,000,000 |
| BTC、USDGO | 请求成功，`available_and_held` 查询范围内无产品行；只代表当前账号/本次响应为空 |

所有返回产品状态都是 `in_progress`。官方文档明确 `apyType=single` 是单一利率、`ladder` 是梯度；实际回包显示 single 也有一个 `apyList` 区间。因此不能把 single 的“一档”误判为阶梯缺档。API 没有另一个基础 APR 字段供相加；当前证据支持把每条产品自身 `currentApy` 当作其单一/对应档的 APY，不把 normal 与 VIP 两个不同产品的 APY 相加。

本次三个 `subscribe-info` 代表样本为 USDT 活期 single、活期 ladder、7 天定期 single。它们分别返回 `singleMaxAmount`（0.1–10,000,000 / 0.1–120,000,000 / 1–5,000,000）与 `remainingAmount`。官方把 `singleMaxAmount` 定义为“单笔申购最大值”，所以它不是用户累计持仓或产品总上限。`remainingAmount` 的官方描述仅为 “Amount held remaining”，没有说明统计对象；官方示例还出现 `remainingAmount=4,899.999990` 大于 `singleMaxAmount=2,000`，足以证明二者不是同一个“单笔最大值”口径，但不足以判断剩余额度属于全产品池还是当前账号。当前用户回包里的 `remainingAmount` 也不能反推实际持仓。诊断没有请求 `/savings/assets`，`includesHoldingAmounts=false` 只表示没有返回 `holdAmount` 持仓明细；`remainingAmount` 仍可能随该账号当前可用额度变化，因此不能把报告说成完全不含账户相关信息。

官方文档列出 `apyList` 的 `minStepVal`、`maxStepVal`、`currentApy`，但没有说明有限末档以后是否继续适用该档，也没有给出通用的“末档无限”标记。因此当前样本能证明这些范围内的档位连续且可解析，不能据此声称超过末档的金额仍适用末档 APY 或可无限申购。VIP 行是独立产品报价；`productLevel=VIP` 说明资格需要另行确认，不是 normal 利率的附加奖励。

## 先分清两件事

1. **利率规则**：产品是单一利率，还是不同金额档对应不同利率？若存在额外奖励，是否官方明确说它要加在基础利率上？
2. **申购额度**：每个利率适用于多少本金、产品/用户最多能申购多少、剩余额度是多少？

没有 APR 梯度，不必然代表 APR 缺失；反过来，缺少梯度也不代表不限额。单一 APR 可以支持“已持有金额的收益估算”，但只有额度规则明确时，才能算剩余额度。不要用一个 `complete/partial` 标记同时表达这两件事。

## 早期文字摘要（有冲突时以上方四列表和下方规则为准）

此处旧摘要保留来源背景；它写于本轮直接重查 Bybit 活期之前。Bybit Global 梯度是否为最终 APR、EU 空梯度是否为单档，现以用户线上确认和上方四列表为准；定期页面拦截不是交易所 API 报错。

<details><summary>旧版平台摘要（已更新，默认折叠；当前结论看上方四列表）</summary>

| 平台 | 官方资料确认的利率口径 | 没有梯度时怎么理解 | 尚未确认/不能推断的事 |
|---|---|---|---|
| Binance Simple Earn 活期 | Binance 将 Flexible 收益分成实时 APR 和可选的 Bonus Tiered APR；官方说明 Bonus Tiered APR 是叠加在实时 APR 之上的额外奖励。项目诊断中的 USDT 样例也同时返回 `latestAnnualPercentageRate=2.768876%` 和 `tierAnnualPercentageRate` 的 `0–1000 USDT=4%`，与“基础 2.768876% + 该档额外 4%”吻合。因此，该档预期总 APR 为约 6.768876%；超出活动档的部分只按实时 APR 估算。 | `latestAnnualPercentageRate` 有效而 `tierAnnualPercentageRate` 未返回时，基础实时 APR 仍有效；视为本次没有额外梯度奖励，而不是产品 APR 缺失。 | 梯度奖励的最高金额不是产品申购总上限。没有梯度不能推出“可无限申购”。接口文档列出 APR 字段，但没有在字段描述中逐字说明两个字段的相加关系；相加依据是 Binance 对两类奖励的说明和项目 USDT 实际样例。地区、账户资格、奖励是否仍在活动期也会影响用户实际到账。 |
| Bitget Classic Savings | 官方产品列表以 `apyType=single/ladder` 声明利率形状；本次真实回包中 `apyList[].currentApy` 是对应单利率或金额档的 APY，没有另一个基础 APR 字段可加。不同 `productLevel` 是独立报价，不是叠加奖励。 | 真实回包证实 `single` 会返回一个 APY 区间，属于单一利率，不是梯度缺失；`ladder` 才要逐档检查。空列表仍不能靠猜测判不限额或完整。 | 官方明确 `singleMaxAmount` 是单笔上限；`remainingAmount` 仅称剩余金额。本次拿到了 USDT 三种代表产品的实际订阅详情，但文档和样本都不能确定 `remainingAmount` 是全产品池、账号可订金额还是其他统计范围。例行同步尚未使用它。 |
| Bybit Global (`api.bybit.com`) 活期 | 官方 `GET /v5/earn/product` 文档明确列出 `estimateApr`（动态估算值），并说明该字段不显示 Platform Reward APR；**该官方字段表没有列出 `tierAprDetails`**。本轮用户提供的当前 API 回包则确认 USDT、USDC、BTC 都返回了 `tierAprDetails`，首档 APR 分别为 7.3%、5.23%、0.4%，后续档回到顶层 `estimateApr`。 | 这三份回包明确是有档位的产品；不能把“官方字段表没列”当成“API 没返回”。本批数据的梯度完整且连续，但规则暂不据此推广到未来所有产品/回包。 | 官方活期文档没有定义 `tierAprDetails` 的 APR 是最终档利率还是额外奖励，也没有说明活期 `max=-1`。顶层估算值等于最后一档值，支持“不再把顶层 APR 加到各档”的解释，但尚不是官方明文规则。`maxStakeAmount` 是最大申购金额，不是实时剩余量。 |
| Bybit 定期（Global / EU） | 官方 `GET /v5/earn/fixed-term/product` 提供 `tieredApyList[]`，每档有 `min`、`max`、`apy`；其中 `max="-1"` 明确表示该档没有上限。它就是你记得的“能拿到完整阶梯”的接口，适用于**定期产品**，不是活期 `/v5/earn/product`。若没有阶梯，接口也可能通过 `interestCoinApyList[].apy` 返回单一/奖励币种 APY；需按币种和产品规则确认如何汇总，不能把不同币种 APY 直接相加。 | 空 `tieredApyList` 不等于 APR 缺失：若 `interestCoinApyList` 提供可用 APY，就是单一 APY；两者都没有可用利率才是 APR 缺失。 | `max="-1"` 是官方明确不限额标记；普通空值/空数组不是。Global 文档说明字段语义；项目 2026-10-04 的能力检查也曾通过 EU 主机拿到定期产品行。但 EU 没有独立的 Earn 字段文档，若要确认 EU 当前返回细节仍应看一次 EU 实际样本。 |
| Bybit EU (`api.bybit.eu`) 活期 | 项目代码使用 EU 主机请求 `/v5/earn/product`，Global 与 EU 共用解析器。用户提供的当前 API 回包确认 USDT 1.4%、USDC 1.02%、BTC 1.2%，三者都有顶层估算 APR、但 `tierAprDetails` 为空。 | 对这三条回包，APR 数值可用；空梯度本身不能当成“APR 缺失”或“不限额”。容量需独立判断。 | EU 没有找到独立 Earn 字段文档。当前回包能证实 API 确实不返回梯度，但无法单凭空数组判断 EU 产品本来就是单利率，还是梯度字段不适用于 EU；也不能确认 EU 与 Global 的 APR 资格和额度语义完全相同。 |

</details>

来源：

- Binance [Simple Earn Flexible 产品说明](https://www.binance.com/en/support/faq/detail/3bd1a6eba20a445da1e94bf6cfa52e80)（实时 APR 适用于全部申购金额；Bonus Tiered APR 为选定产品的额外奖励）和 [Simple Earn REST API：Flexible & Locked](https://developers.binance.com/en/docs/catalog/investment-and-services-simple-earn/api/rest-api/flexible-locked)（产品/持仓回包字段）。
- Bitget [Classic Earn Savings API](https://www.bitget.com/docs/catalog/earn-classic-savings/classic-earn-savings)（`apyType`、`apyList`、`currentApy`）。
- Bybit [Get Product Info](https://bybit-exchange.github.io/docs/v5/finance/earn/easy-onchain/product-info)（`estimateApr`、申购金额字段、Platform Reward APR 说明）；Bybit EU [如何获取 EU API 文档](https://www.bybit.eu/en-EU/help-center/article/How-to-retrieve-API-documentations)及其链接的 [PSD2/XS2A 文档](https://bybit-exchange.github.io/eu-docs/fin)（后者不是 Earn 产品字段文档）。
- Bybit 定期 [Get Product Info](https://bybit-exchange.github.io/docs/v5/finance/earn/fixed-saving/product)（`tieredApyList`、每档 APY、`max="-1"` 明确不限额）。

本轮复核更正：上方“早期文字摘要”仅作历史记录，凡与首页四列表、本段规则相冲突的地方都不再作为当前结论。当前结论是：Bybit Global 活期各档值按最终 APR；Bybit EU 这三种币为空梯度是有效单档；Bybit 活期 `max=-1` 只暂按开放末端处理、不推断账号总额度无限。Global/EU 定期页面本轮仍被本地浏览器拦截，不能把这说成交易所拒绝请求。

## 当前建议的统一处理规则

这些是按已取得的官方说明、真实回包和用户线上确认整理的实施规则；它们不是“任何接口只要返回一些数字就算完整”。

1. **先判断请求有没有读全，再判断字段够不够用。** `retCode=0`、请求成功、所有分页读完，只能说明列表请求读成功；不能自动说明利率/额度业务字段完整。成功但没有产品行记为“本次空列表”，不要当请求失败，也不要据此推断平台永久不支持。请求错误或分页不完整保留上次数据，不把空白覆盖成零。
2. **APR 按平台字段含义，不看字段名字猜。** Binance 活期用“基础实时 APR + 适用金额档的 Bonus APR”；Bitget `apyType=single` 是一个 APY，`ladder` 的每个 `currentApy` 是该档 APY；Bybit Global 活期梯度按每档最终 APR 使用，不再加顶层 APR；Bybit EU 这几种币空梯度按用户确认视作有效单档 APR。Bybit 定期的 `tieredApyList[].apy` 是该档 APY。若奖励以不同币种发放，没有同一资产计价的官方总收益率时，不把多个币种的 APY 直接相加。
3. **“没返回梯度”逐平台判断，不套一个全平台口径。** Binance 有有效基础 APR、但没返回 bonus 档＝基础 APR 仍能用于持仓估算，本次额外奖励为零/未报；Bitget 明确 `single`＝正常单利率；Bybit EU 本次空数组＝已确认的单档产品。其他产品没有梯度字段、又没有 `single` 类型或线上产品说明佐证时＝“梯度形状未确认”，不是“不限额”，也不要造一条无限档。
4. **APR 可用与额度可用分开。** 有可信单档 APR，可按已知持仓估算收益；但剩余额度只有在“这档适用的本金边界已知、同一产品持仓已知、上限范围清楚”时才算。已知 APR 但额度未知时，收益估算可以保留，产品不计入高息剩余额度/首档可买额度，也不显示“不限”。
5. **首档和高息额度只按 API 明确的金额档算。** 本项目的高息线是 APR ≥6%；定期另受期限筛选。对每个 APR ≥6% 的档，只算它的已知金额上限，减去该产品中已经占用的对应额度；已知持仓超过首档上限时，剩余首档额度为零。不得用一个产品的其他档、VIP 产品或币种总持仓来代替。
6. **上限只有明确证据才叫“不限”。** Bybit 定期文档的 `max="-1"` 明确表示不限档。Bybit 活期本轮回包也用 `max=-1`，建议暂把它识别为“该档开放末端”的哨兵值，但台账保留“活期字段未被官方文档定义”；它不代表 `maxStakeAmount` 或用户可申购量无限。Binance 没有奖励档、Bitget 空梯度、`max: null`、`remainingAmount` 或 `remainingPoolAmount` 的单独出现，都不等于不限。
7. **梯度完整要看整段，不是“解析出一档就通过”。** 保留 API 原档数与解析成功数；每档 APR 和上下界都要可读；首档起点正确；档与档无缺口、无重叠。有限末档只能确认已知范围内的利率；除非平台文档/明确产品类型说明梯度已经覆盖整个申购范围，否则末档后仍标“未确认”，不向外推算。

### 按规则算出的本轮样例

| 样例 | 规则落地结果 |
|---|---|
| Binance USDT 活期，基础 2.768876%，0–1,000 额外奖励 4% | 首档总 APR 6.768876%，是高息；名义高息档上限 1,000 USDT，减该产品已知持仓后才是剩余量。 |
| Binance USDC 活期，基础 2.231321%，没有 bonus 档 | APR 有效，仍能估算已持仓收益；低于 6%，无高息档，不可把空 bonus 档解释成无限申购。 |
| Bybit Global USDT 活期，首档 0–200 为 7.3% | 按最终档 APR，不加 2.3%；首档为高息，名义上限 200 USDT，剩余量需扣同产品持仓。 |
| Bybit Global USDC / BTC 活期 | 首档 APR 分别 5.23% / 0.4%，低于 6%，不计高息额度；仍可显示 APR 和首档边界。 |
| Bybit EU USDT / USDC / BTC 活期 | 经用户确认是单档，APR 有效（1.4% / 1.02% / 1.2%）；均低于 6%，持仓收益可估算，但 `maxStakeAmount` 不等于账号剩余额度。 |
| Bitget USDT、USDC 活期 | `single` 与 `ladder` 按不同产品分别看；normal USDT 10% single、USDT 8.02% 首档、USDC 8% single、USDC 6.66% 首档均达到 6%。扣持仓须按各自产品 ID，不用 `remainingAmount` 替代持仓。 |

## 当前代码与风险

- **Binance**：`lib/integrations/binance.ts` 当前把 `tierAnnualPercentageRate` 当成该金额档的最终 APR，没有加上 `latestAnnualPercentageRate`；没有梯度时仍保留基础 APR，但标为 `base_only`。这与 Binance 的两部分奖励口径不一致，可能低估活动档收益；而 `base_only` 还会让已知 APR 被当作资料不完整。须修正成“实时 APR + 对应档的额外奖励”，并把 APR 可用性和额度可用性拆开。
- **Bitget**：`lib/integrations/bitget.ts` 目前没有按 `apyType` 分支；它把解析到的 `apyList` 当作金额档。当前真实样本证明 `single` 会带一个 APY 区间，因此本身不应被报成“缺梯度”；`ladder` 则要检查整段边界。现有 `normalizeTiers` 只保留可解析的利率、排序后返回，不验证全部原始档都成功解析、首档是否从 0 起、档间是否连续/重叠，也可能把无效上限压成 `max: null`。因此一条有效档就可能被当成完整，未知末端也可能被误看成不限；这类算法变更留待各平台证据和统一口径确认后再做。
- **Bybit Global / EU**：代码把 `tierAprDetails[].estimateApr` 当作各金额档的 APR，存在梯度时用首档 APR 作为产品 APR，不会再把顶层 `estimateApr` 加到每个梯度上；空梯度时则保留顶层估算 APR。当前这两份回包中 Global 三币梯度连续，EU 三币均为空但顶层 APR 有效。实现风险仍在：`parseBybitTiers` 会丢弃坏档，只要余下一档就可能标成 `complete`，没有校验全段连续、不重叠或首档从 0 起。并且代码把活期 `max=-1` 解释为 unlimited；目前这次实测与固定期限文档用法相似，但官方活期字段文档没有明确写出该规则，最终应记录为“样本观察 + 代码假设”，不能冒充活期官方定义。
- **Bitget**：例行同步仍只用产品列表 `apyList`，没有把 `subscribe-info.remainingAmount` 纳入计算；本次只读诊断已拿到 USDT single、ladder、7 天 fixed 的样本。因为官方只称其为剩余金额，尚不能用它代表全站额度或用户实际持仓。现有 `normalizeTiers` 只保留可解析利率，不检查所有原始档、连续性或覆盖末端，也可能把空/坏边界压成 `max: null`。
- **Bybit 定期**：`lib/integrations/bybit.ts` 读取 `tieredApyList`，知道 `max="-1"` 表示明确不限额；若没有该列表，再从 `interestCoinApyList` 兜底。当前 `interestCoinApyList` 多币种 APY 会被相加，适用前应核实奖励币种是否可折算/是否应纳入产品 APR，不能把不同币种的 APY 当成同一币种利率直接求和。

## 统一情况判定表

| 收到的情况 | 产品/利率判定 | 已持有收益估算 | 剩余额度/容量指标 |
|---|---|---|---|
| 明确是单一利率且该数字有效（如 Binance 实时基础 APR；Bitget 回包 `apyType=single`） | 利率可用；没有多档是正常形状 | 可按单一利率估算 | 单独看是否有产品/高息档额度；未知不能写成不限 |
| 明确是阶梯产品，且第一档从 0 起、所有档边界连续不重叠、每档利率有效、末档明确封顶或有平台文档支持的不限标记 | 梯度完整 | 按每档实际金额计算；只有平台规则确认叠加时才加奖励 | 逐档计算未使用的合格额度；若接口还提供当前剩余额度，先核实范围再与账户可用额度取较小值 |
| 明确是阶梯产品，但任一返回档解析失败，或档间缺口/重叠，或末档去向不明 | 梯度不完整；保留原始失败原因，不可因为剩一档就标完整 | 不外推缺失档位的利率 | 不将该产品计入“已知高息剩余额度”合计，也不显示不限 |
| Binance `latestAnnualPercentageRate` 有效，但 `tierAnnualPercentageRate` 缺失 | 基础实时 APR 有效；按“本次没有额外奖励梯度返回”处理，不是 APR 缺失，也不能凭空造一条无限档 | 按基础 APR 估算；若产品页面/后续 API 证明本应有奖励档，再标记产品 API 数据不一致 | 只按基础 APR 是否达到高息门槛判断；若门槛达到但申购上限未知，容量未知，不显示不限 |
| Bitget `apyType=single` 且单一 APY 可解析 | 单利率可用；不要求梯度 | 可计算 | 仍需产品可用余额/明确额度；`singleMaxAmount` 只是单笔限制，不等同总剩余额度 |
| APR 数字缺失/不可解析，或接口没有足够字段判定利率形状 | APR 待获取/资料不完整 | 不计算 | 不计算 |
| APR 清楚，但最大申购量/剩余可售额未知 | 利率可用，额度未知（不是 API 失败） | 仍可按适用利率估算已持仓 | 只从额度汇总中排除该产品；不推断不限额 |
| 接口错误、分页没读完或结果本身不完整 | 本次数据读取失败/部分返回；与产品是否单利率分开 | 沿用可信缓存；无缓存则不新算 | 不把失败当成“额度为零”或“不限” |

注：Binance `tierAnnualPercentageRate` 的已知活动档属于基础实时 APR 之上的额外奖励；Bybit 定期 `tieredApyList[].apy` 则是该金额档本身的 APY。字段叫法相似不代表平台含义相同。

## 尚未补齐的实测证据

若要排查“是不是某个币种/地区回包不同”，需要覆盖项目实际支持的资产；不必索取每个产品的全部账户数据，也不要运行全平台能力扫描：

- Bitget：四币产品列表和 USDT/USDC APY 档位已足以完成本轮利率形状盘点；不必再查 USDC `subscribe-info`，因为 `remainingAmount` 的范围不清，查一条相似详情也不能解决这个口径问题。
- Bybit 活期：Global 与 EU 当前公开列表都已直接读到，覆盖项目支持的 USDT、USDC、BTC；此项已完成，不需要再重复请求。规则建议见上文：每档值按最终 APR；EU 空梯度按已确认单档；Global `max=-1` 暂作开放档哨兵，但不推断账号不限额。
- Bybit 定期：项目支持 USDT、USDC、BTC、USDGO。Global 旧日志只证明有 11 行产品，不含原始字段；EU 旧日志没有产品行。本轮 Global/EU 直接页面都被内嵌浏览器拦截。尚缺两站各一份公开产品 JSON，用来确认 `coin`、`duration`、`status`、`tieredApyList`、`interestCoinApyList` 和额度字段；用户以后方便时再提供即可。
- Binance 定期：Global/Bahrain 列表虽成功，但 Worker 日志没有逐条利率/额度字段。若要把 Binance 定期也纳入完整的高息和首档计算规则，还需各地区少量脱敏产品字段样本；当前不能从请求成功或行数补推这些字段。
- 暂无必要索取密钥、持仓 JSON 或再跑全平台诊断。只需公开产品字段；不得包含 API 密钥或账户持仓。

这些都是公开产品资料或只读 API 产品资料，不需要持仓金额、用户身份或密钥。直接浏览器若拦截 Bybit API，应记为“本次查看工具受限”，不要误报成交易所 API 故障。
