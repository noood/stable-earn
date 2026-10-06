import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("exchange numeric parsing requires the whole value to match the accepted format", () => {
  const { parseExchangeNumber } = moduleLoader()("@/lib/exchange-number");

  assert.equal(parseExchangeNumber(null), undefined);
  assert.equal(parseExchangeNumber(undefined), undefined);
  assert.equal(parseExchangeNumber("  "), undefined);
  assert.equal(parseExchangeNumber("1000abc"), undefined);
  assert.equal(parseExchangeNumber("2.5%"), undefined);
  assert.equal(parseExchangeNumber("2.5%", { allowPercentSuffix: true }), 2.5);
  assert.equal(parseExchangeNumber("2.5%oops", { allowPercentSuffix: true }), undefined);
  assert.equal(parseExchangeNumber("1,234.56", { allowThousandsSeparators: true }), 1234.56);
  assert.equal(parseExchangeNumber("1,,234", { allowThousandsSeparators: true }), undefined);
  assert.equal(parseExchangeNumber("1,234"), undefined);
});
