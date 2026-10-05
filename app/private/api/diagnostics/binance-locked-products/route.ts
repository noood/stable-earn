import { NextResponse } from "next/server";
import { loadCredentials } from "@/lib/credentials";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { diagnoseBinanceLockedProducts, type BinanceLockedProductDiagnostic } from "@/lib/integrations/binance";
import { withCapabilityProbeRequestGuard } from "@/lib/exchange-fetch";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const activeProbes = new Map<string, Promise<unknown>>();
const lastProbeAt = new Map<string, number>();
const cooldownMs = 30_000;
type AccountResult = BinanceLockedProductDiagnostic | {
  account: "binance-global" | "binance-bahrain";
  status: "not_configured";
  rows: [];
};

function cooldownResponse(remainingSeconds: number) {
  return NextResponse.json(
    { error: "刚完成一次 Binance 定期产品检查，请稍后再试。" },
    { status: 429, headers: { ...privateResponseHeaders, "Retry-After": String(remainingSeconds) } },
  );
}

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

  try {
    const existing = activeProbes.get(identity.userId);
    if (existing) return NextResponse.json(await existing, { headers: privateResponseHeaders });

    const remainingMs = (lastProbeAt.get(identity.userId) ?? 0) + cooldownMs - Date.now();
    if (remainingMs > 0) return cooldownResponse(Math.ceil(remainingMs / 1000));

    const probe = (async () => {
      const db = await getDatabase();
      const credentials = await loadCredentials(db, identity.userId);
      const results: AccountResult[] = [];
      let requestsStarted = 0;

      const guarded = await withCapabilityProbeRequestGuard(async () => {
        for (const [accountId, region] of [["binance-global", "global"], ["binance-bahrain", "bahrain"]] as const) {
          const credential = credentials[accountId];
          if (!credential?.apiKey || !credential.apiSecret) {
            results.push({ account: accountId, status: "not_configured" as const, rows: [] });
            continue;
          }
          results.push(await diagnoseBinanceLockedProducts({
            apiKey: credential.apiKey,
            apiSecret: credential.apiSecret,
          }, region));
        }
      });
      requestsStarted = guarded.requestsStarted;

      return {
        generatedAt: new Date().toISOString(),
        scope: "Binance 定期产品 APR、额度和申购状态",
        endpoint: "/sapi/v1/simple-earn/locked/list",
        dataChangesCommitted: false,
        includesHoldingAmounts: false,
        productAssetsIncluded: ["USDT", "USDC", "USDGO", "BTC"],
        requestLimit: guarded.requestLimit,
        requestsStarted,
        requestSafety: {
          concurrencyLimit: guarded.concurrencyLimit,
          stopReason: guarded.stopReason,
          ...(guarded.retryAfterSeconds !== undefined ? { retryAfterSeconds: guarded.retryAfterSeconds } : {}),
        },
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
    return NextResponse.json({ error: "Binance 定期产品只读检查未能完成；请稍后重试。" }, { status: 502, headers: privateResponseHeaders });
  }
}

export async function POST(request: Request) {
  return handleDiagnostic(request, true);
}

/** Signed-in, same-site read-only report; this route never requests positions. */
export async function GET(request: Request) {
  return handleDiagnostic(request, false);
}
