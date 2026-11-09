import { NextResponse } from "next/server";
import { getUserIdentity } from "@/lib/db";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";


export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  // Compatibility for browser tabs loaded before the setting was removed.
  return NextResponse.json({ manualRefreshCooldownMinutes: 0 }, { headers: privateResponseHeaders });
}

export async function PUT(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });

  return NextResponse.json({ error: "手动刷新频率设置已移除，请重新加载页面。" }, { status: 410, headers: privateResponseHeaders });
}
