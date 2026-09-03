import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Asset, Product } from "./domain";
import { accounts } from "./seed-data";

export type UserProductInput = {
  id: string;
  accountId: string;
  asset: Asset;
  manualKind: "flexible" | "fixed" | "limited";
  termDays: number | null;
};

type UserProductRow = {
  product_id: string;
  account_id: string;
  asset: Asset;
  product_kind: UserProductInput["manualKind"];
  term_days: number | null;
};

const validAccountIds = new Set(accounts.map((account) => account.id));
const validAssets = new Set<Asset>(["USDT", "USDC", "USDGO", "BTC"]);
const validKinds = new Set<UserProductInput["manualKind"]>(["flexible", "fixed", "limited"]);

export async function loadUserProducts(db: D1Database, userId: string) {
  const result = await db.prepare(`SELECT product_id, account_id, asset, product_kind, term_days
      FROM user_products WHERE user_id = ? ORDER BY created_at, product_id`)
    .bind(userId)
    .all<UserProductRow>();
  return result.results.map((row) => userProductInputToProduct({
    id: row.product_id,
    accountId: row.account_id,
    asset: row.asset,
    manualKind: row.product_kind,
    termDays: row.term_days,
  }));
}

export function sanitizeUserProducts(value: unknown): UserProductInput[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const seen = new Set<string>();
  const products: UserProductInput[] = [];
  for (const rawValue of value) {
    if (typeof rawValue !== "object" || rawValue === null) return null;
    const raw = rawValue as Partial<UserProductInput>;
    const termDays = raw.termDays === null || raw.termDays === undefined ? null : Number(raw.termDays);
    if (typeof raw.id !== "string" || !/^manual-[a-z0-9-]{8,80}$/i.test(raw.id) || seen.has(raw.id)) return null;
    if (typeof raw.accountId !== "string" || !validAccountIds.has(raw.accountId)) return null;
    if (typeof raw.asset !== "string" || !validAssets.has(raw.asset as Asset)) return null;
    if (typeof raw.manualKind !== "string" || !validKinds.has(raw.manualKind as UserProductInput["manualKind"])) return null;
    if ((raw.manualKind === "fixed" || raw.manualKind === "limited") && (!Number.isFinite(termDays) || termDays! <= 0 || termDays! > 3650)) return null;
    seen.add(raw.id);
    products.push({
      id: raw.id,
      accountId: raw.accountId,
      asset: raw.asset as Asset,
      manualKind: raw.manualKind as UserProductInput["manualKind"],
      termDays: raw.manualKind === "flexible" ? null : termDays,
    });
  }
  return products;
}

export function prepareUserProductStatements(
  db: D1Database,
  userId: string,
  products: UserProductInput[],
  deletedIds: string[],
  updatedAt = new Date().toISOString(),
): D1PreparedStatement[] {
  return [
    ...products.map((product) => db.prepare(`INSERT INTO user_products
        (user_id, product_id, account_id, asset, product_kind, term_days, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, product_id) DO UPDATE SET
          account_id = excluded.account_id,
          asset = excluded.asset,
          product_kind = excluded.product_kind,
          term_days = excluded.term_days,
          updated_at = excluded.updated_at`)
      .bind(userId, product.id, product.accountId, product.asset, product.manualKind, product.termDays, updatedAt, updatedAt)),
    ...deletedIds.flatMap((productId) => [
      db.prepare("DELETE FROM user_products WHERE user_id = ? AND product_id = ?").bind(userId, productId),
      db.prepare("DELETE FROM holdings WHERE user_id = ? AND product_id = ?").bind(userId, productId),
      db.prepare("DELETE FROM product_overrides WHERE user_id = ? AND product_id = ?").bind(userId, productId),
      db.prepare("DELETE FROM product_override_limits WHERE user_id = ? AND product_id = ?").bind(userId, productId),
      db.prepare("DELETE FROM product_override_terms WHERE user_id = ? AND product_id = ?").bind(userId, productId),
    ]),
  ];
}

export function productToUserProduct(product: Product): UserProductInput {
  return {
    id: product.id,
    accountId: product.accountId,
    asset: product.asset,
    manualKind: product.manualKind ?? (product.productType === "fixed" ? "fixed" : "flexible"),
    termDays: product.termDays ?? null,
  };
}

export function userProductInputToProduct(input: UserProductInput): Product {
  const account = accounts.find((candidate) => candidate.id === input.accountId)!;
  return {
    id: input.id,
    accountId: input.accountId,
    exchange: account.exchange,
    region: account.region,
    asset: input.asset,
    name: input.manualKind === "fixed" ? "手动定期理财" : input.manualKind === "limited" ? "手动限时活期" : "手动活期理财",
    productDataMode: "manual",
    holdingDataMode: "manual",
    productType: input.manualKind === "fixed" ? "fixed" : "flexible",
    manualKind: input.manualKind,
    termDays: input.termDays ?? undefined,
    tiers: [{ id: `${input.id}-tier-0`, min: 0, max: null, apr: 0 }],
    source: { kind: "manual", label: "手动添加" },
    rateCoverage: "unavailable",
    identityKey: input.id,
  };
}
