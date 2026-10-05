import { NextResponse } from "next/server";
import { auditCatalogIdentities } from "@/lib/catalog-identity-audit";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { privateResponseHeaders } from "@/lib/request-security";

/**
 * Authenticated, read-only catalog audit. This intentionally returns identity
 * metadata and references only; it never returns product payloads or writes D1.
 */
export async function GET(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) {
    return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  }

  const report = await auditCatalogIdentities(await getDatabase(), identity.userId);
  const summarizeRow = (row: typeof report.rows[number]) => {
    const payload = parsePayload(row.payload);
    return {
      ownerId: row.owner_id,
      productId: row.product_id,
      // Kept as a read-only compatibility label for older audit consumers.
      // The persisted source of truth is now identityKey.
      canonicalProductId: row.identity_key,
      identityKey: row.identity_key,
      status: row.status,
      accountId: payload?.accountId ?? null,
      exchange: payload?.exchange ?? null,
      region: payload?.region ?? null,
      asset: payload?.asset ?? null,
      externalProductId: payload?.externalProductId ?? null,
    };
  };

  return NextResponse.json({
    summary: report.summary,
    duplicateIdentityGroups: report.duplicateIdentityGroups.map((group) => group.map(summarizeRow)),
    activeCanonicalGroups: report.activeCanonicalGroups.map((group) => group.map(summarizeRow)),
    generatedProductIds: report.generatedProductIds.map(summarizeRow),
    orphanReferences: report.orphanReferences,
  }, { headers: privateResponseHeaders });
}

function parsePayload(payload: string) {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
