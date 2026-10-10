import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readDoc = (name) => readFileSync(new URL(`../docs/${name}.md`, import.meta.url), "utf8");

test("APR and capacity policy tables retain every separately agreed scenario", () => {
  const document = readDoc("DATA-STATES");
  const apr = document.split("#### APR\n")[1]?.split("#### 额度\n")[0] ?? "";
  const capacity = document.split("#### 额度\n")[1]?.split("活期不需要买入日期")[0] ?? "";
  assert.equal([...apr.matchAll(/^\|.*\|$/gm)].length - 2, 7);
  assert.equal([...capacity.matchAll(/^\|.*\|$/gm)].length - 2, 10);
  assert.match(apr, /包括明确的 0/);
  assert.match(capacity, /已确认的末档 `null` 例外/);
  for (const section of [apr, capacity]) {
    assert.match(section, /未返回，但持仓显示仍持有/);
    assert.match(section, /API 管理显示/);
    assert.match(section, /手动维护显示/);
  }
});

test("capability summary separates invalid product fields from incomplete requests and dust from zero", () => {
  const document = readDoc("PLATFORM-CAPABILITIES").split("## 空、部分、失败及目录处理规则")[1] ?? "";
  const partialRow = document.split("\n").find((line) => line.startsWith("| `partial`")) ?? "";
  assert.match(partialRow, /分页未完成、查询范围不全/);
  assert.match(partialRow, /单个产品 APR\/额度异常本身不代表请求部分返回/);
  assert.doesNotMatch(partialRow, /分页未完成、字段缺失/);
  assert.match(document, /持仓 `≤0\.01` 已不满足持仓门槛，不要求必须为零/);
  assert.match(document, /用户手动“移除产品”的零持仓限制是另一项操作/);
});

test("parsing rules distinguish last-tier null from independent subscription-limit null", () => {
  const document = readDoc("API-APR-CAPACITY-RULES");
  assert.match(document, /末档边界原始值 `null` 也表示“未提供该档上限”/);
  assert.match(document, /不适用于中间档边界或独立产品申购上限/);
  assert.match(document, /`maxStakeAmount`.*`null`、空字符串或不可解析值时是不可读，不是不限额/);
});

test("incomplete schedules remain excluded as whole products and empty editing regions are forbidden", () => {
  const document = readDoc("DATA-STATES");
  const metrics = document.split("| 顶部指标 | 计算范围 |")[1]?.split("### 产品移除与 API 断开")[0] ?? "";
  assert.match(metrics, /最佳首档 APR.*方案不完整时整款排除/);
  assert.match(metrics, /高息剩余额度.*方案不完整时整款排除，不只排除未知档/);
  assert.match(document, /展示已知字段不等于参与计算/);
  assert.match(readDoc("DESIGN-SYSTEM"), /没有任何输入项时，不生成外层分隔线、内边距或空白容器/);
});
