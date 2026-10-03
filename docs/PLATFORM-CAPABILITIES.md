# 平台产品能力矩阵与筛选规则

本文记录当前代码中的平台能力范围、尚待核实的能力，以及产品进入活动目录的目标规则。它是静态盘点，不代表每个格子都已通过当前线上账号的实时验证。

## 能力矩阵是什么

矩阵的维度是“平台账号 × 资产 × 产品类型（活期/定期）”，并将两种来源分开记录：

- `productApi`：产品资料和 APR 的来源；
- `holdingApi`：用户持仓的来源。

代码中的模式为 `public`（公开 API）、`authenticated`（需要该平台账号凭证的 API）和 `manual`（例行同步不请求 API，由手动数据或其他明确路径维护）。`manual` 只描述当前程序怎么运行，不等于已经证明交易所没有该 API。

公开 API 不只是盘点探针：Bybit 的产品/APR 查询会参与日常产品刷新。活期调用公开的 `/v5/earn/product?category=FlexibleSaving&coin=...`，定期调用公开的 `/v5/earn/fixed-term/product`；两者提供产品 ID、币种、状态、期限/额度档和利率。用户自己的持仓则由需要签名的 `/v5/earn/position` 或 `/v5/earn/fixed-term/position` 另行查询。活期解析使用 `estimateApr` / `tierAprDetails`，不会把 `bonusApr`、`extraApr` 再相加；定期优先使用 `tieredApyList`，缺失时才把 `interestCoinApyList` 中的 APY 项相加。因此你记得的“基础 + 奖励”可能对应定期的多项利率回退解析，但字段是否分别代表基础与奖励，要以 Bybit 对该响应字段的定义为准，不能仅从代码命名断言。

矩阵的静态范围由 `lib/platform-capabilities.ts` 生成：8 个平台账号 × 4 种资产 × 2 种产品类型，共 64 个格子。它记录接口覆盖能力，不记录每个实际产品的外部 ID、APR、额度或资格；这些属于产品目录和接口响应。

## 当前代码配置

“自动 API”表示该来源已由代码接入；不代表本次盘点已用线上账号逐格重验。未列入自动 API 的格子目前都不由常规同步请求。

| 平台账号 | 活期产品/APR | 活期持仓 | 定期产品/APR | 定期持仓 | 待核实事项 |
|---|---|---|---|---|---|
| Binance Global | 常规账户 API：USDT、USDC；一次性探针另见 BTC 产品 | 常规账户 API：USDT、USDC | 账户 API：USDT、USDC、USDGO、BTC | 账户 API：四种资产 | 活期 BTC 产品接口本次返回 1 行、两档利率，但还未接入常规同步；USDT/USDC 产品持仓 ID 本次匹配 |
| Binance Bahrain | 常规账户 API：USDT、USDC；一次性探针另见 BTC 产品 | 常规账户 API：USDT、USDC | 账户 API：四种资产 | 账户 API：四种资产 | 活期 BTC 产品接口本次返回 1 行、两档利率，但还未接入常规同步；账号身份包含 Bahrain，避免与 Global 串行 |
| Bybit Global | 公开 API：USDT、USDC | 账户 API：USDT、USDC | 公开 API：四种资产 | 账户 API：四种资产 | 活期公开产品列表和账户持仓分别保留产品 ID，并以平台账号、币种、期限和产品 ID 建立身份 |
| Bybit EU | 常规同步：公开 API USDT；只读探针可查四币活期与四币定期 | 常规同步未接入；用户提供的 API 权限页未显示 Earn 只读权限，因此当前凭证无法验证 Earn 持仓 | 官方文档有公开定期产品接口；常规同步未接入 | 定期持仓未接入；权限页也未显示 Earn 只读权限 | 活期 USDGO 返回 180002（官方定义 Invalid coin）；定期 USDGO 为成功但空，不能把活期错误外推到其他 Earn 类别 |
| Bitget Global | 账户 API：USDT、USDC | 账户 API：USDT、USDC | 官方 Savings 产品 API 有 `flexible`、`fixed` 与 `period` 字段；线上探针 USDT 返回 3 行，常规同步尚未接入 | 官方 Savings Assets API 支持 `periodType=fixed`；2026-10-04 01:09 线上探针已完整查询四币定期持仓，本次均为空 | USDT 定期产品本次 3 行（1 普通、2 VIP）；持仓成功但为空，不代表端点不支持或其他账号没有持仓。USDGO、BTC 活期/定期产品本次成功但空，不等于交易所不支持 |
| OKX Global | 未接入 | 账户 API：USDT、USDC、BTC | 官方文档列出 On-chain Earn offers，但这不是简单 Savings；Stable Rewards 文档示例币种是 USDG（非 USDGO），且产品资料没有 APR | 未接入 | On-chain offers 是否适合纳入本项目 Earn 范围需单独分类；已知公开 `savings-rate-summary` 不在当前官方 API 文档目录中 |
| MEXC PH | 未接入 | 未接入 | 官方 API 目录未找到 Earn/Savings 产品接口 | 未接入 | 仅能确认当前公开目录未列相关接口，不能证明绝无未公开/区域专用接口 |
| MEXC UK | 未接入 | 未接入 | 官方 API 目录未找到 Earn/Savings 产品接口 | 未接入 | 与 PH 一样尚无官方文档端点或线上 API 响应可判定支持情况 |

### 按平台账号 × 币种 × 数据类型展开

按用户建议，表头分三级：平台账号；四种币种分组；每种币下再分活期、定期。每个平台账号下面以“产品”和“持仓”作为行标题。下表是最新线上检查（2026-10-04 01:09）的结果，同时显示常规接入与这次探针的区别。

- `鉴·N` / `公·N`：常规同步已接入鉴权 API / 公开 API，本次返回 N 行；`鉴·空` / `公·空`：请求成功但本次无行。
- `未接探针N` / `未接探针空`：常规同步未接入，但本次诊断额外请求并得到 N 行 / 成功空结果。
- `错180002`：Bybit API 明确拒绝该币种参数；`未配置`：缺该账号凭证；Bybit EU 持仓未配置的背景是用户权限截图里未见 Earn 只读项，并非零持仓；`未接入`：该格还没有实现探针。
- `未请求`：当前这份线上报告没有检查这个格；不是“接口不支持”。
- 空结果只代表本次；`manual` / 未接入不等于交易所不支持。

