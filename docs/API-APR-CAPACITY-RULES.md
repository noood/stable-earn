# 平台 APR 与额度规则台账

核对日期：2026-10-05。范围：活期/定期 Earn 的利率含义、梯度和金额额度。此文分开记录官方规则、项目现有代码和仍需实际回包确认的部分；**它不是本次运行时代码变更说明**。

## 本轮证据盘点（先记录事实，不据此定最终计算规则）

此前应用诊断事件的相关样本时间为 **2026-10-05 11:51 GMT+8**。它们是 Worker 同步时记录的脱敏字段摘要，不是完整原始 JSON。本轮另补充了用户从内嵌浏览器取得的 Bybit 当前公开产品回包，服务端时间为 **18:01 GMT+8**；两种证据来源在表中分开标明。

| 平台/地区/产品 | 已看到的样本 | 官方资料对照 | 证据缺口 |
|---|---|---|---|
| Bybit Global 活期 | 用户在内嵌浏览器复制的公开产品回包（服务端时间 2026-10-05 10:01:03Z），列表共 251 项。USDT：`estimateApr=2.3%`，0–200 为 7.3%，200 至 `max=-1` 为 2.3%；USDC：2.23%，0–200 为 5.23%，200 至 `max=-1` 为 2.23%；BTC：0.1%，0–0.003 为 0.4%，0.003 至 `max=-1` 为 0.1%。三项均 Available、`bonusEvents=[]`。回包另有 `maxStakeAmount`：USDT 100,000,000、USDC 200,000,000、BTC 1,500。 | 官方 Global 文档列出动态 `estimateApr`、最大申购额和奖励事件；说明 `estimateApr` 不含 Platform Reward APR，但没有列出 `tierAprDetails`。官方文档称 `maxStakeAmount` 是最大申购金额。 | 实际回包确认了 Global 当前这三种币确实返回梯度；官方活期字段文档没有定义 `tierAprDetails`，也没有明确说明活期梯度里的 `max=-1` 语义或梯度 APR 与顶层 `estimateApr` 的计算关系。`maxStakeAmount` 不是当前剩余可申购额度。 |
| Bybit EU 活期 | 用户在内嵌浏览器复制的公开产品回包（服务端时间 2026-10-05 10:01:09Z），列表共 20 项。USDT `estimateApr=1.4%`、USDC 1.02%、BTC 1.2%；三项均 Available、`tierAprDetails=[]`、`bonusEvents=[]`。`maxStakeAmount` 分别为 1,000,000,000、100,000,000、1 BTC。 | 找到的是 Global Earn 字段文档；没有找到 EU 独立 Earn 字段文档。 | 这次回包证实 EU 三项有可用顶层 APR，但没有梯度字段；这不证明 unlimited，也不证明 APR 无效。仍需确认 EU 对空梯度的产品含义、可用额度口径，以及 Global 文档字段能否完全套用到 EU。 |
| Bybit Global 定期 | 产品接口报告成功、返回 11 条；应用日志把产品行归一化成金额/APY 档摘要。 | 官方文档说明 `tieredApyList`（如适用）逐档给 APY，`max="-1"` 明确表示无上限；也列出 `interestCoinApyList` 多币种奖励 APY。 | 当前日志不是原始字段：无法逐条核对原始 `tieredApyList` / `interestCoinApyList`，也不能由归一化摘要判断不同奖励币是否可直接合并。 |
| Bybit EU 定期 | 本批日志未找到 EU 定期产品事件。 | Global 定期字段文档适用于该接口；EU 没有独立 Earn 字段说明。 | 没有当前 EU 定期 API 回包。项目能力配置记录了 EU 定期公开产品接口，但配置不是这次请求成功的证据。 |
| Binance Global / Bahrain 活期 | 当日上午诊断覆盖 USDT、USDC、BTC、USDGO。USDT 有实时 APR 与 0–1000 USDT 奖励档；USDC 有基础 APR、没有奖励档字段；BTC 有基础 APR 和有限额奖励档；USDGO 请求成功但没有产品行。两个地区样本大体一致。 | Binance 官方 FAQ（2026-09-29 更新）把实时 APR 与 Bonus Tiered APR 说明为两种独立奖励：实时 APR 按整个持仓金额计，奖励 APR 按奖励档和前一日快照、资格等规则计。 | API 字段摘要不是原始完整回包；无 Bonus 档不证明申购不限额。必须区分“收益两部分可叠加”和“整笔本金都适用奖励 APR”。 |
| Binance Global 定期 | 当日上午产品列表完整返回 103 条。 | 官方产品列表有基础 APR、额外奖励、额度及售罄字段；不同字段不能只凭名字合并。 | 现有事件只给整体成功/条数及裁剪后的产品摘要，尚不足以逐条核对原始奖励/梯度字段；Bahrain 定期当前证据也未补齐。 |
| Bitget Global 活期/定期 | 当日上午活期产品摘要看到 USDT、USDC 行；定期产品事件报告成功，共 3 行，样本行均为 USDT。事件中的 APY 档是代码归一化后的结果。 | 官方文档用 `apyType=single/ladder` 区分单利率/阶梯；`apyList[].currentApy` 给各档 APY。`subscribe-info` 另提供 `singleMaxAmount`（单笔上限）和 `remainingAmount`（文档称 Amount held remaining）。 | 日常产品事件没记录 `apyType` 原值，也没调用 `subscribe-info`，故尚不能确认实际单/阶梯标记或 `remainingAmount` 的具体范围；事件没列出 BTC/USDGO 行也不足以单独证明两币本次成功空返回。 |

