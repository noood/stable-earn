import { NextResponse } from "next/server";
import { loadCredentials } from "@/lib/credentials";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { probePlatformCapabilities } from "@/lib/platform-capability-probe";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/** User-triggered, read-only check of already-known exchange API scopes. */
export async function POST(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });

  try {
    const credentials = await loadCredentials(await getDatabase(), identity.userId);
    const report = await probePlatformCapabilities(credentials);
    return NextResponse.json(report, { headers: privateResponseHeaders });
  } catch {
    return NextResponse.json({ error: "平台 API 检查未能完成；请稍后重试。" }, { status: 502, headers: privateResponseHeaders });
  }
}