<table>
  <thead>
    <tr><th rowspan="3">平台账号</th><th rowspan="3">数据类型</th><th colspan="8">资产与产品期限</th></tr>
    <tr><th colspan="2">USDT</th><th colspan="2">USDC</th><th colspan="2">USDGO</th><th colspan="2">BTC</th></tr>
    <tr><th>活期</th><th>定期</th><th>活期</th><th>定期</th><th>活期</th><th>定期</th><th>活期</th><th>定期</th></tr>
  </thead>
  <tbody>
    <tr><th rowspan="2">Binance Global</th><th scope="row">产品</th><td>鉴·1</td><td>鉴·空</td><td>鉴·1</td><td>鉴·空</td><td>未接探针空</td><td>鉴·空</td><td>未接探针1</td><td>鉴·空</td></tr>
    <tr><th scope="row">持仓</th><td>鉴·1（正额）</td><td>鉴·空</td><td>鉴·1（正额）</td><td>鉴·空</td><td>未接探针空</td><td>鉴·空</td><td>未接探针空</td><td>鉴·空</td></tr>
    <tr><th rowspan="2">Binance Bahrain</th><th scope="row">产品</th><td>鉴·1</td><td>鉴·空</td><td>鉴·1</td><td>鉴·空</td><td>未接探针空</td><td>鉴·空</td><td>未接探针1</td><td>鉴·空</td></tr>
    <tr><th scope="row">持仓</th><td>鉴·1（正额）</td><td>鉴·空</td><td>鉴·1（正额）</td><td>鉴·空</td><td>未接探针空</td><td>鉴·空</td><td>未接探针空</td><td>鉴·空</td></tr>
    <tr><th rowspan="2">Bybit Global</th><th scope="row">产品</th><td>公·1</td><td>公·6</td><td>公·1</td><td>公·1</td><td>错180002</td><td>公·空</td><td>未接探针1</td><td>公·2</td></tr>
    <tr><th scope="row">持仓</th><td>鉴·空</td><td>鉴·空</td><td>鉴·1（无正额）</td><td>鉴·空</td><td>错180002</td><td>鉴·空</td><td>未接探针空</td><td>鉴·空</td></tr>
    <tr><th rowspan="2">Bybit EU</th><th scope="row">产品</th><td>公·1</td><td>未接探针空</td><td>未接探针1</td><td>未接探针2</td><td>错180002</td><td>未接探针空</td><td>未接探针1</td><td>未接探针3</td></tr>
    <tr><th scope="row">持仓</th><td>未配置；权限页未见 Earn</td><td>未接入；权限页未见 Earn</td><td>未配置；权限页未见 Earn</td><td>未接入；权限页未见 Earn</td><td>未配置；权限页未见 Earn</td><td>未接入；权限页未见 Earn</td><td>未配置；权限页未见 Earn</td><td>未接入；权限页未见 Earn</td></tr>
    <tr><th rowspan="2">Bitget Global</th><th scope="row">产品</th><td>鉴·3</td><td>未接探针3</td><td>鉴·3</td><td>未接探针空</td><td>未接探针空</td><td>未接探针空</td><td>未接探针空</td><td>未接探针空</td></tr>
    <tr><th scope="row">持仓</th><td>鉴·1（正额）</td><td>未接探针空</td><td>鉴·1（正额）</td><td>未接探针空</td><td>未接探针空</td><td>未接探针空</td><td>未接探针空</td><td>未接探针空</td></tr>
    <tr><th rowspan="2">OKX Global</th><th scope="row">产品</th><td>未接入</td><td>未接入</td><td>未接入</td><td>未接入</td><td>未接入</td><td>未接入</td><td>未接入</td><td>未接入</td></tr>
    <tr><th scope="row">持仓</th><td>鉴·空（余额）</td><td>未接入</td><td>鉴·1（余额）</td><td>未接入</td><td>鉴·空（余额）</td><td>未接入</td><td>鉴·空（余额）</td><td>未接入</td></tr>
    <tr><th rowspan="2">MEXC PH</th><th scope="row">产品</th><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td></tr>
    <tr><th scope="row">持仓</th><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td></tr>
    <tr><th rowspan="2">MEXC UK</th><th scope="row">产品</th><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td></tr>
    <tr><th scope="row">持仓</th><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td><td>未请求</td></tr>
  </tbody>
</table>

**读表结论：**矩阵有 8 个账号环境 × 4 种资产 × 2 种期限，共 64 个检查范围；每个范围分别记“产品/APR”和“持仓”，因此展开表有 128 个结果格。并非所有格都已请求或验证。最新报告中 OKX 只返回了余额观察（USDC 一行），没有产品/APR 证据；MEXC 两个区域都未请求。2026-10-03 统一只读探针提供了 Bybit Global 定期、Bitget USDGO/BTC 与 USDT 定期的单次结果；2026-10-04 补查官方文档确认了 Bybit 活期/定期公开产品接口、Bitget 定期持仓端点、OKX On-chain Earn/Stable Rewards 的范围，以及 MEXC 当前文档目录没有 Earn/Savings 产品 API 分类。实际线上结果与文档范围的边界详见本文“2026-10-04 官方 API 文档复核”。

早先受限网络环境下，普通终端请求曾遇到 DNS 失败；2026-10-04 用户开启代理后，通过官方文档页面和获准的只读 HTTPS 请求完成了 Bybit 公开接口实测，并通过线上应用的“检查平台 API”完成了新一轮 64 格检查。报告声明 `dataChangesCommitted=false`、`includesHoldingAmounts=false`：没有写数据库或返回持仓金额；鉴权持仓响应仍会在服务器内存中处理，以计算是否有正持仓等摘要字段。

### 盘点结论的状态词

对于“交易所是否支持”另记探测证据，不要从 `manual` 推断：

| 结论 | 含义 |
|---|---|
| 已接入 | 代码已有对应 API 适配器，并由配置启用 |
| 已返回 | 对指定账号、币种和产品类型的一次实际请求返回了符合范围的产品行 |
| 成功但为空 | 请求成功，但这一次没有返回符合范围的产品；不等于 API 不支持 |
| 请求失败/结果不完整 | 权限、网络、限流、分页等问题；不能据此判定不支持，也不能据此归档持仓产品 |
| 尚未核实 | 未查清官方接口或未取得真实响应 |
| 确认不支持 | 有明确官方资料或可重复证据证明该范围没有可用接口 |

探测结果是观察记录，不应自动改写代码能力标记。只有“已接入”才表示常规同步会请求；“尚未核实”不能被标成“确认不支持”。

## 2026-10-03 统一只读探针结果

来源：用户从线上 API 设置页导出的结果，`generatedAt=2026-10-03T12:25:00.593Z`（上海时间 20:25）。探针覆盖矩阵中的 64 个格子，但 `64` 是矩阵格数，不是 64 次 API 请求：`not_integrated` 表示常规同步未接入；部分 `manual` 格子由这次探针额外只读请求。结果声明 `dataChangesCommitted=false`、`includesHoldingAmounts=false`，本次没有 `error` 或 `partial` 状态。

| 平台账号 | 本次产品/APR 结果 | 本次持仓结果 | 结论与边界 |
|---|---|---|---|
| Binance Global、Bahrain | 活期 USDT、USDC 各 1 行；定期 USDT、USDC、USDGO、BTC 均成功但为空 | 活期四组均各 1 行且 ID 匹配；定期四种资产均成功但为空 | 两账号活期 USDT/USDC 的产品与持仓 ID 对得上；定期空结果不证明交易所不支持 |
| Bybit Global | 活期 USDT、USDC 各 1 行；定期 USDT 6 行、USDC 1 行、BTC 2 行、USDGO 成功但为空 | 活期 USDT 成功但无持仓、USDC 有 1 行且 ID 匹配；定期四种资产成功但均无持仓 | 定期 USDT 的 6 行只有 4 个原始 ID；ID `4`、`5` 各跨两个期限重复。旧版按原始 ID 有合并风险；随后版本已在 API 报告中以 `productId + duration` 展示产品身份。最新定期持仓为空，因此仍未用真实持仓验证配对结果 |
| Bybit EU | 活期 USDT 公开产品接口返回 1 行；其余产品范围未接入 | 持仓接口未接入 | 只确认 EU 活期 USDT 产品列表本次有返回 |
| Bitget Global | 活期 USDT、USDC 各 3 行；USDGO、BTC 均成功但为空。定期 USDT 只读探针返回 3 行，USDC、USDGO、BTC 成功但为空 | 活期 USDT、USDC 各有 1 个正持仓 ID，均与各自产品列表中的一个 ID 匹配；USDGO/BTC 本次为空。2026-10-04 01:09 新版探针查询四币定期持仓，均完整但为空 | USDT、USDC 活期其余产品 ID 没有持仓行不代表错配。USDT 定期本次 3 行，含 7 天普通、7 天 VIP、14 天 VIP；定期持仓链路已被请求，但本次没有持仓行 |
| OKX Global | 产品/APR 接口未接入，本次没有探测 | 活期余额端点观察到 USDC；USDT、USDGO、BTC 本次未出现；定期未接入 | 这是余额/持仓观察，不是产品/APR 证据；USDGO 产品能力仍未知 |
| MEXC PH、UK | 活期、定期产品/APR 均未接入，未请求 | 活期、定期持仓均未接入，未请求 | 不能从本次结果判断 MEXC 是否支持 |

