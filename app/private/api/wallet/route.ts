import { NextResponse } from "next/server";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";
import { releaseRefresh, supersedeRefreshForCredentialChange } from "@/lib/refresh-control";
import { deleteWalletConfig, loadWalletConfig, normalizeWalletAddress, saveWalletConfig } from "@/lib/wallet-config";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  const db = await getDatabase();
  const wallet = await loadWalletConfig(db, identity.userId);
  return NextResponse.json({ address: wallet?.address ?? null }, { headers: privateResponseHeaders });
}

export async function PUT(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "钱包配置格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  }
  const address = typeof body === "object" && body !== null && !Array.isArray(body)
    ? normalizeWalletAddress((body as { address?: unknown }).address) : null;
  if (!address) return NextResponse.json({ error: "请填写有效的 Morph 钱包公开地址（0x 开头、40 位十六进制字符）。" }, { status: 400, headers: privateResponseHeaders });

  const db = await getDatabase();
  const token = await supersedeRefreshForCredentialChange(db, identity.userId);
  if (!token) return NextResponse.json({ error: "钱包配置正在更新，请稍后重试。" }, { status: 409, headers: privateResponseHeaders });
  try {
    await saveWalletConfig(db, identity.userId, address, token);
  } finally {
    await releaseRefresh(db, identity.userId, token);
  }
  return NextResponse.json({ address }, { headers: privateResponseHeaders });
}

export async function DELETE(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });
  const db = await getDatabase();
  const token = await supersedeRefreshForCredentialChange(db, identity.userId);
  if (!token) return NextResponse.json({ error: "钱包配置正在更新，请稍后重试。" }, { status: 409, headers: privateResponseHeaders });
  try {
    await deleteWalletConfig(db, identity.userId, token);
  } finally {
    await releaseRefresh(db, identity.userId, token);
  }
  return NextResponse.json({ address: null }, { headers: privateResponseHeaders });
}
