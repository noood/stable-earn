import type { HoldingPosition } from "./domain";
import { dateOnlyFromTimestamp } from "./product-overrides";

/** A product-level date is usable only when every positive API position has one. */
export function summarizeHoldingTiming(positions: HoldingPosition[]) {
  const apiPositions = positions.filter((position) => position.source === "api");
  const positiveApiPositions = apiPositions.filter((position) => position.amount > 0);
  return {
    positions: positiveApiPositions,
    singlePosition: positiveApiPositions.length === 1
      ? positiveApiPositions[0]
      : positiveApiPositions.length === 0 && apiPositions.length === 1 ? apiPositions[0] : undefined,
    completePurchaseTiming: positiveApiPositions.length > 0
      && positiveApiPositions.every((position) => Boolean(dateOnlyFromTimestamp(position.purchaseAt))),
  };
}

export type HoldingTiming = ReturnType<typeof summarizeHoldingTiming>;

export function hasCompletePurchaseTiming(timing: HoldingTiming | undefined, holding: number) {
  if (!timing?.completePurchaseTiming || holding <= 0) return false;
  const positionTotal = timing.positions.reduce((sum, position) => sum + position.amount, 0);
  return Math.abs(positionTotal - holding) <= Math.max(1e-8, holding * 1e-9);
}
