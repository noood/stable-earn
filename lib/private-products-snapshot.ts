import type { D1Database } from "@cloudflare/workers-types";
import { parseSyncCacheRow, type SyncCacheRow } from "./sync-cache";
import { manualRefreshCooldownMs, normalizeManualRefreshCooldown } from "./user-settings";

type PrivateProductsRow = SyncCacheRow & {
  cache_owner_id: string | null;
  manual_refresh_cooldown_minutes: number | null;
  lease_until: number | null;
  daily_day: string | null;
  history_event_count: number;
  history_version: number | null;
};

/** One statement keeps the cache, refresh marker and history version together. */
export async function loadPrivateProductsSnapshot<T>(db: D1Database, ownerId: string, cacheKey: string) {
  const row = await db.prepare(`SELECT s.owner_id AS cache_owner_id,
      s.payload, s.updated_at, s.last_attempt_at, s.last_manual_at, s.last_error,
      u.manual_refresh_cooldown_minutes, r.lease_until, r.daily_day,
      COALESCE(h.event_count, 0) AS history_event_count, m.version AS history_version
    FROM (SELECT ? AS owner_id) AS account
    LEFT JOIN sync_snapshots AS s ON s.owner_id = account.owner_id AND s.cache_key = ?
    LEFT JOIN user_settings AS u ON u.user_id = account.owner_id
    LEFT JOIN refresh_control AS r ON r.user_id = account.owner_id
    LEFT JOIN product_history_state AS h ON h.owner_id = account.owner_id
    LEFT JOIN product_history_meta AS m ON m.singleton = 1`)
    .bind(ownerId, cacheKey).first<PrivateProductsRow>();
  if (!row) throw new Error("private snapshot unavailable");
  if (row.history_version !== 1) throw new Error("product history summaries not initialized");
  return {
    record: row.cache_owner_id === null ? null : parseSyncCacheRow<T>(row),
    cooldownMs: manualRefreshCooldownMs(normalizeManualRefreshCooldown(row.manual_refresh_cooldown_minutes ?? undefined) ?? 30),
    leaseUntil: row.lease_until ?? 0,
    dailyDay: row.daily_day,
    historyEventCount: row.history_event_count,
  };
}
