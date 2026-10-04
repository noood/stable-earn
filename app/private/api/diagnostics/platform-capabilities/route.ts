import { NextResponse } from "next/server";
import { loadCredentials } from "@/lib/credentials";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { probePlatformCapabilities } from "@/lib/platform-capability-probe";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const activeCapabilityProbes = new Map<string, Promise<unknown>>();
const capabilityProbeCooldownUntil = new Map<string, number>();
const rateLimitCooldownMs = 60_000;

function getOrStartCapabilityProbe(userId: string) {
  const active = activeCapabilityProbes.get(userId);
  if (active) return active;

  const probe = (async () => {
    const credentials = await loadCredentials(await getDatabase(), userId);
    return probePlatformCapabilities(credentials);
  })();
  activeCapabilityProbes.set(userId, probe);
  void probe.finally(() => {
    if (activeCapabilityProbes.get(userId) === probe) activeCapabilityProbes.delete(userId);
  }).catch(() => undefined);
  return probe;
}

function clearExpiredCapabilityCooldowns(now: number) {
  for (const [userId, until] of capabilityProbeCooldownUntil) {
    if (until <= now) capabilityProbeCooldownUntil.delete(userId);
  }
}

/** User-triggered, read-only check of already-known exchange API scopes. */
export async function POST(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });

  const now = Date.now();
  clearExpiredCapabilityCooldowns(now);
  const cooldownUntil = capabilityProbeCooldownUntil.get(identity.userId);
  if (cooldownUntil && cooldownUntil > now) {
    return NextResponse.json(
      { error: "上次检查触发了平台限流，请稍后再试。" },
      { status: 429, headers: { ...privateResponseHeaders, "Retry-After": String(Math.ceil((cooldownUntil - now) / 1000)) } },
    );
  }

  try {
    const report = await getOrStartCapabilityProbe(identity.userId);
    const stopReason = (report as { requestSafety?: { stopReason?: string | null } }).requestSafety?.stopReason;
    if (stopReason === "rate_limited") capabilityProbeCooldownUntil.set(identity.userId, Date.now() + rateLimitCooldownMs);
    return NextResponse.json(report, { headers: privateResponseHeaders });
  } catch {
    return NextResponse.json({ error: "平台 API 检查未能完成；请稍后重试。" }, { status: 502, headers: privateResponseHeaders });
  }
}
