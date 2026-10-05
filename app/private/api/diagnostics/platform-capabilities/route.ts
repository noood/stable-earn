import type { D1Database } from "@cloudflare/workers-types";
import { NextResponse } from "next/server";
import { loadCredentials } from "@/lib/credentials";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { probePlatformCapabilities } from "@/lib/platform-capability-probe";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const activeCapabilityProbes = new Map<string, Promise<unknown>>();
const fallbackCooldownSeconds = 60;

function getOrStartCapabilityProbe(userId: string, db: D1Database) {
  const active = activeCapabilityProbes.get(userId);
  if (active) return active;

  const probe = (async () => {
    const credentials = await loadCredentials(db, userId);
    return probePlatformCapabilities(credentials);
  })();
  activeCapabilityProbes.set(userId, probe);
  void probe.finally(() => {
    if (activeCapabilityProbes.get(userId) === probe) activeCapabilityProbes.delete(userId);
  }).catch(() => undefined);
  return probe;
}

function cooldownResponse(remainingSeconds: number) {
  return NextResponse.json(
    { error: "上次检查触发了平台限流，请稍后再试。" },
    { status: 429, headers: { ...privateResponseHeaders, "Retry-After": String(remainingSeconds) } },
  );
}

/** User-triggered, read-only check of already-known exchange API scopes. */
export async function POST(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });

  try {
    const db = await getDatabase();
    const cooldown = await db.prepare(`SELECT cooldown_until FROM capability_probe_cooldowns WHERE user_id = ?`)
      .bind(identity.userId).first<{ cooldown_until: number }>();
    if (cooldown && cooldown.cooldown_until > Date.now()) {
      return cooldownResponse(Math.ceil((cooldown.cooldown_until - Date.now()) / 1000));
    }

    const report = await getOrStartCapabilityProbe(identity.userId, db) as {
      requestSafety?: { stopReason?: string | null; retryAfterSeconds?: number };
      [key: string]: unknown;
    };
    const stopReason = report.requestSafety?.stopReason;
    if (stopReason === "rate_limited") {
      const retryAfter = report.requestSafety?.retryAfterSeconds;
      const cooldownSeconds = Math.max(fallbackCooldownSeconds,
        typeof retryAfter === "number" && Number.isFinite(retryAfter) ? Math.max(0, Math.ceil(retryAfter)) : 0);
      const cooldownUntil = Date.now() + cooldownSeconds * 1000;
      const persisted = await db.prepare(`INSERT INTO capability_probe_cooldowns (user_id, cooldown_until)
          VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET cooldown_until = MAX(capability_probe_cooldowns.cooldown_until, excluded.cooldown_until)
          RETURNING cooldown_until`)
        .bind(identity.userId, cooldownUntil)
        .first<{ cooldown_until: number }>();
      const effectiveCooldownSeconds = Math.max(fallbackCooldownSeconds,
        Math.ceil(((persisted?.cooldown_until ?? cooldownUntil) - Date.now()) / 1000));
      return NextResponse.json({
        ...report,
        requestSafety: { ...report.requestSafety, retryAfterSeconds: effectiveCooldownSeconds },
      }, { headers: privateResponseHeaders });
    }
    return NextResponse.json(report, { headers: privateResponseHeaders });
  } catch {
    return NextResponse.json({ error: "平台 API 检查未能完成；请稍后重试。" }, { status: 502, headers: privateResponseHeaders });
  }
}
