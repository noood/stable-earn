import { NextResponse } from "next/server";
import { getUserIdentity } from "@/lib/db";
import { privateResponseHeaders } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  return NextResponse.json({ authenticated: true, email: identity.email }, { headers: privateResponseHeaders });
}
