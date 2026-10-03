import type { HoldingPosition } from "./domain";

/** Preserve each holding's source time across repeated partial or total failures. */
export function cachedHoldingTimes(
  holdings: Record<string, number>,
  previousFallbacks: Record<string, string>,
  snapshotTime: string,
): Record<string, string> {
  return Object.fromEntries(Object.keys(holdings).map((id) => [
    id, previousFallbacks[id] ?? snapshotTime,
  ]));
}

/** Only a new refresh result can supply holdings to save; reading cache cannot. */
export function freshHoldingIdsForSave(
  holdings: Record<string, number>,
  fallbacks: Record<string, string>,
  cacheState: string | undefined,
  silent = false,
): string[] {
  if (silent || cacheState !== "updated") return [];
  return Object.keys(holdings).filter((id) => !Object.hasOwn(fallbacks, id));
}

/**
 * Merge incremental position reads, but replace the previous snapshot for
 * accounts whose position endpoints completed successfully. An empty complete
 * result is therefore authoritative; an empty partial result is not.
 */
export function mergeHoldingPositions(
  previous: HoldingPosition[],
  fresh: HoldingPosition[],
  completeAccounts: ReadonlySet<string>,
  accountByProductId: Record<string, string>,
) {
  const positions = new Map<string, HoldingPosition>();
  for (const position of previous) {
    const accountId = position.accountId ?? accountByProductId[position.productId];
    if (accountId && completeAccounts.has(accountId)) continue;
    positions.set(holdingPositionKey(position), position);
  }
  for (const position of fresh) positions.set(holdingPositionKey(position), position);
  return [...positions.values()];
}

function holdingPositionKey(position: Pick<HoldingPosition, "productId" | "positionId" | "purchaseAt" | "redeemAt">) {
  return [position.productId, position.positionId ?? "", position.purchaseAt ?? "", position.redeemAt ?? ""].join("\u0000");
}
