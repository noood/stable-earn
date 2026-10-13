# Bitget Wallet：Morph USDC 金库

本记录用于后续接入，不代表已上线。范围是 Bitget Wallet 中 Morph 链的 **Gauntlet USDC Morpho 金库**，不是 Bitget 交易所 Savings，也不是“稳定币理财 Plus”。其他 DeFi 产品发现暂缓，先验证这一款。

## 产品身份

- Morph 主网，chain ID `2818`。
- 金库/份额合约：`0x9131eb40bd0bdce73c72755f1bb2cf39a9453341`（Gauntlet USDC，`gtusdc`）。此前通过 Morph 浏览器和官方看板交叉确认；接入时仍需复核。
- 已识别的底层 Morpho 市场：`0x37d156e96a4230c1fe9545579086e4b40d08b4aae8b3c78ee91031f2a22c1a5c`。金库配置可能变化，不能写死为永久唯一市场。

## 指标与结论

| 指标 | 来源与结论 |
|---|---|
| 存入/赎回 | 可尝试从 Morph 交易和合约事件读取时间、金额、交易哈希及份额；尚未用用户交易验证。份额转入/转出也要纳入。 |
| 当前持仓 | 读取钱包持有的金库份额，再按金库兑换比例折算成 USDC；尚未和用户实际持仓对账。具体合约读取方法需验证。Morpho API 支持列表此前未列 Morph，不能假设它能提供该仓位。 |
| 基础 APY | 可从底层链上数据估算，但不等于 BGW 页面利率；金库配置、闲置资金、费用和采样时间会造成差异。暂无已对账的实时来源。 |
| 奖励 APY | 尚无已验证的公开实时来源。BGW 说明提到活动奖励可能在赎回时空投；实际奖励资产、发放方、资格和到账地址待实测。 |
| 总 APY | Dune 可作候选参考，但暂不作为实时报价：查询细节不可见，无法确认奖励是否就是 BGW 奖励。若自动来源不可靠，手动录 BGW 页面总 APY，并记下来源和时间；不必分别录基础与奖励。 |

约 **2026-10-09** 的历史观测（不是当前报价）：BGW 页面基础 APY `2.41%`、奖励 APY `4.67%`、合计 `7.08%`；Morph 官方 Dune 看板 `Supply APY` 为 `6.92%`。Dune 数据当时约 3 天未更新；页面“2 months ago”是看板编辑时间。另一次底层市场估算约 `2.60% APR / 2.63% APY`，不能代替金库基础 APY。`Supply` 指资金提供方，不是金额；APY 标签也不代表利率固定或奖励复投。

**接入方向：**持仓和资金进出优先尝试链上自动读取；利率只有找到及时、可核验的来源才自动接入，否则采用人工产品/APY + 自动持仓。手动时优先记录总 APY。

## 待办

1. 用户自然买入后，用一笔交易哈希定位钱包、金库和份额，并与 BGW 页面同一时刻的持仓对账；无需为测试额外交易。只需公开地址或交易哈希，不要私钥、助记词或签名。
2. 验证链上读取方式、事件和历史起始区块；覆盖存入、赎回、份额转账，并确认失败/不完整时不会把持仓当零。
3. 核实 BGW 是否有稳定的产品数据接口；检查 Dune 的更新时间、计算口径和奖励来源，并尝试与 BGW 同时点数据对账。
4. 奖励实际发放后，核对链上记录和 BGW 记录；在确认前不把总 APY 拆成基础与奖励，也不把估算持仓收益当作 APY。
5. 上述验证后再确定 APY 自动/手动字段和单金库接入方案；通过后才评估扩展其他 DeFi 产品。

## 参考

- [Bitget Wallet：Morpho USDC 金库说明](https://web3.bitget.com/zh/helpCenter/913)
- [Morph 官方产品介绍](https://blog.morph.network/how-to-earn-on-your-usdc-with-morph/)
- [Morph 网络与 RPC 文档](https://docs.morph.network/docs/build-on-morph/developer-resources/morph-json-rpc-api-methods)
- [Morph Vaults Monitor](https://dune.com/morph/morph-vaults-monitor)
- [Morpho API 支持范围](https://docs.morph.org/developers/api/get-started/)
