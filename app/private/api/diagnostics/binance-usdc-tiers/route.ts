import { NextResponse } from "next/server";
import { loadCredentials } from "@/lib/credentials";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { diagnoseBinanceFlexibleTiers } from "@/lib/integrations/binance";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const activeProbes = new Map<string, Promise<unknown>>();
const lastProbeAt = new Map<string, number>();
const cooldownMs = 30_000;

function cooldownResponse(remainingSeconds: number) {
  return NextResponse.json(
    { error: "刚完成一次 Binance 活期币种检查，请稍后再试。" },
    { status: 429, headers: { ...privateResponseHeaders, "Retry-After": String(remainingSeconds) } },
  );
}

/**
 * Narrow, read-only diagnosis for selected Binance flexible product APR metadata.
 * At most one public-product-list request is made for each configured Binance
 * account. It never requests holdings or writes product, cache, or history data.
 */
async function handleDiagnostic(request: Request, requireMutationOrigin: boolean) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (requireMutationOrigin && !isSameOriginMutation(request)) {
    return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });
  }
  if (!requireMutationOrigin && (request.headers.get("sec-fetch-site") === "cross-site"
    || (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin))) {
    return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });
  }
  const asset = new URL(request.url).searchParams.get("asset")?.toUpperCase() || "USDC";
  if (asset !== "USDC" && asset !== "USDT" && asset !== "BTC") {
    return NextResponse.json({ error: "本诊断仅支持 USDC、USDT 或 BTC。" }, { status: 400, headers: privateResponseHeaders });
  }

  try {
    const existing = activeProbes.get(identity.userId);
    if (existing) return NextResponse.json(await existing, { headers: privateResponseHeaders });

    const remainingMs = (lastProbeAt.get(identity.userId) ?? 0) + cooldownMs - Date.now();
    if (remainingMs > 0) return cooldownResponse(Math.ceil(remainingMs / 1000));

    const probe = (async () => {
      const db = await getDatabase();
      const credentials = await loadCredentials(db, identity.userId);
      const results = [];
      let requestsStarted = 0;

      for (const [accountId, region] of [["binance-global", "global"], ["binance-bahrain", "bahrain"]] as const) {
        const credential = credentials[accountId];
        if (!credential?.apiKey || !credential.apiSecret) {
          results.push({ account: accountId, status: "not_configured" as const, rows: [] });
          continue;
        }
        requestsStarted += 1;
        results.push(await diagnoseBinanceFlexibleTiers({
          apiKey: credential.apiKey,
          apiSecret: credential.apiSecret,
        }, region, asset));
      }

      return {
        generatedAt: new Date().toISOString(),
        scope: `Binance ${asset} 活期产品 APR`,
        dataChangesCommitted: false,
        includesHoldingAmounts: false,
        requestLimit: 2,
        requestsStarted,
        results,
      };
    })();
    activeProbes.set(identity.userId, probe);
    lastProbeAt.set(identity.userId, Date.now());
    void probe.finally(() => {
      if (activeProbes.get(identity.userId) === probe) activeProbes.delete(identity.userId);
    }).catch(() => undefined);

    return NextResponse.json(await probe, { headers: privateResponseHeaders });
  } catch {
    return NextResponse.json({ error: "Binance 活期币种脱敏诊断未能完成；请稍后重试。" }, { status: 502, headers: privateResponseHeaders });
  }
}

export async function POST(request: Request) {
  return handleDiagnostic(request, true);
}

/** Read-only browser entry point so the authenticated user can open the report directly. */
export async function GET(request: Request) {
  return handleDiagnostic(request, false);
}
