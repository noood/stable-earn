import { NextResponse } from "next/server";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";
import { loadProductChangeEventPage, loadProductHistorySummaries, markProductChangeEventsRead } from "@/lib/product-change-events";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  const params = new URL(request.url).searchParams;
  const productId = params.get("productId")?.trim() ?? "";
  const cursor = params.get("cursor");
  if (!productId || productId.length > 300 || (cursor !== null && cursor.length > 2048)) {
    return NextResponse.json({ error: "变更记录请求格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  }
  try {
    const page = await loadProductChangeEventPage(await getDatabase(), identity.userId, productId, cursor);
    return NextResponse.json(page, { headers: privateResponseHeaders });
  } catch {
    return NextResponse.json({ error: "变更记录暂时无法读取。" }, { status: 400, headers: privateResponseHeaders });
  }
}

export async function POST(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "变更记录请求格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  }
  const candidate = typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as { productId?: unknown; eventIds?: unknown }
    : {};
  const { productId, eventIds } = candidate;
  if (typeof productId !== "string" || !productId.trim() || productId.length > 300
    || !Array.isArray(eventIds) || eventIds.length === 0 || eventIds.length > 50
    || eventIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 512)) {
    return NextResponse.json({ error: "变更记录请求格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  }
  const db = await getDatabase();
  const readAt = await markProductChangeEventsRead(db, identity.userId, productId.trim(), eventIds);
  const [historySummary] = await loadProductHistorySummaries(db, identity.userId, undefined, productId.trim());
  return NextResponse.json({ readAt, eventIds, historySummary }, { headers: privateResponseHeaders });
}
