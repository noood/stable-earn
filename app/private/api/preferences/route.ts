import { NextResponse } from "next/server";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";
import {
  loadManualRefreshCooldown,
  normalizeManualRefreshCooldown,
  saveManualRefreshCooldown,
} from "@/lib/user-settings";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  const db = await getDatabase();
  const manualRefreshCooldownMinutes = await loadManualRefreshCooldown(db, identity.userId);
  return NextResponse.json({ manualRefreshCooldownMinutes }, { headers: privateResponseHeaders });
}

export async function PUT(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "设置格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  }
  const candidate = typeof body === "object" && body !== null
    ? normalizeManualRefreshCooldown((body as { manualRefreshCooldownMinutes?: unknown }).manualRefreshCooldownMinutes)
    : null;
  if (candidate === null) {
    return NextResponse.json({ error: "冷却时间仅支持无或 30 分钟。" }, { status: 400, headers: privateResponseHeaders });
  }

  const db = await getDatabase();
  const updatedAt = await saveManualRefreshCooldown(db, identity.userId, candidate);
  return NextResponse.json({ manualRefreshCooldownMinutes: candidate, updatedAt }, { headers: privateResponseHeaders });
}
