import { NextResponse } from "next/server";
import { credentialAccount, credentialAccounts, deleteCredential, listConfiguredCredentialIds, nonCredentialApiSources, saveCredential, type CredentialAccountId } from "@/lib/credentials";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";
import { deleteSyncCache } from "@/lib/sync-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  const db = await getDatabase();
  const configuredIds = new Set(await listConfiguredCredentialIds(db, identity.userId));
  return NextResponse.json({
    sources: [
      ...credentialAccounts.slice(0, 3),
      ...nonCredentialApiSources,
      ...credentialAccounts.slice(3),
    ].map((account) => ({
      ...account,
      configured: configuredIds.has(account.id),
    })),
  }, { headers: privateResponseHeaders });
}

export async function PUT(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "配置格式不正确。" }, { status: 400, headers: privateResponseHeaders }); }
  const candidate = body as Partial<{ accountId: string; apiKey: string; apiSecret: string; passphrase: string }>;
  const account = credentialAccount(candidate.accountId ?? "");
  if (!account) return NextResponse.json({ error: "不支持该账户。" }, { status: 400, headers: privateResponseHeaders });

  const apiKey = cleanSecret(candidate.apiKey);
  const apiSecret = cleanSecret(candidate.apiSecret);
  const passphrase = cleanSecret(candidate.passphrase);
  if (!apiKey || !apiSecret || apiKey.length > 512 || apiSecret.length > 1024) {
    return NextResponse.json({ error: "请填写有效的 API Key 和 Secret。" }, { status: 400, headers: privateResponseHeaders });
  }
  if (account.requiresPassphrase && (!passphrase || passphrase.length > 512)) {
    return NextResponse.json({ error: "该平台还需要 Passphrase。" }, { status: 400, headers: privateResponseHeaders });
  }

  const db = await getDatabase();
  await saveCredential(db, identity.userId, account.id, {
    apiKey,
    apiSecret,
    passphrase: account.requiresPassphrase ? passphrase : undefined,
  });
  await deleteSyncCache(db, identity.userId, "private-products");
  return NextResponse.json({ saved: true, accountId: account.id }, { headers: privateResponseHeaders });
}

export async function DELETE(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });
  const account = credentialAccount(new URL(request.url).searchParams.get("accountId") ?? "");
  if (!account) return NextResponse.json({ error: "不支持该账户。" }, { status: 400, headers: privateResponseHeaders });
  const db = await getDatabase();
  await deleteCredential(db, identity.userId, account.id as CredentialAccountId);
  await deleteSyncCache(db, identity.userId, "private-products");
  return NextResponse.json({ deleted: true, accountId: account.id }, { headers: privateResponseHeaders });
}

function cleanSecret(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