## 本轮浏览器重查结果

我按要求只用 Codex 内嵌浏览器打开 Bybit Global 与 EU 的公开 USDT 活期接口，两次导航都被浏览器本地拦截（`ERR_BLOCKED_BY_CLIENT`），不是交易所返回的错误，也没有使用 Chrome。用户随后从内嵌浏览器粘贴了两份完整公开产品列表：第一份有 251 项且 USDT/USDC/BTC 均带梯度，和 Global 旧诊断的字段/利率吻合；第二份有 20 项且这三种币均无梯度，和 EU 旧诊断吻合，因此按打开顺序将其对应为 Global、EU。两个回包顶层 `retCode=0`，服务端时间相差约 6 秒。这里记录的是用户实际取得的 API 回包，不是 Worker 事件日志；没有持仓接口或生产 D1 写入。

从这次返回能确定：Global 的梯度首档从 0 起且连续，末档原始 `max` 是 `-1`；顶层 `estimateApr` 与末档值相同。EU 则是 APR 有效、梯度数组为空。两边的 `maxStakeAmount` 都有数值，但文档把它定义为最大申购额，并非实时剩余可售额度。仍不能仅靠官方活期文档断定 Global 梯度中的 `-1` 语义或是否应把顶层 APR 再加到各梯度；官方字段表没有描述 `tierAprDetails`。固定期限接口文档对自己的 `tieredApyList.max="-1"` 明确写了无上限，但不能自动把该说明当成活期接口对 `tierAprDetails` 的正式定义。

## 先分清两件事

1. **利率规则**：产品是单一利率，还是不同金额档对应不同利率？若存在额外奖励，是否官方明确说它要加在基础利率上？
2. **申购额度**：每个利率适用于多少本金、产品/用户最多能申购多少、剩余额度是多少？

没有 APR 梯度，不必然代表 APR 缺失；反过来，缺少梯度也不代表不限额。单一 APR 可以支持“已持有金额的收益估算”，但只有额度规则明确时，才能算剩余额度。不要用一个 `complete/partial` 标记同时表达这两件事。

## 分平台规则与证据

