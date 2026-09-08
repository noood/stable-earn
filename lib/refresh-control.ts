import type { D1Database } from "@cloudflare/workers-types";
import { SYNC_ATTEMPT_WINDOW_MS } from "./sync-cache";

export function refreshDay(now = Date.now()) {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

// An atomic, account-scoped lease serializes browser and queue requests.
// The expiry recovers from terminated Workers; release only affects its owner.
export async function acquireRefresh(db: D1Database, userId: string) {
  const token = crypto.randomUUID();
  const now = Date.now();
  const row = await db.prepare(`INSERT INTO refresh_control (user_id, lease_token, lease_until)
    VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      lease_token = excluded.lease_token, lease_until = excluded.lease_until
    WHERE refresh_control.lease_until <= ?
    RETURNING lease_token`).bind(userId, token, now + SYNC_ATTEMPT_WINDOW_MS, now)
    .first<{ lease_token: string }>();
  return row ? token : null;
}

export async function releaseRefresh(db: D1Database, userId: string, token: string) {
  await db.prepare("UPDATE refresh_control SET lease_until = 0 WHERE user_id = ? AND lease_token = ?")
    .bind(userId, token).run();
}

export async function renewRefresh(db: D1Database, userId: string, token: string) {
  const now = Date.now();
  return Boolean(await db.prepare(`UPDATE refresh_control SET lease_until = ?
    WHERE user_id = ? AND lease_token = ? AND lease_until > ? RETURNING lease_token`)
    .bind(now + SYNC_ATTEMPT_WINDOW_MS, userId, token, now).first());
}

export async function refreshIsLocked(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT lease_until FROM refresh_control WHERE user_id = ?")
    .bind(userId).first<{ lease_until: number }>();
  return Boolean(row && row.lease_until > Date.now());
}

// Mark before the exchange request: failures also consume this day's opening.
// Caller holds the lease. This is separate from the manual-button cooldown.
export async function claimDailyRefresh(db: D1Database, userId: string, token: string) {
  const day = refreshDay();
  return Boolean(await db.prepare(`UPDATE refresh_control SET daily_day = ?
    WHERE user_id = ? AND lease_token = ? AND (daily_day IS NULL OR daily_day <> ?)
    RETURNING daily_day`).bind(day, userId, token, day).first());
}

export async function scheduledRefreshDone(db: D1Database, userId: string, slot: number) {
  const row = await db.prepare("SELECT scheduled_done_at FROM refresh_control WHERE user_id = ?")
    .bind(userId).first<{ scheduled_done_at: number | null }>();
  return row?.scheduled_done_at != null && row.scheduled_done_at >= slot;
}

export async function finishScheduledRefresh(db: D1Database, userId: string, token: string, slot: number) {
  await db.prepare("UPDATE refresh_control SET scheduled_done_at = ? WHERE user_id = ? AND lease_token = ?")
    .bind(slot, userId, token).run();
}