**如何读 `empty`：**它表示探针这一次的请求被标为完整，但没有符合该币种/期限的行；不等同于“官方 API 不支持”。例如 Bitget USDGO 活期产品是 `mode=manual, status=empty`：常规同步未接入，但这次只读探针确实请求了产品列表并得到空结果。OKX 的 USDGO `empty` 只涉及余额端点，不涉及产品/APR。

**原始线上结果暴露的身份风险：**Bybit Global 定期 USDT 返回 6 条记录，其中 `productId=4` 和 `5` 分别跨两个期限。官方[产品接口文档](https://bybit-exchange.github.io/docs/v5/finance/earn/fixed-saving/product)与[持仓接口文档](https://bybit-exchange.github.io/docs/v5/finance/earn/fixed-saving/position)都列出 `productId` 和 `duration`；前者无需鉴权，后者需要 Earn 权限。旧代码只按 `productId` 去重和分配，可能把不同期限的持仓合并。当前本地代码已改为用 `productId + duration` 配对，并在迁移时按 `termDays` 复用旧目录行；如果持仓行缺少期限且 ID 对应多个产品，则标记同步不完整、不猜归属。2026-10-04 01:09 的新报告再次确认产品列表仍有重复原始 ID（如 `4@7d` 与 `4@90d`），但定期持仓列表为空，因此这次只能复核产品身份拆分，不能实测定期持仓的配对结果。

## 官方文档核对进度（2026-10-03）

| 平台 | 官方资料核对结果 | 对本次评估的意义 |
|---|---|---|
| Bybit Global / EU | [活期产品资料](https://bybit-exchange.github.io/docs/v5/finance/earn/easy-onchain/product-info)说明 `GET /v5/earn/product` 无需鉴权；[定期产品资料](https://bybit-exchange.github.io/docs/v5/finance/earn/fixed-saving/product)说明 `GET /v5/earn/fixed-term/product` 无需鉴权，响应有产品币种、期限、APY 档、状态和 VIP 字段。官方[错误码表](https://bybit-exchange.github.io/docs/v5/error)将 `180002` 定义为 `Invalid coin`。 | 标准活期/定期产品端点都已明确；Global/EU USDGO 活期不被接受，定期 USDGO 是成功但空。On-chain/Advanced Earn 等不同类别未并入本项目简单 Savings 范围。 |
| MEXC PH / UK | [当前官方 API 目录](https://www.mexc.com/api-docs/spot-v3/introduction)列 Spot、Futures、Broker、P2P、CLI；所查目录中没有 Earn/Savings 产品端点。 | 只能记为“当前公开官方目录未列出”，不能据此确认 MEXC 不支持；也没有可用端点给用户配置凭证实测。 |
| Binance | 官方开发者文档站本轮仍不可读；线上探针已确认两账号活期 USDT/USDC 产品和持仓 ID 匹配，定期四币接口本次完整但为空。 | 线上样本证明已接入接口本次有调用结果；定期空结果不足以判断公开能力或区域供给。 |
| Bitget | [Classic Earn Savings 官方文档](https://www.bitget.com/docs/catalog/earn-classic-savings/classic-earn-savings)已可读，列有产品和活期/定期持仓端点，产品结构包含期限字段。 | 线上探针已取得活期 USDT/USDC 和定期 USDT 产品行；新版本诊断补充定期持仓查询，需部署后再获取账户实测。USDGO/BTC 成功空不等于无 API。 |
| OKX | [官方 Financial Product 文档](https://www.okx.com/docs-v5/en/#financial-product)已可读，列出 On-chain Earn offers 和 Stable Rewards 产品资料。 | On-chain offers 有 APY 但属于另一产品类别且未标为 Public；Stable Rewards 示例为 USDG、产品资料没有 APY。普通 Savings APR 仍不能仅凭之前观察到的非文档化 `savings-rate-summary` 算作正式 API 覆盖。 |

本轮尝试读取官方资料是只读操作。MEXC 公开目录没有列出 Earn 接口，故保留为“未证实”；不将文档缺项或网络失败记成交易所明确不支持。

## 统一只读探针（2026-10-03）

对照线上导出后确认：旧版检查按钮把未接入日常同步的格子标成 `not_integrated`，但没有去问交易所，因此这类结果不能回答 API 是否支持。已在本地把一次性只读检查扩展为：

- Binance Global、Bahrain：对四种资产逐一调用已有活期产品和持仓只读接口；空列表作为“请求成功但为空”返回，不改变日常同步遇到空产品时的处理方式。
- Bybit Global、EU：用公开活期产品接口逐一检查四种资产；Bybit Global 另用已保存凭证，对四种资产逐一检查账户持仓接口。
- Bybit EU 有独立凭证入口，但用户提供的 Key 权限截图只显示 Trade 与 Assets/Wallet 只读项，没有 Earn 读取权限。因此当前凭证不能验证活期或定期 Earn 持仓；线上报告的 `not_configured` 不是零持仓。公开接口仍可独立检查产品/APR，定期持仓接口也尚未接入探针。
- 其他已有检查维持原样。探针不创建/归档目录产品、不写持仓或历史，也不改变常规同步启用的能力范围；未接入范围仍会明确标注为一次性探测。

上述探针版本已部署，并在 2026-10-03 14:34 UTC（上海时间 22:34）再次运行线上检查。本地对应实现通过 154 项自动化测试、类型检查、Lint 和生产构建。构建有一条本机未设置 `CREDENTIAL_ENCRYPTION_KEY` 的环境提醒，但构建本身成功；部署环境已有密钥时不受此提醒影响。

此前 2026-10-03 12:25 的线上 JSON 仍是旧范围结果；14:34 UTC 的新 JSON 已覆盖当前公开产品探针范围，但多个平台返回了笼统的 `error`。检查接口当时没有把上游失败原因带回 JSON，因此单靠该文件不能判断是权限、区域、IP 白名单、限流还是网络问题。无需搜索 Cloudflare 运行日志；本地已补充脱敏的 `apiFailureSummary`，会按平台、接口、币种归纳 HTTP 状态和安全错误类别，不包含密钥或原始响应。此项后端改动尚待部署，部署后重跑检查即可读到原因摘要。接下来仍需处理三类能力缺口：

1. **Bybit 定期身份修复**：官方字段和线上重复 ID 已支持用 `productId + duration` 区分；本地代码及迁移兼容已通过回归测试。当前这次检查的定期接口报错，尚未取得可用的线上复核结果。
2. **Bitget 定期持仓**：官方端点和期限字段已核实；本地探针现已扩展到 fixed 持仓及 `period`。缺的是部署新版本并取得此次账户真实的定期持仓行，不是再找一次接口文档。
3. **OKX 产品/APR、MEXC PH/UK 产品及持仓**：OKX 官方文档已找到 On-chain Earn offers，但需与普通 Savings 分开并用已保存只读凭证实测四币返回；MEXC 官方目录未列 Earn/Savings API，目前没有可安全调用的候选端点，不能通过补 API 凭证替代文档依据。

## 已有线上返回证据

来源：2026-10-03 16:18（上海时间）Cloudflare 运行日志导出。用户提供的五个文件内容相同，因此按一份同步样本分析。此表记录这一次实际请求，不等于长期保证，也不把“成功但为空”视为 API 不支持。

| 平台账号 / 范围 | 本次实际返回 | 能得出的结论 | 仍缺什么 |
|---|---|---|---|
| Binance Global、Bahrain：活期 USDT、USDC | 四个组合的产品与持仓清单均完整；每个清单各返回 1 行，产品 ID 与持仓 ID 匹配 | 本次两账号的活期产品 API 和持仓 API 均有返回，ID 能对应 | 只覆盖 USDT/USDC；本次只有单行，不能验证多个同币产品的线上映射。定期日志仅有账号总数，没有币种明细 |
| Bybit Global：活期 USDT、USDC | 公开产品接口各返回 1 个带 ID 的 Available 产品；持仓接口 USDC 返回 1 行且 ID 可匹配，USDT 请求成功但返回 0 行 | 产品/APR API 两币均有返回；持仓 API 两币均成功，本次 USDT 无持仓行不是接口失败 | 定期诊断 `bybit_fixed_rows` 尚未出现在这份部署日志中；需部署当前代码后再看四币产品和持仓 ID |
| Bybit EU：活期 USDT | 公开产品接口返回 1 个带 ID 的 Available 产品 | 本次产品/API 有返回 | 其余资产与定期未覆盖；该账号没有持仓 API 接入 |
| Bitget Global：产品列表 | 本次 USDT 返回 3 行活期、3 行定期；USDC 返回 3 行活期、0 行定期。返回行含产品 ID，状态为 `in_progress`，同时包含普通与 VIP 层级 | **首次确认该产品列表 API 本次也返回了 USDT 定期产品资料。**USDC 定期本次成功返回空，不足以证明不支持 | 定期持仓 API 尚未验证；USDGO、BTC 没有在这次请求范围内 |
| Bitget Global：活期持仓 | 分页完整；USDT、USDC 各返回 1 行，两个持仓 ID 都能在对应币种的产品列表中找到 | 本次活期持仓 API 完整，ID 匹配成功 | 不能据此推断定期持仓接口可用 |
| OKX Global | `/api/v5/finance/savings/balance` 返回 HTTP 200 JSON | 确认本次调用成功的是储蓄余额/持仓 API | 这不是产品/APR API；四种币的产品/APR 能力仍未验证 |
| MEXC PH、UK | 这份同步日志没有对应 API 请求 | 无法判断 | 仍需查官方区域 API，并确认产品/APR 与持仓接口分别需要什么权限 |

同步总状态显示成功只代表本次已接入任务完成；不代表所有 64 个格子都已请求或都有产品返回。

## 2026-10-03 14:34 UTC 能力检查结果

来源：用户从 API 设置页导出的 64 格只读结果。`dataChangesCommitted=false` 且 `includesHoldingAmounts=false`，没有产品、持仓或历史数据写入，也未包含持仓金额。

| 平台账号 | 本次结果 | 能得出的结论 |
|---|---|---|
| Binance Global、Bahrain | 两个平台的活期、定期产品和持仓字段均为 `error`；合计 16 个产品 API 格和 16 个持仓 API 格报错 | 这次没有取得产品行，不能判断币种不支持；返回内容没有失败原因 |
| Bybit Global | 四币活期、定期产品查询均为 `error`，持仓查询也均为 `error` | 本次没有可用于能力判断的 Bybit Global 数据 |
| Bybit EU | 四币活期、定期公开产品查询均为 `error`；活期持仓为 `not_configured`，定期持仓为 `not_integrated` | 产品检查失败；持仓两种状态分别表示未配置 EU 凭证、未接入定期持仓检查，不代表 API 不支持 |
| Bitget Global | 四币活期/定期产品查询均为 `error`；活期持仓均为 `error`；定期持仓为 `not_integrated` | 产品和活期持仓本次失败；定期持仓未请求 |
| OKX Global | 活期余额中 USDC 为 `returned`，USDT、USDGO、BTC 为 `empty`；所有产品 API 和定期持仓均为 `not_integrated` | 只证明本次余额接口观察到 USDC；不说明产品/APR API 能力 |
| MEXC PH、UK | 所有格子均为 `not_integrated` | 本次没有请求，不能判断交易所是否提供相关 API |

整体共 40 个产品 API 格、28 个持仓 API 格返回 `error`。由于原 JSON 未包含 HTTP 状态、API 错误码或网络错误类别，不能从中区分权限、区域/IP 限制、限流和暂时性网络故障；也不能把 `error` 解读为“不支持”。已在本地检查报告中补充脱敏 `apiFailureSummary`，用于下次检查定位这些失败。

## 2026-10-03 14:47 UTC 复查结果

来源：同一用户稍后再次从 API 设置页导出的检查 JSON（上海时间 22:47）。本次 `dataChangesCommitted=false`、`includesHoldingAmounts=false`。除下表所列错误外，大多数上一轮失败的请求本次成功，说明 14:34 的大面积 `error` 是单次检查异常，不能当作平台不支持的证据。本次 JSON 未包含 `apiFailureSummary`，因此 Bybit USDGO 活期错误的具体原因仍不可见。

| 平台账号 | 本次产品/APR 返回 | 本次持仓返回 | 新结论与限制 |
|---|---|---|---|
| Binance Global、Bahrain | 活期 USDT、USDC、BTC 各 1 行，USDGO 成功但为空；四币定期产品均成功但为空 | 活期 USDT、USDC 各 1 行且 ID 匹配；BTC、USDGO 为空；四币定期均成功但为空 | 首次直接证明两账号的活期 BTC 产品接口有返回（各 1 行、含 2 个利率档）。BTC 产品能力仍未接入常规同步；定期空结果只代表本次没有行 |
| Bybit Global | 活期 USDT、USDC、BTC 各 1 行且各有 2 个利率档；USDGO 活期报错。定期 USDT 6 行、USDC 1 行、BTC 2 行、USDGO 成功但为空 | 活期 USDC 有 1 行且 ID 匹配，USDT/BTC 成功但为空，USDGO 报错；定期四币持仓接口均成功但为空 | 定期 ID 仍需用 `productId + duration` 区分。USDC 定期行要求特殊用户组；BTC 有一条售罄 VIP 行和一条可申购普通行，筛选应按资格字段处理 |
| Bybit EU | 活期 USDT、USDC、BTC 各返回 1 行，USDGO 报错；定期 USDC 返回 2 行、BTC 返回 3 行，USDT/USDGO 成功但为空 | 活期持仓未配置；定期持仓未接入 | 已证实公开产品查询在本次对 USDT、USDC、BTC 活期及 USDC、BTC 定期有响应。EU 活期三行的 `tierCount=0`，因此 APR 档位尚未确认；定期返回行各有 1 档 |
| Bitget Global | 活期 USDT、USDC 各 3 行；USDGO、BTC 成功但为空。定期 USDT 返回 3 行，其余三币成功但为空 | 活期 USDT、USDC 各 1 行且 ID 均匹配到产品；USDGO、BTC 成功但为空；定期持仓未接入 | 再次确认 Bitget USDT 定期产品列表可返回，但 3 行均无可用期限字段，定期监控还缺期限解析与持仓接口核实 |
| OKX Global | 产品/APR 未接入；定期未接入 | 活期余额 USDC 返回 1，USDT、USDGO、BTC 本次为空 | 仍只有余额/持仓证据，没有产品/APR 证据 |
| MEXC PH、UK | 本次均未请求 | 本次均未请求 | 仍待官方接口盘点；`not_integrated` 不代表不支持 |

这次只剩三个范围字段报错：Bybit Global USDGO 活期产品和持仓、Bybit EU USDGO 活期产品。14:47 导出未含 `apiFailureSummary`，所以当时原因未知；下一次运行见下节。

## 2026-10-03 14:59 UTC USDGO 错误摘要

用户随后再次运行检查（上海时间 22:59），新报告已包含 `apiFailureSummary`，且仍为只读、不写入数据。错误集中在 Bybit USDGO 活期：

| 平台与接口 | 本次返回 | 可得结论 |
|---|---|---|
| Bybit Global `/v5/earn/product` | `api.bybit.com` 与备用主机 `api.bytick.com` 均 HTTP 200、API 码 `180002` | 不是网络超时或 HTTP 层拒绝；交易所应用层拒绝了 `coin=USDGO` 的产品请求 |
| Bybit Global `/v5/earn/position` | 两个主机均 HTTP 200、API 码 `180002` | 账户持仓接口同样拒绝 USDGO 请求；不能把它当成成功且零持仓 |
| Bybit EU `/v5/earn/product` | HTTP 200、API 码 `180002` | EU 公开产品接口也拒绝 USDGO 请求 |

该检查没有原始 `retMsg`，但已核对 Bybit 官方[错误码表](https://bybit-exchange.github.io/docs/v5/error)：`180002` 的定义是 `Invalid coin`。因此可确认：**当前 Bybit Global 和 EU 的活期 Earn 产品/持仓请求不接受 USDGO 作为币种参数**，不是成功返回空列表。Bybit 定期 USDGO 本次为成功但空；这只说明定期接口本次没有产品行，不能推断所有 Bybit Earn/API 都不支持 USDGO。暂时不需要用户改 API 权限或重配密钥。

## 2026-10-03 15:04 UTC 重复确认

用户再次导出同一只读检查（上海时间 23:04）。与 14:59 报告逐格比较，64 个范围的产品/持仓状态、数量、ID、ID 匹配结果以及 `apiFailureSummary` 均未变化；仍为 `dataChangesCommitted=false`、`includesHoldingAmounts=false`。没有新的产品行或能力结论，但重复确认了 Bybit USDGO 活期失败：Global 产品与持仓请求在主机 `api.bybit.com`、备用主机 `api.bytick.com` 均为 HTTP 200 / API 码 `180002`，EU 产品请求在 `api.bybit.eu` 同样为 HTTP 200 / `180002`。该码已在官方错误码表中核实为 `Invalid coin`，因此对上述活期接口可以明确记为“不接受 USDGO”；不扩大到 Bybit 所有 Earn 产品或定期接口。

## 仍待完成的 API 评估（负责人）

| 范围 | 当前证据与缺口 | 下一步 / 负责人 |
|---|---|---|
| OKX Global 产品/APR（四币、活期/定期） | 官方文档含 `GET /api/v5/finance/staking-defi/offers`，但它是 On-chain Earn；匿名请求返回 HTTP 401 / `50103`，说明要鉴权。普通 Savings 的产品/APR清单端点仍未在正式文档中找到。Stable Rewards 的 `USDG` 不是 `USDGO`，且没有 APR。 | **Codex：**已在本地检查按钮中加入独立、只读的 On-chain offers 检查；**用户：**部署后运行一次并把 JSON 发回。结果不会等同于普通 Savings API。 |
| MEXC PH、UK 产品/APR 与持仓 | 已检查当前 MEXC 官方 API 目录与 Spot API 介绍；目录列 Spot、Futures、Broker、P2P、CLI，没有 Earn/Savings 产品接口。文档缺项不是“不支持”的证明；当前也没有可据以发起账户侧探测的官方 Earn 端点。 | **Codex：**公开文档核对已完成，暂记“官方资料未发现”；**用户：**目前无需配置或发送 MEXC 密钥。若之后找到 MEXC 官方财富 API 文档，再提供链接即可继续核实。 |
| Bitget 定期持仓与期限 | 官方 `/api/v2/earn/savings/product` 明确有 `periodType`、`period`、APY 档和状态；`/api/v2/earn/savings/assets` 接受 `periodType=flexible|fixed` 并返回产品 ID 和期限。2026-10-04 01:09 线上检查已请求四币 fixed 持仓，分页完整且均无持仓行。 | 新版探针已在线运行；本次账号的定期持仓接口成功返回空结果，不等于端点不支持，也不证明其他时间/账号为空。定期产品接口同次返回 USDT 3 行（7 天普通、7 天 VIP、14 天 VIP），尚未接入常规同步。 |
| Bybit EU 持仓 | 产品查询走公开接口；EU 持仓显示 `not_configured`，不是请求失败或零持仓。用户先前提供的 API 权限截图中未见 Earn 只读权限。 | 现有 Key 权限下不能验证 Earn 持仓；用户无需重复发截图或密钥。只有权限页面以后出现 Earn 只读项，才值得再配置凭证并实测。 |
| Bybit USDGO（FlexibleSaving、FixedTerm、OnChain、Hold To Earn、Dual Assets） | 2026-10-04 已直接查询公开目录：FlexibleSaving / OnChain 两区均以 `180002 Invalid coin` 拒绝 USDGO；显式按币种查 FixedTerm 两区都以 `180001 Invalid parameter: invalid coin` 拒绝；Global Hold To Earn 访客列表无 USDGO；Dual Assets 两区都以 `180002` 拒绝。EU Hold To Earn 返回 `180018 Internal error`，不能判断该类别。BYUSDT API 文档只支持 BYUSDT。 | **目前无需用户操作。**可以把已核的这些 Bybit 产品线判为“未提供/不接受 USDGO”；不能把结论外推到未逐个测试的其他 Advanced Earn 子类或未来新产品。 |

## 本轮 API 实测与探针范围

需要把“代码会调用接口”和“某次真实 API 响应返回了哪些产品”分开。代码/测试可以确认请求路径、解析与映射逻辑；真实产品 ID、状态和额度必须来自接口响应。探针应只用于尚未覆盖或现有诊断不足的组合，不需要机械地为 64 个格子各建一个探针。

| 平台账号 / 范围 | 当前代码实际调用 | 现有逐行诊断 | 是否需要新的专用探针 |
|---|---|---|---|
| 已接入的 Binance、Bybit、Bitget、OKX 范围 | API 设置新增“检查平台 API”按钮；手动读取 64 格静态矩阵中可请求的范围 | 返回逐格状态、行数、产品 ID、分页完整性及产品/持仓 ID 匹配；报告不返回金额或 API 凭证，也不持久化诊断结果；鉴权响应中的金额会在服务器内存中临时处理以生成正持仓标记 | 不用另建单项探针；部署后用户手动触发即可。`not_integrated` 表示常规同步没有接入，不等于交易所不支持。 |
| Binance Global、Bahrain：活期 USDT/USDC，定期四种资产 | 已接入的账户产品与持仓接口；常规刷新调用 | 活期 `binance_flexible_rows`；定期 `binance_locked_rows` | 通常不需要另建探针；要确认真实某次返回时，使用对应账号的刷新结果/脱敏诊断。 |
| Bybit Global：活期 USDT/USDC、定期四种资产 | 活期公开产品 + 账户持仓；定期公开产品 + 账户持仓 | 活期产品 `bybit_flexible_rows`、活期持仓 `bybit_flexible_position_rows`；本次统一只读探针取得了定期产品/持仓摘要，见上表 | 不另建探针；若后续要验证同一 ID 的不同期限是否对应独立持仓，再补充官方字段定义或真实定期持仓样本。 |
| Bybit EU：活期/定期产品，四种资产 | USDT 活期已用于常规 APR；检查按钮用公开 API 查询四币活期和四币定期产品；持仓探针需要 EU Key 具备 Earn 只读权限 | `bybit_flexible_rows`、`bybit_flexible_position_rows`；公开定期检查不写运行日志 | 01:09 线上检查已成功返回多个币种的活期/定期产品目录；USDGO 活期为 `180002`。用户提供的 Key 权限截图未见 Earn 只读项，因此当前不能验证 EU 持仓；不是忘记索取截图。 |
| Bitget Global：活期 USDT/USDC | 已接入账户产品与持仓接口；常规刷新调用 | `bitget_product_rows`、`bitget_assets_rows` | 通常不需要另建探针。 |
| Bitget Global：USDGO、BTC 及定期产品列表/持仓 | 常规同步尚未覆盖全部范围；汇总探针只读检查四种资产产品，并分别请求 flexible、fixed 两类持仓分页 | 2026-10-04 01:09 报告列出产品 ID、状态、VIP 层级、APY 档数量、`period`、分页完整性和正持仓布尔值；金额不返回，探针结果不持久化 | 新版已部署并完成一次检查。USDT fixed 有 3 个产品行，四币 fixed 持仓均完整但为空；USDGO/BTC 产品检查成功但为空。 |
| OKX：产品/APR | 当前未接入产品/APR 适配器；文档找到 On-chain Earn offers 端点，但属于单独类别 | 尚无此账号四币 offers 真实返回；稳定币 Stable Rewards 文档仅有 USDG 且无 APY 字段 | 需要另行实现只读探针/确认类别边界后再用已保存只读凭证请求；不将 UI Savings 的非文档端点当正式来源。 |
| MEXC PH/UK：产品/APR、持仓 | 当前未接入，也无 API 凭证入口；官方 API 目录未列 Earn/Savings | 无可确认的产品行或持仓返回 | 继续按“官方 API 尚未证实”记录；找到 MEXC 官方财富 API 文档后再设计安全探针，不先收集密钥。 |
| Bitget 尚未接入的 BTC、定期，以及 Bybit EU 尚未接入的格子 | 常规同步不会请求 | 无 | 先查官方接口和代码支持范围；只有找到明确候选接口后才探测，不因矩阵有空格就盲目请求。 |

**用户需要提供的线上信息仅限必要的鉴权实测结果。**API 密钥不应发送；如需账号侧探针，服务器使用已保存凭证，向用户返回脱敏摘要。公开端点若能由维护环境直接访问，则无需用户代查。单次探针只证明这次返回情况，不自动启用接口或修改矩阵。

## 产品目录筛选规则

以下是当前目录筛选规则；各平台适配器仍需逐步统一，并用线上响应继续验证。

1. **先限定范围。**只处理矩阵覆盖的四种资产和对应的活期/定期类型；定期接口返回的记录不能混入活期产品，反之亦然。
2. **区分产品与额度档位。**不同稳定外部产品 ID 是不同产品，应分别建立身份并按 ID 匹配持仓；同一产品记录内部的多个 APR/额度档位仍是一个产品。若持仓接口只有币种级总额，不能把总额复制到多个产品行。
3. **普通机会只纳入可申购的非 VIP 产品。**产品需是当前可申购状态；状态未知时不推断为可申购。VIP 专属或明确下线/售罄的无持仓产品，不作为普通机会行展示。APR 门槛和期限按当前机会规则：活期 APR ≥ 6%；定期 APR ≥ 6% 且期限 ≤ 7 天。
4. **正数持仓优先保留。**只要有正数持仓，即使产品是 VIP、APR 低于门槛、期限较长、售罄或已下线，也保留对应产品行，并明确显示资格/不可申购状态；不得将持仓金额挪到同币种的另一产品。
5. **未知持仓不当作零。**单次失败、分页不完整或字段未知都不构成归档依据。已有活动行在持仓状态未知时继续保留。
6. **归档而不是物理删除。**只有完整、权威的产品与持仓同步确认产品不再合规且持仓为零时，才从活动目录归档；数据库历史、产品变更记录和可恢复的关联数据保留。
7. **手动产品不受 API 筛选器影响。**用户手动维护的产品继续按手动产品生命周期处理。

## 已知的不一致与改造边界

- Bitget 已修正 VIP 持仓过滤：无持仓的 VIP 产品不作为普通机会；正数 VIP 持仓会按外部产品 ID 单独保留并标记资格待确认。若该持仓响应没有 APR，也会保留产品行并标记 APR 不可用。
- Bitget 会从普通产品候选中过滤明确 `off_line` 产品；若持仓接口仍返回该产品，持仓行可作为 held-only 产品恢复，但仍需检查是否保留了明确下线状态。
- 2026-10-03 的线上样本中，Bitget 产品列表对 USDT 返回了 3 条 `fixed` 行、对 USDC 没有返回 `fixed` 行；当前常规适配器只把 `flexible` 行转成目录产品，因此 USDT 定期仍未接入。官方文档已确认定期 `period` 字段和 `periodType=fixed` 持仓端点；本次线上旧报告未查定期持仓，新版只读诊断尚待部署后验证，不能只凭 APR 行就启用定期产品。
- Bybit 定期适配器仍会提供 VIP/特殊资格产品候选；目录现在会排除资格未知且无持仓的产品，已确认有资格的或正数持仓产品会保留。已有行在持仓未知时暂留，避免部分同步时误归档。
- Binance 活期和 Bybit 活期现按上游产品 ID 生成独立产品记录；Binance 的持仓与 APR/产品通过产品 ID 对应，Bybit 持仓也按产品 ID 保存。若交易所响应缺少产品 ID 且同时有多个候选产品，适配器不猜测归属；Binance 会将相应清单标记为不完整。
- 本地回归测试已模拟同一币种返回两个产品及两笔不同金额的持仓，分别验证 ID、APR 和持仓不会合并。线上日志仅用于确认真实交易所响应是否提供所需 ID，不再是验证这项映射逻辑的前置条件。

## 后续发现机制

- 已接入的产品接口可在正常同步时比较外部产品 ID、资产、类型和可申购状态，记录新行、消失和状态变化。
- 未接入、未请求的接口不能靠例行同步自动发现。需定期检查交易所官方 API 文档/更新说明，并对“尚未核实”的矩阵格执行一次性、只读探测。
- 单次探测不自动启用接口、不改 D1；确认接口和返回结构后，由维护者更新 `platform-capabilities.ts` 和对应适配器及测试。

## 2026-10-04 官方 API 文档复核

本次复核回答“交易所是否有可用于产品/收益评估的官方接口”，不等同于每个账号、币种都已在线返回产品。必须分开记录：官方文档有端点、端点可请求、该区域返回产品行、产品能用于当前目录，是四个不同结论。

| 平台 | 官方文档证据 | 对四币 × 活期/定期目标的结论 | 尚缺什么 |
|---|---|---|---|
| Bybit Global / EU | [Easy & On-chain Earn 产品资料](https://bybit-exchange.github.io/docs/v5/finance/earn/easy-onchain/product-info) 的 `GET /v5/earn/product` 明确无需鉴权，`category` 可选 `FlexibleSaving` / `OnChain`；[Fixed Saving 产品资料](https://bybit-exchange.github.io/docs/v5/finance/earn/fixed-saving/product) 的 `GET /v5/earn/fixed-term/product` 也明确无需鉴权，返回币种、期限、APY 档、状态和 VIP 标记。 | 2026-10-04 直接查询 Global/EU 两个公开 API 主机、四币、三类目录（FlexibleSaving、OnChain、FixedTerm），结果见下表。标准活期 USDGO 在两区都被 `180002 Invalid coin` 拒绝；定期若显式传 `coin=USDGO`，返回 `180001 Invalid parameter: invalid coin`。 | OnChain、Hold To Earn、Advanced Earn 等属于不同产品类别，不是当前 64 格简单 Savings 的等价项；它们已另行逐类检查，结果见下文。EU 的实际持仓仍需区域凭证；本次没有 EU 持仓凭证。 |
| Bitget Global | 官方 [Classic Earn Savings 文档](https://www.bitget.com/docs/catalog/earn-classic-savings/classic-earn-savings) 列出 `GET /api/v2/earn/savings/product`；响应有 `periodType=flexible|fixed`、`period`、APY 档和产品状态。`GET /api/v2/earn/savings/assets` 可用 `periodType=flexible|fixed` 分别查询持仓；响应可按 `productId` 与 `period` 识别产品。 | 产品 API 与两类持仓 API 都存在。10/03 线上产品探针曾见 USDT 定期 3 行、USDC/USDGO/BTC 定期成功但空；活期 USDT/USDC 有行，USDGO/BTC 成功但空。 | 上述旧探针只请求了 flexible 持仓。当前本地检查代码已添加 fixed 持仓查询及脱敏的 `period` 输出，但要部署后才能看到该用户真实的定期持仓 ID/期限并核对匹配。未因此启用 Bitget 定期常规同步。 |
| OKX Global | 官方[金融产品 API 文档](https://www.okx.com/docs-v5/en/#financial-product) 列出 `GET /api/v5/finance/staking-defi/offers`，用于查询 On-chain Earn offers。 | 2026-10-04 对 USDT、USDC、USDGO、BTC 逐一匿名请求均返回 HTTP 401 / OKX `50103`（缺少 `OK-ACCESS-KEY`）；这只能确认该接口需要账户鉴权，不能当作产品空列表。Stable Rewards 示例为 `USDG`（非 `USDGO`），且没有 APR。普通 Savings 的正式产品/APR端点仍未找到。 | 本地“检查平台 API”现在会对四币分别请求 On-chain offers，并将其作为 `additionalProbes` 单独报告；部署后用已保存凭证实测。不得将结果混入普通 Savings 矩阵。 |
| MEXC PH / UK | 当前官方 API 文档目录列出 Spot、Futures、Broker、P2P、CLI；[Spot API 介绍](https://www.mexc.com/api-docs/spot-v3/introduction) 描述市场、账户、交易等接口，未列 Earn/Savings 产品线。 | 暂无可核实的官方 Earn/Savings 产品/APR 或持仓 API 端点。PH/UK 的手动产品记录继续保留。 | “目录没列”不能证明绝无未公开或区域专属接口。只有 MEXC 官方新增文档/明确答复，或找到可重复、可授权的官方 API 端点后，才能把状态改为“确认不支持”或“已返回”。 |

**Bybit 的“其他 Earn”已逐类查过可对应的官方产品 API；结论不能互相代替。**

| 产品线 | 官方接口与当前只读实测 | USDGO 结论 / 是否属于 64 格 |
|---|---|---|
| 标准活期 FlexibleSaving | `GET /v5/earn/product?category=FlexibleSaving&coin=...`；Global、EU 的 USDT/USDC/BTC 均各返回 1 个产品；USDGO 两区均 `180002 Invalid coin` | 当前矩阵中的活期；可确认两区该接口不接受 USDGO |
| On-Chain Earn | `GET /v5/earn/product?category=OnChain&coin=...`；Global 返回 USDT 2、USDC 2、BTC 1；EU 四币均成功但无行；两区 USDGO 都 `180002 Invalid coin` | 不是普通储蓄；可确认该 On-Chain 产品接口不接受 USDGO |
| Fixed Saving | `GET /v5/earn/fixed-term/product?coin=...`；Global：USDT 6、USDC 1、BTC 2；EU：USDT 0、USDC 2、BTC 3；显式查 USDGO 两区均返回 `180001 Invalid parameter: invalid coin`。原始行包含 VIP、特殊用户组、售罄等状态，数量不等于符合目录准入规则的数量 | 当前矩阵中的定期；可确认该接口显式查询 USDGO 会拒绝 |
| Hold To Earn 空投 | 官方 `GET /v5/earn/hold-to-earn/product` 支持访客查询，且会按地区/资格过滤。Global 访客列表有 4 项：RLUSD、USD1、USDTB、USDE，没有四种监控资产；EU 返回 `180018 Internal error` | 属于空投收益，不是普通储蓄；Global 本次没有目标资产，EU 请求失败，不能据此判定 EU 无产品 |
| Advanced Earn Dual Assets | 官方 `GET /v5/earn/advance/product?category=DualAssets&coin=...`。Global：USDT 162、USDC 0、BTC 28；EU：前三种可用币均 0；USDGO 两区均 `180002 Invalid coin` | 双币结构化产品，收益和本金结算方式不同，不纳入简单储蓄矩阵；该子类不接受 USDGO |
| BYUSDT | 官方 `GET /v5/earn/token/product` 文档明确当前仅支持 token `BYUSDT` | 不是 USDT/USDC/USDGO/BTC 这四种资产的储蓄 API |

以上直接请求均为公开产品目录读取，不带账户密钥、不下单、不写用户数据。这里可以把结论限定为“已核的这些 Bybit 官方 Earn 产品接口”；不把未逐个纳入检查的其他 Advanced Earn 子类或未来新增产品类别一概断言为不支持 USDGO。On-chain、Hold To Earn 和 Dual Assets 的业务性质也不同，不能直接作为普通活期/定期产品加入当前机会表。

## 2026-10-04 线上 64 格只读检查

由线上应用“API 设置 → 检查平台 API”触发。00:46 与 01:09 两次报告均覆盖 64 个范围，声明 `dataChangesCommitted=false`、`includesHoldingAmounts=false`。下表先记录 00:46 结果；随后追加 01:09 新部署版本的增量结果。

| 平台 | 本次线上结果 | 仍缺什么 |
|---|---|---|
| Binance Global / Bahrain | 活期 USDT、USDC 各 1 个产品，产品与持仓 ID 均匹配且有正持仓；BTC 活期各有 1 个产品行、无持仓；USDGO 活期为空。四种资产的定期产品/持仓请求均完整但为空。 | 本次已回答线上账号的 API 行返回情况；不能由“定期空”推断 Binance 公开文档没有对应端点，产品/持仓端点需要账号鉴权。 |
| Bybit Global | 活期 USDT、USDC、BTC 各 1 行；USDGO 活期产品与持仓请求被 `180002` 拒绝。定期 USDT 6 行、USDC 1 行、BTC 2 行，USDGO 的未筛选目录为空；产品行均保留期限，存在 VIP/特殊用户组/售罄状态。 | EU 持仓凭证未配置；固定期限 ID 必须连同期限使用，不能仅凭重复的 `productId` 合并。 |
| Bybit EU | 活期 USDT、USDC、BTC 各 1 行；USDGO 活期报 `180002`。定期 USDC 2 行、BTC 3 行，USDT 与 USDGO 未筛选目录无行。 | 线上报告显示持仓未配置；用户提供的 Key 权限截图也未见 Earn 只读项。本次线上报表里固定 USDGO 的“空”是全量列表筛选结果，单独按 USDGO 查询的真实错误码以上述直接 API 请求为准。 |
| Bitget Global | 活期 USDT、USDC 各 3 行（各含普通与 VIP），各有 1 个持仓 ID 与产品匹配；USDGO、BTC 活期成功但为空。定期 USDT 产品 3 行（1 普通、2 VIP），USDC/USDGO/BTC 为空。 | **本次部署版本尚未检查 fixed 持仓**，报告标成 `not_integrated`。工作区中的新版已补 fixed 持仓请求和期限摘要，部署后才会有真实账号结果。 |
| OKX Global | 余额接口仅发现 USDC；普通 Savings 产品/APR 仍未发现正式文档端点。On-chain offers 已在本地检查按钮中增加独立探针。 | 需要部署本地改动并运行一次检查，才能得到线上已保存凭证下四币各自的 offers 返回情况；这不会启用普通 Savings 同步。 |
| MEXC PH / UK | 64 格报告中全部为 `not_integrated`，没有发送 API 请求。 | 官方当前公开文档目录未找到 Earn/Savings 产品接口，保持“尚无可核实端点”，不把它误写成“交易所确定不支持”。 |

线上 Bybit 报告的 `apiFailureSummary` 将 USDGO 活期产品和 Global 持仓拒绝明确归为 HTTP 200 / API 码 `180002`；这是交易所应用层错误，不是网络超时。Bybit EU 报告将持仓标为 `not_configured`，不是“零持仓”；用户此前给的 Key 权限截图未见 Earn 只读权限，解释了为何当前凭证无法进行私有 Earn 持仓验证。

### 2026-10-04 01:09 上海时间：新版部署后的增量结果

来源：用户提供的线上 API 设置检查 JSON，`generatedAt=2026-10-03T17:09:44.918Z`（上海时间 2026-10-04 01:09）。报告覆盖 64 个范围，`dataChangesCommitted=false`、`includesHoldingAmounts=false`，没有 `partial`；Bybit USDGO 活期仍以 API 错误码 `180002` 失败。

| 平台 / 范围 | 本次新证据 | 结论边界 |
|---|---|---|
| Binance Global / Bahrain | 活期 USDT、USDC 产品与持仓 ID 各匹配 1 行；BTC 活期产品各返回 1 行、持仓为空；USDGO 活期为空。两账号四币定期产品与持仓均完整但为空。 | BTC 活期产品端点本次确实返回产品资料，但代码常规同步尚未接入；定期成功但空不能证明交易所不支持。 |
| Bybit Global | 活期 USDT 产品 1 行、持仓空；USDC 产品和持仓各 1 行且 ID 匹配，但持仓 `hasPositiveHolding=false`。定期 USDT 6 行、USDC 1 行、BTC 2 行，持仓均空；USDGO 活期产品和持仓请求被 `180002` 拒绝。 | USDC 有匹配的持仓记录，但本次未检测到正数余额。`180002` 是 Bybit API 对 USDGO 的应用层拒绝，不是网络故障；不外推到其他 Earn 产品类别。 |
| Bybit EU | 活期 USDT、USDC、BTC 各 1 行；USDGO 活期报 `180002`。定期 USDC 2 行、BTC 3 行；USDT、USDGO 成功但空。四币活期持仓 `not_configured`，四币定期持仓 `not_integrated`。 | 公开产品接口已有返回证据；用户权限截图中未见 Earn 只读权限，因此账户 Earn 持仓无法用现有凭证验证；`not_configured` 不是零持仓。 |
| Bitget Global | 活期 USDT、USDC 各 3 个产品，分别有 1 个持仓 ID 与产品匹配；USDGO、BTC 活期产品/持仓均完整但为空。定期 USDT 3 个产品（7 天普通、7 天 VIP、14 天 VIP），其他三币产品为空；四币定期持仓请求均完整但为空。 | **确认新版部署并成功运行了 fixed 持仓探针。**“空”只说明本次账号没有对应持仓行。定期产品仍未加入常规同步。报告中的 fixed 行 `eligibleForMonitoring=false` 是活期准入字段被错误用于定期行；本地探针已改为只对活期输出该字段，部署后新版报告会避免误导。 |
| OKX Global | 活期余额接口本次只观察到 USDC；USDT、USDGO、BTC 未出现；产品/APR 未接入，定期未接入。 | 这是余额/持仓观察，不是产品/APR API 证据。 |
| MEXC PH / UK | 产品及持仓的活期/定期格子全部 `not_integrated`。 | 本次没有发出请求，不产生 MEXC 支持/不支持的新结论。 |

报告没有金额字段，也没有把结果写入数据；不过鉴权持仓接口的原始响应会在服务器内存中被处理，以形成 `hasPositiveHolding` 等布尔摘要。Bitget fixed 行的 `eligibleForMonitoring=false` 存在语义误导：该字段只适用于活期准入判断。本地探针现已改为不在 fixed 行生成此字段；要让线上弹窗采用修正版，需随下次代码发布部署。

### 本次本地探针改动

- API 设置里的“检查平台 API”现在会对 Bitget Savings 持仓接口分别传 `periodType=flexible` 和 `periodType=fixed`；固定产品行与定期持仓行都记录 `period`。2026-10-04 01:09 的线上报告确认新版已部署并成功完成 fixed 查询。
- 摘要只返回产品 ID、期限、状态、档位数量和“是否存在正数持仓”，不返回金额，也不写产品目录、缓存或变更历史；但服务器会在内存中处理接口原始持仓响应中的金额。
- `Bitget Global` 的定期能力矩阵标记仍保持 `manual`，即常规同步不启用这条产品/持仓路径；此次只是扩充一次性只读诊断。
- OKX 的官方 `/api/v5/finance/staking-defi/offers` 已加入独立只读探针，按 USDT、USDC、USDGO、BTC 查询。报告仅含产品标识、协议、期限、状态与 APY，不含投资额/收益金额；该 On-chain Earn 类别不会映射进普通活期/定期产品格，也不会改常规同步矩阵。测试已覆盖签名请求、按币种筛选和金额脱敏。
- MEXC PH/UK 官方 API 目录复核已完成：当前公开目录没有列 Earn/Savings 产品/APR 或持仓端点。该结论是“官方资料未发现”，不是“交易所确认不支持”；目前不需要用户提供 MEXC 凭证。
- 2026-10-04 代理开启后 Bybit 官方文档和公开目录 API 均可读；Binance 官方 Simple Earn 文档索引也可读，并确认柔性/锁定产品清单与持仓端点属于 `USER_DATA`，故需账号 Key。线上 64 格检查覆盖 Binance、Bybit、Bitget、OKX 的现有配置；MEXC 当前没有 API 接入。Bitget fixed 持仓探针已部署，但能力矩阵仍未因此自动改成常规同步 API。

**下一步 / 负责人：**用户部署当前代码后，在“API 设置 → 检查平台 API”运行一次检查，把完整 JSON 发回。Codex 再据 `additionalProbes` 里的四币状态、产品行和安全错误摘要更新 OKX 的实测结论；普通 Savings 与 On-chain Earn 继续分开记录。MEXC 暂无用户操作项，除非之后找到新的官方端点资料。

## 代码来源

- 覆盖配置：`lib/platform-capabilities.ts`
- 产品/APR 及持仓适配器：`lib/integrations/`
- 目录准入与归档：`lib/product-catalog.ts`、`lib/opportunity-policy.ts`
- 稳定身份和外部 ID 映射：`lib/product-identity.ts`
- 矩阵回归测试：`tests/platform-capabilities.test.mjs`
