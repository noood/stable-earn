# Bitget Wallet / Morph USDC 接入说明

当前仅接入 Morph 链上的 Gauntlet USDC 金库：通过公开钱包地址读取持仓，收益率手动维护。不需要交易所 API Key、Dune Key、钱包私钥或签名。

## 使用方法

1. 打开“数据源设置 → 钱包地址”，在 Bitget Wallet（Morph 链）一行点击“添加”，填写实际持有该产品的钱包公开地址并保存。
2. 在 USDC 产品列表查看同步结果。该产品仅在配置钱包后接入，不是默认产品，也不会读取该钱包的全部链上资产。
3. 在“编辑持仓”中填写整体 APR（含奖励）；持仓由链上读取，保持只读。项目使用手动 APR 估算口径，具体计算、零值及清空行为见[数据规则](DATA-STATES.md#bitget-wallet--morph)。

## 支持范围

| 项目 | 当前范围 |
| --- | --- |
| 网络 | Morph，链 ID `2818`；暂不提供多链选择 |
| 金库 | Gauntlet USDC，`0x9131eb40bd0bdce73c72755f1bb2cf39a9453341` |
| 持仓 | 同一区块的金库份额换算为 USDC 当前估值，不是份额原始数量或赎回到账额 |
| 收益率 | 手动整体 APR；尚无已验证的自动总收益率或奖励数据源 |
| 额度 | 按当前项目的“不限额”约定展示，官方申购与奖励上限尚未验证 |
| 操作 | 只读持仓；不签名、不申购赎回、不扫描买卖账本，也不追踪成本或待发奖励金额 |

申购或赎回由用户在 BGW 自行操作，应用在后续同步中读取最新持仓。持仓失败回退、钱包更换/移除及收益估算统一遵循[数据规则](DATA-STATES.md#bitget-wallet--morph)；界面布局见[设计规范](DESIGN-SYSTEM.md)。

## 部署与实现入口

已有部署须先完成[0022 钱包配置迁移](../README.md#钱包配置迁移0022)，再合并部署。迁移、核验和回退步骤以 README 为准。

- [链上读取适配器](../lib/integrations/bitget-wallet.ts)：只使用公开 RPC，固定同一区块读取；主节点失败后，备用节点重读整段。不会把异常解释为零持仓。
- [钱包配置](../lib/wallet-config.ts)：公开地址按用户保存在 `wallet_configs`；安全边界见[安全策略](../SECURITY.md#public-wallet-addresses)。
- [产品声明](../lib/bitget-wallet-product.ts)：限定接入的链与金库，复用现有产品、档位和手动 APR 字段；身份规则见[产品身份说明](PRODUCT-IDENTITY.md#链上产品)。

## 本地预览与验证

`/private?asset=USDC&syncScenario=bgw` 是专门的本地模拟场景：即使未配置钱包也注入合成产品，保存只影响预览，不访问主网或生产 D1；生产环境不启用该入口。普通本地预览不默认加入 BGW 产品。

[浏览器测试](../e2e/bitget-wallet.spec.mjs)覆盖展示、APR 编辑、保存、钱包配置和过时响应隔离；[链上适配器测试](../tests/bitget-wallet.test.mjs)与[同步测试](../tests/bitget-wallet-sync.test.mjs)覆盖区块校验、零值与失败回退。运行方式见[README](../README.md#本地运行)。模拟测试与主网只读验证分开，个人地址、交易 ID、持仓金额和截图不进入测试夹具或本文。

## 验证依据与历史调查

以下是 2026-10-29 的验证样本，保留可复用的链上事实、来源和未解决问题。它们不是当前利率配置，也不是对第三方接口持续可用的承诺；Dune、Morpho API、Merkl 和历史净值计算均不参与当前运行时的利率读取。

<details>
<summary>展开链上验证与收益率数据源调查</summary>

### 已核实

- [Morph Vaults Monitor](https://dune.com/morph/morph-vaults-monitor) 将 Gauntlet USDC 标为 Morph 链上的 Morpho VaultV2，并列出金库地址 `0x9131eb40bd0bdce73c72755f1bb2cf39a9453341` 和底层市场 ID `0x37d156e96a4230c1fe9545579086e4b40d08b4aae8b3c78ee91031f2a22c1a5c`。2026-10-29 已将用户自然申购产生的 BGW 订单、成功交易收据、金库 `Deposit` 及份额铸造事件交叉核对，确认这笔 BGW Morph USDC 申购确实进入该金库；此前“候选合约未确认”的疑点已解除。这项证据只覆盖该产品，不代表 BGW 的其他理财产品使用相同合约。
- Dune 看板对 `Gauntlet USDC Supply APY` 的说明是“base APY plus rewards APR”。对应查询 ID 为 `8289985`，但[查询页面](https://dune.com/queries/8289985/12288314)公开访问时显示“private or doesn't exist”，无法检查 SQL、奖励来源或计算公式。因此只确认看板声称包含某种奖励 APR，**不能确认是 BGW 活动奖励**。
- 2026-10-29 在公开看板复查时，该卡片显示 `6.73%`，结果状态显示“Last updated 23 hours ago”；与用户当天提供的 BGW 总 APY `6.72%` 相差 `0.01` 个百分点。数值接近，可作注明来源和更新年龄的近似参考；单次接近不能证明两者奖励口径相同，也不能将其视为 BGW 实时利率。
- Dune 查询/看板的刷新由创建者设置，不存在可据此推断的统一 30 分钟频率；公开卡片可查看结果的相对更新年龄，但实际调度、精确运行时间及底层数据截止时间仍未核实。看板页头的“Updated 3 months ago”是看板编辑信息，不能作为结果更新年龄。公开看板可读也不代表私有查询可通过 API 稳定读取。[Dune 调度说明](https://dune.com/blog/new-features-for-better-collaboration)
- [BGW 帮助页](https://web3.bitget.com/zh/helpCenter/913)说明：USDC 借款利息以 USDC 结算、利率随底层市场使用率变化；额外活动奖励在赎回时空投到奖励钱包。页面未说明奖励代币、链、合约或精确计算方式。
- 2026-10-29 已对当前金库实测 Morpho 官方公开接口：`GET /v0/vaults-v2/2818:0x9131eb40bd0bdce73c72755f1bb2cf39a9453341` 返回 HTTP 404，业务信息为 `Unsupported chain 2818`；`POST /graphql` 的 `vaultV2ByAddress(address: ..., chainId: 2818)` 查询返回 HTTP 200，但正文为 `errors: unsupported chainId "2818"`、`data: null`。因此当前官方 API 明确不支持该链，不能从这里读取此金库的基础/总 APY 或奖励。该结论不否定金库在链上使用 Morpho 协议，也不代表 BGW 没有活动奖励。[Morpho 接口说明](https://docs.morpho.org/developers/api/morpho-vaults/)

### BGW 界面说明（用户核对，非接口实测）

用户于 2026-10-29 核对该产品的 APY 详情：基础 APY `2.46%`、奖励 APY `4.26%`，展示总 APY `6.72%`；奖励每 8 小时结算一次，赎回时空投到钱包余额。这些是该次界面样本和说明，不是固定利率配置；自动读取来源、奖励实际代币及到账路径仍待核验。

该基础 APY 与下方链上历史净值折算结果四舍五入后吻合，但单次吻合不能证明 BGW 采用相同取样窗口或计算公式。该样本保留 BGW 原始“奖励 APY”标签；项目当前按用户选择使用手动 APR 估算，不能把该选择当成 BGW 官方公式的验证。每 8 小时结算不代表每 8 小时复投或发到钱包，也不能仅因周期与 Merkl 文档相同就确认其奖励通过 Merkl 发放。

### 已实测的数据读取能力

验证通过本地临时只读脚本直接访问 Morph 主网完成，无需先部署应用，也未使用钱包私钥、助记词或 BGW 开发者 API Key。

| 数据 | 已验证的读取方式与语义 |
| --- | --- |
| 网络与产品身份 | `eth_chainId` 为 `2818`；金库 `name()` 为 `Gauntlet USDC`，`symbol()` 为 `gtusdc`。身份应采用链 ID 与金库地址，不包含 APY、活动或申购时间。 |
| 底层资产 | `asset()` 为 `0xcfb1186f4e93d60e60a8bdd997427d1f33bc372b`，代币名称/符号为 USDC，精度 6；金库份额精度为 18。 |
| 当前持仓 | `balanceOf(wallet)` 返回份额；`convertToAssets(shares)` 与 `previewRedeem(shares)` 在同一区块返回一致的底层资产估值。份额数量不能直接当成 USDC 金额，估值也不等于已完成赎回的到账金额。 |
| 申购记录 | 交易收据中的 `Deposit` 和份额铸造事件可核对存入资产、份额和接收人；区块时间是链上确认时间，可能晚于 BGW 订单显示的发起时间。验证过的交易由外部代付地址发出，不能仅按交易最外层 `from` 判断持仓归属。 |
| 金库总资产与费用 | `totalAssets()`、`performanceFee()`、`managementFee()` 可读；费用和分配配置可能变化，不能把某次读数固化成永久规则。 |
| 底层收益来源 | 已验证的金库只有一个适配器 `0x2214a206b3647523c6aeca1dc91b8824a7108e62`，其底层市场 ID 与上文一致。市场利率、利用率及金库分配金额可读取，但单个市场的供应利率不等于整座金库的收益率，还需考虑闲置资金、费用及计算窗口。 |
| 申购与赎回限额 | `maxDeposit()`、`maxWithdraw()` 实测返回 0；[金库已验证源码](https://explorer-api.morph.network/api/v2/smart-contracts/0x9131eb40bd0bdce73c72755f1bb2cf39a9453341)明确将这些方法固定返回 0。不能据此推断零额度、售罄、无持仓或无法赎回；也不能反向推断不限额。`maxRate()` 是收益增长约束，不是当前 APY。 |

公开 RPC `https://rpc-bgw.morph.network` 已验证可读取当前状态。对约五小时前状态的读取曾返回 `missing trie node`；另一个官方 RPC `https://rpc.morph.network` 在本次验证中成功读取相应历史区块。当前状态与历史状态的可用性需要分别判断，不能因当前读取成功就承诺任意历史查询可用。读取应固定同一区块并记录区块高度与时间；历史读取失败不得替换成零收益。

历史份额净值可以用于计算已实现的区间收益率参考：本次成功读取的窗口为上海时间 2026-10-29 06:29:50–11:48:09，共 19,099 秒；同一固定份额的资产估值比值按 `((期末净值 / 期初净值)^(31536000 / 秒数) - 1)` 年化，约为 `2.4611% APY`。**这只是该历史窗口的净值变化折算，不是 BGW 当前总 APY，不包含未进入份额净值的活动奖励，也不承诺未来收益。** [Morpho 数据读取文档](https://docs.morpho.org/developers/earn/tutorials/get-data/)同样区分净值历史、收益率窗口和额外奖励。

已进一步验证完整近 7 日窗口：通过 `rpc.morph.network` 按区块时间定位到目标时刻之前最近的区块，并核对下一块已晚于目标时刻。两个区块的同一固定份额 `convertToAssets` 及 `previewRedeem` 均成功，结果一致；不使用个人钱包余额或交易历史。

| 取样 | 区块 | 上海时间 | 每份额对应 USDC |
| --- | --- | --- | --- |
| 约 7 日前 | `28647649` | 2026-10-22 14:22:30 | `1.005076403266` |
| 窗口结束 | `28988018` | 2026-10-29 14:22:31 | `1.005546768502` |

固定读取 `10^24` 原始份额（份额精度 18），减少资产精度取整影响。实际区间为 `604801` 秒，区间净值增幅约 `0.04679895%`，按上述实际秒数折算约 `2.469659% APY`；不复利的线性年化约为 `2.440227% APR`。这是金库份额的历史净值收益指标，应命名“近 7 日净值年化 APY”，不能标成 BGW 整体/含奖励 APY。用户说明中赎回时另行空投到钱包的奖励，不会由这段金库净值变化自动涵盖；若以后有奖励进入净值，应按实际进入部分处理，不重复叠加。

该结果证实无需 Dune Key 或 Morpho 官方数据 API 也能读取此窗口；不保证任意 RPC 都具备历史状态。后续接入时需要缓存历史区块锚点与取样，避免每次页面打开/轮询重复定位区块；历史读取失败保留旧样本及来源时间，不能把较短窗口冒充 7 日。本轮只验证了计算方式与样本，尚未切换业务收益率来源。

按金库地址及其底层市场 ID 分别查询 Merkl 的 `GET /v4/opportunities?chainId=2818&identifier=...`，本次均为 HTTP 200、空数组。这只说明这两次限定查询没有匹配项，不能证明 BGW 没有奖励或用户不符合奖励条件；也没有证据证明 BGW 此活动通过 Merkl 发放。

进一步核对 [Merkl 的 Morph 链信息](https://api.merkl.xyz/v4/chains/2818)，返回 HTTP 200、`name: Morph`、`liveCampaigns: 0`；[该链活动列表](https://api.merkl.xyz/v4/opportunities?chainId=2818&items=100&campaigns=true)也返回空数组。因此当前公开 API 没有提供可用的该链活动，不能将 Merkl 作为此产品已验证的奖励利率来源，也不能据此否定其他渠道的 BGW 奖励。

[BTC Yield Atlas 的 Bitget 研究](https://github.com/vlad-degen/btc-yield-atlas/blob/main/research/top5/en/03-bitget.md)将同一 USDC 金库关联到候选奖励分发合约 `0x53D239FEEF1fc7C8Cf80bC6e920796d33DB0c027`，但其中“按 gtUSDC 持仓比例分配”由作者标为推断，不能当作已验证规则。[区块浏览器合约接口](https://explorer-api.morph.network/api/v2/smart-contracts/0x53D239FEEF1fc7C8Cf80bC6e920796d33DB0c027)仅提供 bytecode，没有已验证源码或 ABI。现有证据仍缺对应活动 ID、奖励预算与起止时间、分配窗口/分母和资格条件，无法据此可靠计算 BGW 奖励 APY；也未证实 Dune 使用此合约作为来源。

### 尚未证实

- BGW 活动奖励的实际代币与到账路径：需等真实奖励到账后才能核对；买入本身不能证明奖励如何发放。
- BGW 页面基础、奖励和总 APY 的自动数据来源、实际折算公式、适用额度/用户资格及活动截止时间；界面拆分已由用户核对，但不能通过“页面总 APY 减历史基础 APY”推断已验证的奖励利率或公式。
- Dune 的奖励 APR 是否包含 BGW 活动奖励：查询 SQL 不可见，现有证据不能回答。
- 记录过的历史读数 BGW 总 APY `7.08%`、Dune `6.92%` 不能作为吻合或通过的证据：Dune 样本约旧 3 天，且奖励口径未知。

</details>
