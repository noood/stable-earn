import { NextResponse } from "next/server";
import { getDatabase, getUserId } from "@/lib/db";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";
import type { HoldingMap } from "@/lib/domain";
import { productNeedsManualApr, productNeedsManualLimit, productNeedsManualTerm, productNeedsPurchaseDate, type ProductOverrideMap } from "@/lib/product-overrides";
import { loadUserProducts, prepareUserProductStatements, productToUserProduct, sanitizeUserProducts, userProductInputToProduct } from "@/lib/user-products";
import { isLocalPreviewRequest, localPrivateHoldingsPreview } from "@/lib/local-preview";
import { loadCatalogProducts } from "@/lib/product-catalog";

export const dynamic = "force-dynamic";

type HoldingRow = { product_id: string; amount: number };
type OverrideRow = { product_id: string; confirmed_apr: number | null; purchase_date: string | null; updated_at: string };
type LimitRow = { product_id: string; first_tier_limit: number | null };
type TermRow = { product_id: string; term_days: number | null };
type HiddenProductRow = { product_id: string };

export async function GET(request: Request) {
  const userId = await getUserId(request);
  if (!userId) return NextResponse.json({ error: "请先登录后再读取持仓。" }, { status: 401, headers: privateResponseHeaders });
  if (isLocalPreviewRequest(request)) {
    return NextResponse.json(localPrivateHoldingsPreview(), { headers: privateResponseHeaders });
  }

  const db = await getDatabase();
  const [catalogProducts, manualProducts, holdingResult, overrideResult, limitResult, termResult, hiddenResult, hiddenCatalogResult] = await Promise.all([
    loadCatalogProducts(db, userId),
    loadUserProducts(db, userId),
    db.prepare("SELECT product_id, amount FROM holdings WHERE user_id = ? ORDER BY product_id").bind(userId).all<HoldingRow>(),
    db.prepare(`SELECT product_id, confirmed_apr, purchase_date, updated_at
      FROM product_overrides WHERE user_id = ? ORDER BY product_id`).bind(userId).all<OverrideRow>(),
    db.prepare(`SELECT product_id, first_tier_limit
      FROM product_override_limits WHERE user_id = ? ORDER BY product_id`).bind(userId).all<LimitRow>(),
    db.prepare(`SELECT product_id, term_days
      FROM product_override_terms WHERE user_id = ? ORDER BY product_id`).bind(userId).all<TermRow>(),
    db.prepare("SELECT product_id FROM hidden_seed_products WHERE user_id = ? ORDER BY product_id").bind(userId).all<HiddenProductRow>(),
    db.prepare("SELECT product_id FROM hidden_products WHERE user_id = ? ORDER BY product_id").bind(userId).all<HiddenProductRow>(),
  ]);
  const removableProducts = new Set([...catalogProducts, ...manualProducts].map((product) => product.id));
  const hiddenProductIds = [...new Set([
    ...hiddenResult.results.map((row) => row.product_id),
    ...hiddenCatalogResult.results.map((row) => row.product_id),
  ])].filter((productId) => removableProducts.has(productId));
  const hiddenProductIdSet = new Set(hiddenProductIds);
  const productIds = new Set([...catalogProducts.filter((product) => !hiddenProductIdSet.has(product.id)), ...manualProducts].map((product) => product.id));
  const limits = new Map(limitResult.results.map((row) => [row.product_id, row.first_tier_limit]));
  const terms = new Map(termResult.results.map((row) => [row.product_id, row.term_days]));
  const holdings = Object.fromEntries(holdingResult.results
    .filter((row) => productIds.has(row.product_id))
    .map((row) => [row.product_id, Number(row.amount)])) as HoldingMap;
  const overrides = Object.fromEntries(overrideResult.results
    .filter((row) => productIds.has(row.product_id))
    .map((row) => [row.product_id, {
      apr: row.confirmed_apr === null ? null : Number(row.confirmed_apr),
      firstTierLimit: limits.get(row.product_id) === null || limits.get(row.product_id) === undefined ? null : Number(limits.get(row.product_id)),
      termDays: terms.get(row.product_id) === null || terms.get(row.product_id) === undefined ? null : Number(terms.get(row.product_id)),
      purchaseDate: row.purchase_date,
      updatedAt: row.updated_at,
    }])) as ProductOverrideMap;
  return NextResponse.json({ products: catalogProducts, holdings, overrides, manualProducts, hiddenProductIds, found: holdingResult.results.length > 0 || overrideResult.results.length > 0 || manualProducts.length > 0 || hiddenProductIds.length > 0 }, { headers: privateResponseHeaders });
}

