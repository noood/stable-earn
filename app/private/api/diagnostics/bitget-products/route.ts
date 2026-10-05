import { NextResponse } from "next/server";
import { loadCredential } from "@/lib/credentials";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { probeBitgetProductEvidence } from "@/lib/integrations/bitget";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const activeProbes = new Map<string, Promise<unknown>>();
const lastProbeAt = new Map<string, number>();
const cooldownMs = 30_000;

function cooldownResponse(remainingSeconds: number) {
  return NextResponse.json(
    { error: "刚完成一次 Bitget 产品资料检查，请稍后再试。" },
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
      const credential = await loadCredential(await getDatabase(), identity.userId, "bitget-global");
      if (!credential?.apiKey || !credential.apiSecret || !credential.passphrase) {
        return { error: "尚未配置完整的 Bitget API 只读凭证。", status: 409 };
      }

      return probeBitgetProductEvidence({
        apiKey: credential.apiKey,
        apiSecret: credential.apiSecret,
        passphrase: credential.passphrase,
      });
    })();
    activeProbes.set(identity.userId, probe);
    lastProbeAt.set(identity.userId, Date.now());
    void probe.finally(() => {
      if (activeProbes.get(identity.userId) === probe) activeProbes.delete(identity.userId);
    }).catch(() => undefined);

    const result = await probe;
    if (result && typeof result === "object" && "error" in result && "status" in result) {
      const status = Number(result.status);
      return NextResponse.json({ error: result.error }, { status, headers: privateResponseHeaders });
    }
    return NextResponse.json(result, { headers: privateResponseHeaders });
  } catch {
    return NextResponse.json({ error: "Bitget 产品资料只读诊断未能完成；请稍后重试。" }, { status: 502, headers: privateResponseHeaders });
  }
}

export async function POST(request: Request) {
  return handleDiagnostic(request, true);
}

/** Signed-in, read-only browser entry point; no holdings API is called. */
export async function GET(request: Request) {
  return handleDiagnostic(request, false);
}
