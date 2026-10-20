import type { ProductChangeEvent, ProductHistorySummary } from "./domain";

/** Ignore stale responses: inserts increase count, reads only decrease unread count. */
export function mergeProductHistorySummaries(current: ProductHistorySummary[] = [], incoming: ProductHistorySummary[]) {
  const merged = new Map(current.map((summary) => [summary.productId, summary]));
  for (const summary of incoming) {
    const previous = merged.get(summary.productId);
    if (!previous || summary.eventCount > previous.eventCount) merged.set(summary.productId, summary);
    else if (summary.eventCount === previous.eventCount) {
      merged.set(summary.productId, { ...summary, unreadCount: Math.min(previous.unreadCount, summary.unreadCount) });
    }
  }
  return [...merged.values()];
}

/** Keep loaded older pages when a refreshed snapshot or first page arrives. */
export function mergeProductHistoryEvents(...groups: ProductChangeEvent[][]) {
  const merged = new Map<string, ProductChangeEvent>();
  for (const group of groups) {
    for (const event of group) {
      const previous = merged.get(event.id);
      merged.set(event.id, { ...event, ...(previous?.readAt && !event.readAt ? { readAt: previous.readAt } : {}) });
    }
  }
  return [...merged.values()].sort((left, right) => right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id));
}

/** Read-state changes alone do not invalidate the already loaded history. */
export function productHistoryRevision(events: ProductChangeEvent[]) {
  return JSON.stringify(events.map((event) => event.id).sort());
}

/** Snapshot props also contain older, unpaged history; only bring in new head events. */
export function mergeNewProductHistoryEvents(loaded: ProductChangeEvent[], incoming: ProductChangeEvent[], initialSnapshotIds: string[] = []) {
  const newest = loaded[0]?.observedAt;
  if (!newest) return loaded;
  const loadedIds = new Set(loaded.map((event) => event.id));
  const initialIds = new Set(initialSnapshotIds);
  return mergeProductHistoryEvents(loaded, incoming.filter((event) => loadedIds.has(event.id)
    || (!initialIds.has(event.id) && event.observedAt >= newest)));
}