| 平台 | 官方资料确认的利率口径 | 没有梯度时怎么理解 | 尚未确认/不能推断的事 |
|---|---|---|---|
| Binance Simple Earn 活期 | Binance 将 Flexible 收益分成实时 APR 和可选的 Bonus Tiered APR；官方说明 Bonus Tiered APR 是叠加在实时 APR 之上的额外奖励。项目诊断中的 USDT 样例也同时返回 `latestAnnualPercentageRate=2.768876%` 和 `tierAnnualPercentageRate` 的 `0–1000 USDT=4%`，与“基础 2.768876% + 该档额外 4%”吻合。因此，该档预期总 APR 为约 6.768876%；超出活动档的部分只按实时 APR 估算。 | `latestAnnualPercentageRate` 有效而 `tierAnnualPercentageRate` 未返回时，基础实时 APR 仍有效；视为本次没有额外梯度奖励，而不是产品 APR 缺失。 | 梯度奖励的最高金额不是产品申购总上限。没有梯度不能推出“可无限申购”。接口文档列出 APR 字段，但没有在字段描述中逐字说明两个字段的相加关系；相加依据是 Binance 对两类奖励的说明和项目 USDT 实际样例。地区、账户资格、奖励是否仍在活动期也会影响用户实际到账。 |
| Bitget Classic Savings | 官方产品列表以 `apyType=single/ladder` 声明利率形状；`apyList[].currentApy` 是对应金额区间的 APY，没有另一个基础 APR 字段可加。 | 只有实际回包的 `apyType` 才能区分单利率与阶梯。`single` 即使只有一档也不是“梯度不完整”；`ladder` 则必须检查每档。空 `apyList` 不能靠猜测判成不限额或完整。 | 产品列表字段给出梯度，但“订阅详情”接口另有 `singleMaxAmount`（单笔上限）、`remainingAmount`（文档称剩余可持有金额）和 `apyList`。`remainingAmount` 是剩余额度的关键候选来源，但还需用一条当前产品回包确认它的具体范围，以及是否代表全产品剩余、用户剩余或两者中的较小值。当前代码尚未请求这个接口。 |
| Bybit Global (`api.bybit.com`) 活期 | 官方 `GET /v5/earn/product` 文档明确列出 `estimateApr`（动态估算值），并说明该字段不显示 Platform Reward APR；**该官方字段表没有列出 `tierAprDetails`**。本轮用户提供的当前 API 回包则确认 USDT、USDC、BTC 都返回了 `tierAprDetails`，首档 APR 分别为 7.3%、5.23%、0.4%，后续档回到顶层 `estimateApr`。 | 这三份回包明确是有档位的产品；不能把“官方字段表没列”当成“API 没返回”。本批数据的梯度完整且连续，但规则暂不据此推广到未来所有产品/回包。 | 官方活期文档没有定义 `tierAprDetails` 的 APR 是最终档利率还是额外奖励，也没有说明活期 `max=-1`。顶层估算值等于最后一档值，支持“不再把顶层 APR 加到各档”的解释，但尚不是官方明文规则。`maxStakeAmount` 是最大申购金额，不是实时剩余量。 |
| Bybit 定期（Global / EU） | 官方 `GET /v5/earn/fixed-term/product` 提供 `tieredApyList[]`，每档有 `min`、`max`、`apy`；其中 `max="-1"` 明确表示该档没有上限。它就是你记得的“能拿到完整阶梯”的接口，适用于**定期产品**，不是活期 `/v5/earn/product`。若没有阶梯，接口也可能通过 `interestCoinApyList[].apy` 返回单一/奖励币种 APY；需按币种和产品规则确认如何汇总，不能把不同币种 APY 直接相加。 | 空 `tieredApyList` 不等于 APR 缺失：若 `interestCoinApyList` 提供可用 APY，就是单一 APY；两者都没有可用利率才是 APR 缺失。 | `max="-1"` 是官方明确不限额标记；普通空值/空数组不是。Global 文档说明字段语义；项目 2026-10-04 的能力检查也曾通过 EU 主机拿到定期产品行。但 EU 没有独立的 Earn 字段文档，若要确认 EU 当前返回细节仍应看一次 EU 实际样本。 |
| Bybit EU (`api.bybit.eu`) 活期 | 项目代码使用 EU 主机请求 `/v5/earn/product`，Global 与 EU 共用解析器。用户提供的当前 API 回包确认 USDT 1.4%、USDC 1.02%、BTC 1.2%，三者都有顶层估算 APR、但 `tierAprDetails` 为空。 | 对这三条回包，APR 数值可用；空梯度本身不能当成“APR 缺失”或“不限额”。容量需独立判断。 | EU 没有找到独立 Earn 字段文档。当前回包能证实 API 确实不返回梯度，但无法单凭空数组判断 EU 产品本来就是单利率，还是梯度字段不适用于 EU；也不能确认 EU 与 Global 的 APR 资格和额度语义完全相同。 |

来源：

