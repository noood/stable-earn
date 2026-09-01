import type { D1Database } from "@cloudflare/workers-types";

export const manualRefreshCooldownOptions = [0, 30] as const;
export type ManualRefreshCooldownMinutes = typeof manualRefreshCooldownOptions[number];

const defaultManualRefreshCooldownMinutes: ManualRefreshCooldownMinutes = 30;

type UserSettingsRow = { manual_refresh_cooldown_minutes: number };

export async function loadManualRefreshCooldown(db: D1Database, userId: string) {
  const row = await db.prepare(`SELECT manual_refresh_cooldown_minutes
      FROM user_settings WHERE user_id = ?`)
    .bind(userId)
    .first<UserSettingsRow>();
  return normalizeManualRefreshCooldown(row?.manual_refresh_cooldown_minutes)
    ?? defaultManualRefreshCooldownMinutes;
}

export async function saveManualRefreshCooldown(
  db: D1Database,
  userId: string,
  minutes: ManualRefreshCooldownMinutes,
) {
  const updatedAt = new Date().toISOString();
  await db.prepare(`INSERT INTO user_settings
      (user_id, manual_refresh_cooldown_minutes, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        manual_refresh_cooldown_minutes = excluded.manual_refresh_cooldown_minutes,
        updated_at = excluded.updated_at`)
    .bind(userId, minutes, updatedAt)
    .run();
  return updatedAt;
}

export function normalizeManualRefreshCooldown(value: unknown): ManualRefreshCooldownMinutes | null {
  const minutes = typeof value === "number" ? value : Number(value);
  return manualRefreshCooldownOptions.includes(minutes as ManualRefreshCooldownMinutes)
    ? minutes as ManualRefreshCooldownMinutes
    : null;
}

export function manualRefreshCooldownMs(minutes: ManualRefreshCooldownMinutes) {
  return minutes * 60 * 1000;
}
