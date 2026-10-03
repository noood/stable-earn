import { NextResponse } from "next/server";
import { loadCredential } from "@/lib/credentials";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { probeBitgetAsset } from "@/lib/integrations/bitget";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";
import { syncDiagnostic, withSyncDiagnostics, withSyncPlatform } from "@/lib/sync-diagnostics";

export const dynamic = "force-dynamic";

/**
 * Authenticated, same-origin, one-off Bitget USDGO probe. The probe reads the
 * user's existing credential and exchange endpoints but does not write D1.
 */
export async function POST(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });

  try {
    const credential = await loadCredential(await getDatabase(), identity.userId, "bitget-global");
    if (!credential?.apiKey || !credential.apiSecret || !credential.passphrase) {
      return NextResponse.json({ error: "尚未配置完整的 Bitget API 只读凭证。" }, { status: 409, headers: privateResponseHeaders });
    }

    const probe = await withSyncDiagnostics(identity.userId, { trigger: "manual", attempt: 1 }, () => (
      withSyncPlatform("bitget-global", async () => {
        const result = await probeBitgetAsset({
          apiKey: credential.apiKey,
          apiSecret: credential.apiSecret,
          passphrase: credential.passphrase!,
        }, "USDGO");
        syncDiagnostic("bitget_capability_probe", {
          asset: result.asset,
          productApiStatus: result.productApi.status,
          productApiRowCount: result.productApi.rowCount,
          eligibleFlexibleCount: result.productApi.eligibleFlexibleCount,
          holdingsApiStatus: result.holdingsApi.status,
          holdingsApiRowCount: result.holdingsApi.rowCount,
          holdingsApiPages: result.holdingsApi.pageCount,
        });
        return result;
      })
    ));

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      persisted: false,
      probe,
    }, { headers: privateResponseHeaders });
  } catch {
    return NextResponse.json({ error: "Bitget USDGO 探针失败；请查看脱敏运行日志。" }, { status: 502, headers: privateResponseHeaders });
  }
}
