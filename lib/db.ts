import { env } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { schemaStatements } from "@/db/schema";

type RuntimeEnv = Cloudflare.Env & {
  DB?: D1Database;
  POLICY_AUD?: string;
  TEAM_DOMAIN?: string;
};

type UserIdentity = { userId: string; email: string };

let initialized = false;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksIssuer: string | null = null;

export async function getDatabase() {
  const db = (env as RuntimeEnv).DB;
  if (!db) throw new Error("D1 binding DB is not configured");

  if (!initialized) {
    await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
    initialized = true;
  }

  return db;
}

export async function getUserId(request: Request) {
  return (await getUserIdentity(request))?.userId ?? null;
}

export async function getUserIdentity(request: Request): Promise<UserIdentity | null> {
  if (process.env.NODE_ENV === "development") {
    return { userId: "local-owner", email: "local@stable-earn.test" };
  }

  const accessJwt = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (!accessJwt) return null;

  const runtime = env as RuntimeEnv;
  const issuer = normalizeIssuer(runtime.TEAM_DOMAIN);
  const audience = runtime.POLICY_AUD?.trim();
  if (!issuer || !audience) return null;

  try {
    const { payload } = await jwtVerify(accessJwt, accessSigningKeys(issuer), {
      algorithms: ["RS256"],
      issuer,
      audience,
    });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    return email ? { userId: `cloudflare:${email}`, email } : null;
  } catch {
    return null;
  }
}

function accessSigningKeys(issuer: string) {
  if (!jwks || jwksIssuer !== issuer) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksIssuer = issuer;
  }
  return jwks;
}

function normalizeIssuer(value: string | undefined) {
  const candidate = value?.trim().replace(/\/+$/, "");
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}
