import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

const DEFAULT_MANUAL_REFRESH_COOLDOWN_MS = 30 * 60 * 1000;

export type SyncCacheState = "fresh" | "updated" | "stale" | "cooldown" | "error";

type SyncCacheMetadata = {
  state: SyncCacheState;
  updatedAt: string | null;
  expiresAt: string | null;
  cooldownUntil: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
};

export type SyncCacheRecord<T> = {
  payload: T | null;
  updatedAt: string | null;
  lastAttemptAt: string | null;
  lastManualAt: string | null;
  lastError: string | null;
};

type SyncCacheRow = {
  payload: string | null;
  updated_at: string | null;
  last_attempt_at: string | null;
  last_manual_at: string | null;
  last_error: string | null;
};

export async function loadSyncCache<T>(db: D1Database, ownerId: string, cacheKey: string): Promise<SyncCacheRecord<T> | null> {
  const row = await db.prepare(`SELECT payload, updated_at, last_attempt_at, last_manual_at, last_error
      FROM sync_snapshots WHERE owner_id = ? AND cache_key = ?`)
    .bind(ownerId, cacheKey)
    .first<SyncCacheRow>();
  if (!row) return null;

  let payload: T | null = null;
  if (row.payload) {
    try { payload = JSON.parse(row.payload) as T; } catch { /* invalid cache is treated as empty */ }
  }
  return {
    payload,
    updatedAt: validDate(row.updated_at),
    lastAttemptAt: validDate(row.last_attempt_at),
    lastManualAt: validDate(row.last_manual_at),
    lastError: row.last_error,
  };
}

export function manualCooldownUntil(
  record: SyncCacheRecord<unknown> | null,
  now = Date.now(),
  durationMs = DEFAULT_MANUAL_REFRESH_COOLDOWN_MS,
) {
  return futureTime(record?.lastManualAt, durationMs, now);
}

export function syncCacheMetadata(
  record: SyncCacheRecord<unknown> | null,
  state: SyncCacheState,
  now = Date.now(),
  manualCooldownMs = DEFAULT_MANUAL_REFRESH_COOLDOWN_MS,
): SyncCacheMetadata {
  const updatedAt = record?.updatedAt ?? null;
  return {
    state,
    updatedAt,
    expiresAt: null,
    cooldownUntil: manualCooldownUntil(record, now, manualCooldownMs),
    lastAttemptAt: record?.lastAttemptAt ?? null,
    lastError: record?.lastError ?? null,
  };
}

export async function recordSyncAttempt(
  db: D1Database,
  ownerId: string,
  cacheKey: string,
  manual: boolean,
) {
  const attemptedAt = new Date().toISOString();
  await db.prepare(`INSERT INTO sync_snapshots
      (owner_id, cache_key, payload, updated_at, last_attempt_at, last_manual_at, last_error)
      VALUES (?, ?, NULL, NULL, ?, ?, NULL)
      ON CONFLICT(owner_id, cache_key) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        last_manual_at = CASE
          WHEN excluded.last_manual_at IS NOT NULL THEN excluded.last_manual_at
          ELSE sync_snapshots.last_manual_at
        END`)
    .bind(ownerId, cacheKey, attemptedAt, manual ? attemptedAt : null)
    .run();
  return attemptedAt;
}

export function prepareSyncCacheSave<T>(
  db: D1Database,
  ownerId: string,
  cacheKey: string,
  payload: T,
  updatedAt = new Date().toISOString(),
): D1PreparedStatement {
  return db.prepare(`INSERT INTO sync_snapshots
      (owner_id, cache_key, payload, updated_at, last_attempt_at, last_manual_at, last_error)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(owner_id, cache_key) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at,
        last_attempt_at = excluded.last_attempt_at,
        last_error = NULL`)
    .bind(ownerId, cacheKey, JSON.stringify(payload), updatedAt, updatedAt);
}

export async function recordSyncFailure(
  db: D1Database,
  ownerId: string,
  cacheKey: string,
  error: string,
) {
  await db.prepare("UPDATE sync_snapshots SET last_error = ? WHERE owner_id = ? AND cache_key = ?")
    .bind(error.slice(0, 240), ownerId, cacheKey)
    .run();
}

export async function deleteSyncCache(db: D1Database, ownerId: string, cacheKey: string) {
  await db.prepare("DELETE FROM sync_snapshots WHERE owner_id = ? AND cache_key = ?")
    .bind(ownerId, cacheKey)
    .run();
}

export function formatCacheTime(value: string | null) {
  if (!value) return "尚无成功数据";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function futureTime(value: string | null | undefined, durationMs: number, now: number) {
  const base = timestamp(value);
  if (base === null || base + durationMs <= now) return null;
  return new Date(base + durationMs).toISOString();
}

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validDate(value: string | null) {
  return timestamp(value) === null ? null : value;
}
