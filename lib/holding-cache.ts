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
