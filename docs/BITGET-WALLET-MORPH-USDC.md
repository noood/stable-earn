# Bitget Wallet：Morph USDC 调研记录

**状态：尚未定义功能需求，未开始实现。** 本文只记录已核实事实及尚缺的证据。

## 已核实

- [Morph Vaults Monitor](https://dune.com/morph/morph-vaults-monitor) 将 Gauntlet USDC 标为 Morph 链上的 Morpho VaultV2，并列出候选金库地址 `0x9131eb40bd0bdce73c72755f1bb2cf39a9453341`；看板同时列出底层市场 ID `0x37d156e96a4230c1fe9545579086e4b40d08b4aae8b3c78ee91031f2a22c1a5c`。**这证明 Dune 看板识别了该产品/合约，不证明 BGW 当前使用的就是它。**
- Dune 看板对 `Gauntlet USDC Supply APY` 的说明是“base APY plus rewards APR”。对应查询 ID 为 `8289985`，但[查询页面](https://dune.com/queries/8289985/12288314)公开访问时显示“private or doesn't exist”，无法检查 SQL、奖励来源、计算公式或查询运行时间。因此只确认看板声称包含某种奖励 APR，**不能确认是 BGW 活动奖励**。
- Dune 查询/看板的刷新由创建者设置，不存在可据此推断的统一 30 分钟频率；此看板的实际调度和最近成功查询时间无法从公开页面核实。[Dune 调度说明](https://dune.com/blog/new-features-for-better-collaboration)
- [BGW 帮助页](https://web3.bitget.com/zh/helpCenter/913)说明：USDC 借款利息以 USDC 结算、利率随底层市场使用率变化；额外活动奖励在赎回时空投到奖励钱包。页面未说明奖励代币、链、合约或精确计算方式。

## 尚未证实

- BGW 当前是否使用上述候选金库：需以实际持仓对应的公开钱包地址或交易记录核对。
- BGW 活动奖励的实际代币与到账路径：需等真实奖励到账后才能核对；买入本身不能证明奖励如何发放。
- Dune 的奖励 APR 是否包含 BGW 活动奖励：查询 SQL 不可见，现有证据不能回答。
- 记录过的历史读数 BGW 总 APY `7.08%`、Dune `6.92%` 不能作为吻合或通过的证据：Dune 样本约旧 3 天，且奖励口径未知。

## 当前约定

- 在上述实测完成、功能需求由用户确认前，不开始编码，也不把 Dune APY、手动 APY 或其他替代方案视为已批准需求。
- 不为验证而要求用户额外买入或赎回；只在用户自然持仓/收到奖励后核对相应事实。
