# 产品身份与 ID 规则

这份文档是产品身份、数据库行 ID 和平台外部 ID 的唯一说明。代码实现分别位于 `lib/product-identity.ts`、`lib/product-catalog.ts` 和 `lib/platform-capabilities.ts`。

## 四种 ID，各自只做一件事

| 名称 | 作用 | 是否用于展示/匹配 | 是否允许随 APR 变化 |
|---|---|---:|---:|
| `externalProductId` | 平台 API 返回的真实产品 ID | 用于识别平台产品 | 否 |
| `identityKey` | 应用层的稳定产品身份 | 是，API 和持仓统一靠它匹配 | 否 |
| `product_id` | D1 中的持久化行 ID，也是各表外键 | 是，用于数据库关联 | 否 |
| `identityFingerprint` | 身份快照诊断信息 | 否，只用于审计 | 可以变化 |

`identityKey` 和 `product_id` 不要求相等。前者回答“这是不是同一个平台产品”，后者回答“数据库里引用哪一行”。已有 `product_id` 是持久化外键，不能因为命名不统一就直接重命名。

## `identityKey` 格式

### API 产品

```text
<accountId>:<ASSET>:<productType>:<externalProductId>
```

例如：

```text
bybit-global:USDT:flexible:1
bybit-global:USDC:flexible:2
bitget-global:USDT:flexible:bg-usdt-standard
```

`accountId` 已经包含平台和区域，例如 `binance-global`、`binance-bahrain`、`bybit-eu`。`ASSET` 使用大写；`productType` 只能是 `flexible` 或 `fixed`。

### 手动产品

```text
<accountId>:<ASSET>:<productType>:manual:<slug>
```

例如：

```text
mexc-uk:USDT:flexible:manual:my-savings
okx-global:BTC:flexible:manual:btc-campaign
```

手动产品的 `slug` 会转成小写、短横线格式。APR、额度、资格、买入日、申购窗口和奖励活动都不是身份的一部分。

## `product_id` 格式和生命周期

- 新 API 产品：`api-<稳定名称>-<稳定哈希>`。
- 新手动产品：`manual-<UUID>`。
- 旧产品：保留原来的 ID，即使旧 ID 以平台缩写、API 或历史模板名称开头。
- `product_identity_aliases` 保存旧 ID 或旧身份到当前 `product_id` 的兼容映射。
- 外部产品 ID 变化时，通常代表平台创建了新产品身份；新产品使用新的 `identityKey`，数据库可以新增一行。旧行只有在确认无持仓后才归档，不直接删除。

数据库行 ID 不因为 APR、额度、资格或时间窗口变化而改变。数据库行被持仓、明细持仓、覆盖设置、隐藏记录和同步快照引用，因此物理重命名必须是单独的迁移任务，不能在普通同步中进行。

## 明确禁止的做法

- 不再引入平台内部“产品族 ID”作为统一身份。
- 不把 `canonicalProductId` 当作新的业务概念；它只是旧版本兼容名称。
- 不把 APR、额度、资格、活动期限或买入/赎回时间拼进身份。
- 不把未知持仓当成零持仓，也不因单次 API 缺失就新建重复产品。
- 不用手动填写的展示名称替代平台真实产品 ID。

## 规则来源索引

| 规则 | 唯一代码来源 | 配套文档 |
|---|---|---|
| API/手动 `identityKey` | `lib/product-identity.ts` | 本文 |
| 数据库目录匹配与归档 | `lib/product-catalog.ts` | `docs/DATA-STATES.md` |
| 平台 × 区域 × 资产 × 产品类型 API 能力 | `lib/platform-capabilities.ts` | `docs/PLATFORM-CAPABILITIES.md`、`docs/DATA-STATES.md` |
| API 字段是否支持 | `lib/api-capabilities.ts` | `docs/DATA-STATES.md` |
| 产品是否进入展示目录 | `lib/opportunity-policy.ts` | `docs/DATA-STATES.md` |
| 缓存、失败和持仓状态 | `lib/product-status.ts`、`lib/sync-cache.ts` | `docs/DATA-STATES.md` |
| 颜色、间距和组件 | `app/globals.css` | `docs/DESIGN-SYSTEM.md` |