- Binance [Simple Earn Flexible 产品说明](https://www.binance.com/en/support/faq/detail/3bd1a6eba20a445da1e94bf6cfa52e80)（实时 APR 适用于全部申购金额；Bonus Tiered APR 为选定产品的额外奖励）和 [Simple Earn REST API：Flexible & Locked](https://developers.binance.com/en/docs/catalog/investment-and-services-simple-earn/api/rest-api/flexible-locked)（产品/持仓回包字段）。
- Bitget [Classic Earn Savings API](https://www.bitget.com/docs/catalog/earn-classic-savings/classic-earn-savings)（`apyType`、`apyList`、`currentApy`）。
- Bybit [Get Product Info](https://bybit-exchange.github.io/docs/v5/finance/earn/easy-onchain/product-info)（`estimateApr`、申购金额字段、Platform Reward APR 说明）；Bybit EU [如何获取 EU API 文档](https://www.bybit.eu/en-EU/help-center/article/How-to-retrieve-API-documentations)及其链接的 [PSD2/XS2A 文档](https://bybit-exchange.github.io/eu-docs/fin)（后者不是 Earn 产品字段文档）。
- Bybit 定期 [Get Product Info](https://bybit-exchange.github.io/docs/v5/finance/earn/fixed-saving/product)（`tieredApyList`、每档 APY、`max="-1"` 明确不限额）。

## 当前代码与风险

- **Binance**：`lib/integrations/binance.ts` 当前把 `tierAnnualPercentageRate` 当成该金额档的最终 APR，没有加上 `latestAnnualPercentageRate`；没有梯度时仍保留基础 APR，但标为 `base_only`。这与 Binance 的两部分奖励口径不一致，可能低估活动档收益；而 `base_only` 还会让已知 APR 被当作资料不完整。须修正成“实时 APR + 对应档的额外奖励”，并把 APR 可用性和额度可用性拆开。
- **Bitget**：`lib/integrations/bitget.ts` 目前没有按 `apyType` 分支；它把解析到的 `apyList` 当作 APR 梯度，空列表会当作必需字段缺失。梯度只要有可解析值就可能被标为完整，未严格验证整段金额边界；这既可能把合法单利率报成缺字段，也可能把残缺梯度放过。
- **Bybit Global / EU**：代码把 `tierAprDetails[].estimateApr` 当作各金额档的 APR，存在梯度时用首档 APR 作为产品 APR，不会再把顶层 `estimateApr` 加到每个梯度上；空梯度时则保留顶层估算 APR。当前这两份回包中 Global 三币梯度连续，EU 三币均为空但顶层 APR 有效。实现风险仍在：`parseBybitTiers` 会丢弃坏档，只要余下一档就可能标成 `complete`，没有校验全段连续、不重叠或首档从 0 起。并且代码把活期 `max=-1` 解释为 unlimited；目前这次实测与固定期限文档用法相似，但官方活期字段文档没有明确写出该规则，最终应记录为“样本观察 + 代码假设”，不能冒充活期官方定义。
- **Bitget**：除 `product` 外，官方还有 `/api/v2/earn/savings/subscribe-info?productId=...&periodType=...`，回包同时列 `remainingAmount` 和梯度 `apyList`。项目当前只用产品列表 `apyList` 计算分档，并未读取 `remainingAmount`；应先针对少量当前产品核实字段语义，再决定它是否能修正“剩余额度”。现有 `normalizeTiers` 同样只保留可解析利率，不检查档位是否连续，也把空/坏边界压成 `max: null`。
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

## 建议的统一判定标准

1. 先按平台明确的 `rateShape` 识别 `single` 或 `tiered`。Binance 没有 bonus tier 字段时仍有基础实时 APR；Bitget 使用 `apyType`；Bybit 活期若返回项目目前读取的 `tierAprDetails`，必须按实际档验证，不能因为官方文档未写就忽略它。不得仅凭空数组判“不限”或判完整。
2. `single`：有可信 APR 就记为 APR 完整；额度/资格另外判定。没有 APR 数字才是 APR 待获取。
3. `tiered`：必须保留返回档总数和解析成功数，确认两者相等；验证首档起点、边界连续不重叠，并确认末档是有限产品终点还是明确不限。若缺档或回包无法证明适用范围，只保留已知值，不把未覆盖金额按任何利率推算。
4. 对额外奖励（如 Binance Bonus Tiered APR），仅在平台确认它是“加在基础 APR 上”的奖励，且适用档位、金额和资格已知时才相加；历史奖励 APR、活动上限、单笔申购上限不可自动当作当前总 APR 或当前剩余额度。
5. `max: null`、没有档位或最高档有一个有限 `maxStepVal`，都不等于无限。无限必须有平台明确标记/文档语义；未知上限只阻止依赖额度的指标，不抹掉已知 APR。

## 仍需的最小线上样本

若要排查“是不是某个币种/地区回包不同”，需要覆盖项目实际支持的资产；不必索取每个产品的全部账户数据，也不要运行全平台能力扫描：

- Bitget：USDT、USDC、BTC、USDGO 各一条产品摘要（每币一次产品列表即可同时看活期/定期）；只需 `periodType`、`apyType`、`apyList`（`minStepVal`、`maxStepVal`、`currentApy`）和 `status`。若多行重复同一形状，只需留一行；不要贴账号、订单、持仓金额或密钥。
- Bybit 活期：Global 与 EU 的当前公开产品列表已由用户各提供一份，覆盖项目支持的 USDT、USDC、BTC；不支持 USDGO。此项本轮已补齐，不需要再重复请求。待规则确认时只需决定：活期 `max=-1` 是否按 unlimited、梯度 APR 是否直接作为最终档位 APR（而非与顶层 APR 相加），并将官方文档未定义这一点标清。
- Bybit 定期：项目支持四种资产 USDT、USDC、BTC、USDGO。Global 旧诊断记录有 11 条，但只有归一化摘要；本批未找到 EU 定期回包。尚需 EU 当前完整产品清单，以及 Global 原始字段样本，核对 `coin`、`duration`、`status`、`tieredApyList`、`interestCoinApyList`、`minStakeAmount/maxStakeAmount`。

这些都是公开产品资料或只读 API 产品资料，不需要持仓金额、用户身份或密钥。直接浏览器若拦截 Bybit API，应记为“本次查看工具受限”，不要误报成交易所 API 故障。
