import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function formatters() {
  const creations = [];
  const observedIntl = Object.create(Intl);
  observedIntl.NumberFormat = class extends Intl.NumberFormat {
    constructor(...args) { super(...args); creations.push({ kind: "number", args }); }
  };
  observedIntl.DateTimeFormat = class extends Intl.DateTimeFormat {
    constructor(...args) { super(...args); creations.push({ kind: "date", args }); }
  };
  const load = moduleLoader({
    "@/app/components/product-history": {},
    "@/app/components/ui": {},
    "@/app/components/dashboard/product-inputs": {},
    "@/app/components/dashboard/purchase-date-input": {},
  }, { Intl: observedIntl });
  return {
    formatAmount: load("@/lib/domain").formatAmount,
    formatSyncDateTime: load("@/app/components/dashboard/product-row.tsx").formatSyncDateTime,
    creations,
  };
}

function originalAmount(value) {
  if (value !== 0 && Math.abs(value) < 0.01) return value > 0 ? "<0.01" : ">-0.01";
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function originalDateTime(value) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

test("reused amount formatter is byte-for-byte equivalent at small-value, rounding and numeric boundaries", () => {
  const { formatAmount } = formatters();
  const values = [0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, 0.00999999, -0.00999999,
    0.01, -0.01, 0.0149, -0.0149, 0.015, -0.015, 1.005, -1.005,
    999.999, 1234567.89, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, NaN, Infinity, -Infinity,
    ...Array.from({ length: 200 }, (_, index) => (index - 100) * 1234.56789)];
  for (const value of values) assert.equal(formatAmount(value), originalAmount(value), `value ${value}`);
});

test("reused sync timestamp formatter preserves invalid input and Shanghai calendar/clock boundaries", () => {
  const { formatSyncDateTime } = formatters();
  const values = ["", "bad-date", "2026-13-01T00:00:00Z", "2026-10-20T00:00:00Z",
    "2026-10-19T15:59:59.999Z", "2026-10-19T16:00:00.000Z", "2026-12-31T16:00:00Z",
    "2024-02-29T15:59:59Z", "2024-02-29T16:00:00Z", "2026-01-01", "2026-10-20T08:07:06+08:00",
    "1969-12-31T23:59:59Z", "+275760-09-13T00:00:00.000Z"];
  for (const value of values) assert.equal(formatSyncDateTime(value), originalDateTime(value), value);
  assert.equal(formatSyncDateTime("2026-10-05T02:03:00.000Z"), "10/05 10:03");
});

test("repeated formatting constructs neither a new amount nor a new sync date formatter", () => {
  const { formatAmount, formatSyncDateTime, creations } = formatters();
  const before = creations.length;
  assert.equal(creations.filter(({ kind }) => kind === "number").length, 1);
  assert.equal(creations.filter(({ kind, args }) => kind === "date" && args[0] === "zh-CN").length, 1);
  for (let index = 0; index < 100; index++) {
    formatAmount(index + 0.12);
    formatSyncDateTime("2026-10-20T00:00:00Z");
    formatSyncDateTime("bad-date");
  }
  assert.equal(creations.length, before);
});