export async function PUT(request: Request) {
  const userId = await getUserId(request);
  if (!userId) return NextResponse.json({ error: "请先登录后再保存持仓。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });
  if (isLocalPreviewRequest(request)) {
    return NextResponse.json({ saved: 0, manualUpdated: 0, productUpdated: 0, productDeleted: 0, updatedAt: new Date().toISOString(), preview: true }, { headers: privateResponseHeaders });
  }

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "持仓数据格式不正确。" }, { status: 400, headers: privateResponseHeaders }); }
  const payload = typeof body === "object" && body !== null ? body as { holdings?: unknown; overrides?: unknown; changedHoldingProductIds?: unknown; changedOverrideProductIds?: unknown; manualProducts?: unknown; deletedManualProductIds?: unknown; hiddenProductIds?: unknown } : null;
  const candidate = payload?.holdings ?? null;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return NextResponse.json({ error: "缺少持仓数据。" }, { status: 400, headers: privateResponseHeaders });
  }

  const db = await getDatabase();
  const [existingManualProducts, catalogProducts, hiddenCatalogResult, legacyHiddenResult] = await Promise.all([
    loadUserProducts(db, userId),
    loadCatalogProducts(db, userId),
    db.prepare("SELECT product_id FROM hidden_products WHERE user_id = ? ORDER BY product_id").bind(userId).all<HiddenProductRow>(),
    db.prepare("SELECT product_id FROM hidden_seed_products WHERE user_id = ? ORDER BY product_id").bind(userId).all<HiddenProductRow>(),
  ]);
  const manualProductUpdates = payload?.manualProducts === undefined ? [] : sanitizeUserProducts(payload.manualProducts);
  if (!manualProductUpdates) return NextResponse.json({ error: "手动产品格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  const deletedManualProductIds = Array.isArray(payload?.deletedManualProductIds)
    ? [...new Set(payload.deletedManualProductIds.filter((value): value is string => typeof value === "string" && /^manual-[a-z0-9-]{8,80}$/i.test(value)))]
    : [];
  const allCatalogProducts = [...catalogProducts, ...existingManualProducts];
  const removableProductIds = new Set(allCatalogProducts.map((product) => product.id));
  const hiddenProductsProvided = payload?.hiddenProductIds !== undefined;
  const hiddenProductIds = hiddenProductsProvided
    ? sanitizeHiddenProductIds(payload.hiddenProductIds, removableProductIds)
    : [...new Set([...hiddenCatalogResult.results, ...legacyHiddenResult.results].map((row) => row.product_id))].filter((productId) => removableProductIds.has(productId));
  if (!hiddenProductIds) return NextResponse.json({ error: "隐藏的产品格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  const hiddenProductIdSet = new Set(hiddenProductIds);
  const deletedManualProductIdSet = new Set(deletedManualProductIds);
  const manualProductUpdateIds = new Set(manualProductUpdates.map((product) => product.id));
  const manualProductInputs = [
    ...existingManualProducts
      .filter((product) => !deletedManualProductIdSet.has(product.id) && !manualProductUpdateIds.has(product.id))
      .map(productToUserProduct),
    ...manualProductUpdates,
  ];
  const manualProducts = manualProductInputs.map(userProductInputToProduct);
  const allProducts = [...catalogProducts.filter((product) => !hiddenProductIdSet.has(product.id)), ...manualProducts];
  const productIds = new Set(allProducts.map((product) => product.id));

  const changedHoldingProductIds = sanitizeChangedProductIds(payload?.changedHoldingProductIds ?? Object.keys(candidate), productIds);
  const changedOverrideProductIds = sanitizeChangedProductIds(payload?.changedOverrideProductIds ?? [], productIds);
  if (!changedHoldingProductIds || !changedOverrideProductIds) {
    return NextResponse.json({ error: "变更的产品格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  }
  const entries = changedHoldingProductIds.flatMap((productId) => {
    const rawAmount = (candidate as Record<string, unknown>)[productId];
    const amount = typeof rawAmount === "number" ? rawAmount : Number(rawAmount);
    return productIds.has(productId) && Number.isFinite(amount) && amount >= 0 && amount <= 1e15 ? [[productId, amount] as const] : [];
  });
  if (entries.length !== changedHoldingProductIds.length) return NextResponse.json({ error: "持仓数据格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  const overrideCandidate = typeof payload?.overrides === "object" && payload.overrides !== null && !Array.isArray(payload.overrides)
    ? payload.overrides as Record<string, unknown>
    : {};
  const overrideEntries = changedOverrideProductIds.map((productId) => {
    const product = allProducts.find((item) => item.id === productId)!;
    const raw = typeof overrideCandidate[productId] === "object" && overrideCandidate[productId] !== null
      ? overrideCandidate[productId] as { apr?: unknown; firstTierLimit?: unknown; termDays?: unknown; purchaseDate?: unknown }
      : {};
    const apr = productNeedsManualApr(product) ? optionalApr(raw.apr) : null;
    const firstTierLimit = productNeedsManualLimit(product) ? optionalLimit(raw.firstTierLimit) : null;
    const termDays = productNeedsManualTerm(product) ? optionalTerm(raw.termDays) : null;
    const purchaseDate = productNeedsPurchaseDate(product) ? optionalDate(raw.purchaseDate) : null;
    if (apr === undefined || firstTierLimit === undefined || termDays === undefined || purchaseDate === undefined) return null;
    return { productId, apr, firstTierLimit, termDays, purchaseDate };
  });
  if (overrideEntries.some((entry) => entry === null)) {
    return NextResponse.json({ error: "人工额度、APR、期限或买入日格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  }
  if (entries.length === 0 && overrideEntries.length === 0 && manualProductUpdates.length === 0 && deletedManualProductIds.length === 0 && !hiddenProductsProvided) {
    return NextResponse.json({ error: "没有需要保存的变更。" }, { status: 400, headers: privateResponseHeaders });
  }

  const updatedAt = new Date().toISOString();
  const statements = [
    ...prepareUserProductStatements(db, userId, manualProductUpdates, deletedManualProductIds, updatedAt),
    ...(hiddenProductsProvided ? [
      db.prepare("DELETE FROM hidden_products WHERE user_id = ?").bind(userId),
      db.prepare("DELETE FROM hidden_seed_products WHERE user_id = ?").bind(userId),
      ...hiddenProductIds.map((productId) => db.prepare(`INSERT INTO hidden_products (user_id, product_id, hidden_at)
        VALUES (?, ?, ?)`)
        .bind(userId, productId, updatedAt)),
    ] : []),
    ...(hiddenProductsProvided ? hiddenProductIds.flatMap((productId) => [
      db.prepare("DELETE FROM holdings WHERE user_id = ? AND product_id = ?").bind(userId, productId),
      db.prepare("DELETE FROM product_overrides WHERE user_id = ? AND product_id = ?").bind(userId, productId),
      db.prepare("DELETE FROM product_override_limits WHERE user_id = ? AND product_id = ?").bind(userId, productId),
      db.prepare("DELETE FROM product_override_terms WHERE user_id = ? AND product_id = ?").bind(userId, productId),
    ]) : []),
    ...entries.map(([productId, amount]) => db.prepare(`INSERT INTO holdings (user_id, product_id, amount, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, product_id)
      DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`)
      .bind(userId, productId, amount, updatedAt)),
    ...overrideEntries.flatMap((entry) => entry ? [db.prepare(`INSERT INTO product_overrides
        (user_id, product_id, confirmed_apr, purchase_date, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, product_id)
        DO UPDATE SET confirmed_apr = excluded.confirmed_apr,
          purchase_date = excluded.purchase_date,
          updated_at = excluded.updated_at`)
      .bind(userId, entry.productId, entry.apr, entry.purchaseDate, updatedAt)] : []),
    ...overrideEntries.flatMap((entry) => entry ? [db.prepare(`INSERT INTO product_override_limits
        (user_id, product_id, first_tier_limit, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, product_id)
        DO UPDATE SET first_tier_limit = excluded.first_tier_limit,
          updated_at = excluded.updated_at`)
      .bind(userId, entry.productId, entry.firstTierLimit, updatedAt)] : []),
    ...overrideEntries.flatMap((entry) => entry ? [db.prepare(`INSERT INTO product_override_terms
        (user_id, product_id, term_days, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, product_id)
        DO UPDATE SET term_days = excluded.term_days,
          updated_at = excluded.updated_at`)
      .bind(userId, entry.productId, entry.termDays, updatedAt)] : []),
  ];
  if (statements.length > 0) await db.batch(statements);
  return NextResponse.json({ saved: entries.length, manualUpdated: overrideEntries.length, productUpdated: manualProductUpdates.length, productDeleted: deletedManualProductIds.length + (hiddenProductsProvided ? hiddenProductIds.length : 0), updatedAt }, { headers: privateResponseHeaders });
}

function sanitizeChangedProductIds(value: unknown, productIds: Set<string>) {
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.filter((productId): productId is string => typeof productId === "string"))];
  return ids.length === value.length && ids.every((productId) => productIds.has(productId)) ? ids : null;
}

function sanitizeHiddenProductIds(value: unknown, removableProductIds: Set<string>) {
  if (!Array.isArray(value) || value.length > removableProductIds.size) return null;
  const ids = [...new Set(value.filter((productId): productId is string => typeof productId === "string"))];
  return ids.length === value.length && ids.every((productId) => removableProductIds.has(productId)) ? ids : null;
}

function optionalApr(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const apr = typeof value === "number" ? value : Number(value);
  return Number.isFinite(apr) && apr >= 0 && apr <= 10000 ? apr : undefined;
}

function optionalLimit(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const limit = typeof value === "number" ? value : Number(value);
  return Number.isFinite(limit) && limit > 0 && limit <= 1e15 ? limit : undefined;
}

function optionalTerm(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const termDays = typeof value === "number" ? value : Number(value);
  return Number.isFinite(termDays) && termDays > 0 && termDays <= 3650 ? termDays : undefined;
}

function optionalDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? value : undefined;
}
