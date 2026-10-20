import { NextResponse } from "next/server";
import { getDatabase, getUserId } from "@/lib/db";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";
import type { HoldingMap, HoldingSyncState } from "@/lib/domain";
import { productNeedsManualType, productTypeSelectionAvailable, type ProductOverrideMap } from "@/lib/product-overrides";
import { parseProductOverride } from "@/lib/product-override-input";
import { loadUserProducts, prepareUserProductStatements, productToUserProduct, sanitizeUserProducts, userProductInputToProduct } from "@/lib/user-products";
import { delayLocalPreviewScenario, isLocalPreviewRequest, localPreviewTime, localPrivateHoldingsPreview } from "@/lib/local-preview";
import { loadCatalogProducts } from "@/lib/product-catalog";
import { withStartupServerTiming, type StartupServerTiming } from "@/lib/startup-timing";
import {
  buildManualChangeEvents,
  loadProductHistorySummaries,
  loadProductChangeEvents,
  prepareProductChangeEventStatements,
  type ProductChangeSource,
} from "@/lib/product-change-events";

export const dynamic = "force-dynamic";

type HoldingRow = { product_id: string; amount: number };
type OverrideRow = { product_id: string; confirmed_apr: number | null; purchase_date: string | null; product_kind_override: "flexible" | "fixed" | "limited" | null; updated_at: string };
type LimitRow = { product_id: string; first_tier_limit: number | null };
type TermRow = { product_id: string; term_days: number | null };
type OverrideSnapshotRow = { product_id: string; confirmed_apr: number | null; purchase_date: string | null; product_kind_override: "flexible" | "fixed" | "limited" | null };
type HiddenProductRow = { product_id: string };

export async function GET(request: Request) {
  return withStartupServerTiming(request, (timing) => getHoldings(request, timing));
}

async function getHoldings(request: Request, timing: StartupServerTiming) {
  const userId = await timing.measure("auth", () => getUserId(request));
  if (!userId) return NextResponse.json({ error: "请先登录后再读取持仓。" }, { status: 401, headers: privateResponseHeaders });
  if (isLocalPreviewRequest(request)) {
    const scenario = new URL(request.url).searchParams.get("syncScenario");
    if (scenario === "personal-error" || scenario === "both-read-error") {
      if (scenario === "both-read-error") await delayLocalPreviewScenario(request, scenario);
      return NextResponse.json({ error: "本地模拟：个人数据读取失败" }, { status: 503, headers: privateResponseHeaders });
    }
    return NextResponse.json(scenario && scenario !== "api-dates"
      ? { holdings: {}, overrides: {}, manualProducts: [], hiddenProductIds: [], found: false }
      : localPrivateHoldingsPreview(localPreviewTime(request.url), scenario === "api-dates"), { headers: privateResponseHeaders });
  }

  const db = await timing.measure("database", () => getDatabase());
  const [catalogProducts, manualProducts, holdingResult, positionResult, overrideResult, limitResult, termResult, hiddenResult, hiddenCatalogResult, syncSnapshotResult] = await Promise.all([
    loadCatalogProducts(db, userId),
    loadUserProducts(db, userId),
    db.prepare("SELECT product_id, amount FROM holdings WHERE user_id = ? ORDER BY product_id").bind(userId).all<HoldingRow>(),
    db.prepare("SELECT product_id, amount FROM holding_positions WHERE user_id = ? ORDER BY product_id").bind(userId).all<HoldingRow>(),
    db.prepare(`SELECT product_id, confirmed_apr, purchase_date, product_kind_override, updated_at
      FROM product_overrides WHERE user_id = ? ORDER BY product_id`).bind(userId).all<OverrideRow>(),
    db.prepare(`SELECT product_id, first_tier_limit
      FROM product_override_limits WHERE user_id = ? ORDER BY product_id`).bind(userId).all<LimitRow>(),
    db.prepare(`SELECT product_id, term_days
      FROM product_override_terms WHERE user_id = ? ORDER BY product_id`).bind(userId).all<TermRow>(),
    db.prepare("SELECT product_id FROM hidden_seed_products WHERE user_id = ? ORDER BY product_id").bind(userId).all<HiddenProductRow>(),
    db.prepare("SELECT product_id FROM hidden_products WHERE user_id = ? ORDER BY product_id").bind(userId).all<HiddenProductRow>(),
    db.prepare("SELECT payload FROM sync_snapshots WHERE owner_id = ? AND cache_key = 'private-products'").bind(userId).all<{ payload: string | null }>(),
  ]);
  const removableProducts = new Set([...catalogProducts, ...manualProducts].map((product) => product.id));
  const storedHiddenProductIds = [...new Set([
    ...hiddenResult.results.map((row) => row.product_id),
    ...hiddenCatalogResult.results.map((row) => row.product_id),
  ])].filter((productId) => removableProducts.has(productId));
  const holdingAmounts = new Map(holdingResult.results.map((row) => [row.product_id, Number(row.amount)]));
  const positionAmounts = new Map<string, number>();
  for (const row of positionResult.results) positionAmounts.set(row.product_id, (positionAmounts.get(row.product_id) ?? 0) + Number(row.amount));
  const snapshot = parseSyncSnapshot(syncSnapshotResult.results[0]?.payload);
  // Hiding an opportunity must never hide a positive position. The position
  // remains visible until it is genuinely zero, even if the user hid the row.
  const hiddenProductIds = storedHiddenProductIds.filter((productId) => {
    const freshAmount = trustedSnapshotAmount(snapshot, productId);
    return (freshAmount ?? holdingAmounts.get(productId) ?? 0) <= 0 && (positionAmounts.get(productId) ?? 0) <= 0;
  });
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
      manualKind: row.product_kind_override,
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
  const payload = typeof body === "object" && body !== null ? body as { holdings?: unknown; overrides?: unknown; changedHoldingProductIds?: unknown; changedOverrideProductIds?: unknown; manualProducts?: unknown; deletedManualProductIds?: unknown; hiddenProductIds?: unknown; source?: unknown } : null;
  const candidate = payload?.holdings ?? null;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return NextResponse.json({ error: "缺少持仓数据。" }, { status: 400, headers: privateResponseHeaders });
  }

  const db = await getDatabase();
  const [existingManualProducts, catalogProducts, holdingResult, positionResult, overrideResult, limitResult, termResult, hiddenCatalogResult, legacyHiddenResult, syncSnapshotResult] = await Promise.all([
    loadUserProducts(db, userId),
    loadCatalogProducts(db, userId),
    db.prepare("SELECT product_id, amount FROM holdings WHERE user_id = ? ORDER BY product_id").bind(userId).all<HoldingRow>(),
    db.prepare("SELECT product_id, amount FROM holding_positions WHERE user_id = ? ORDER BY product_id").bind(userId).all<HoldingRow>(),
    db.prepare(`SELECT product_id, confirmed_apr, purchase_date, product_kind_override
      FROM product_overrides WHERE user_id = ? ORDER BY product_id`).bind(userId).all<OverrideSnapshotRow>(),
    db.prepare(`SELECT product_id, first_tier_limit
      FROM product_override_limits WHERE user_id = ? ORDER BY product_id`).bind(userId).all<LimitRow>(),
    db.prepare(`SELECT product_id, term_days
      FROM product_override_terms WHERE user_id = ? ORDER BY product_id`).bind(userId).all<TermRow>(),
    db.prepare("SELECT product_id FROM hidden_products WHERE user_id = ? ORDER BY product_id").bind(userId).all<HiddenProductRow>(),
    db.prepare("SELECT product_id FROM hidden_seed_products WHERE user_id = ? ORDER BY product_id").bind(userId).all<HiddenProductRow>(),
    db.prepare("SELECT payload, last_error FROM sync_snapshots WHERE owner_id = ? AND cache_key = 'private-products'").bind(userId).all<{ payload: string | null; last_error: string | null }>(),
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

  // Hiding is a presentation choice, never a way to conceal an active
  // position. Re-check both the aggregate and detailed positions on the
  // server; a client cannot bypass this by sending a crafted hidden list.
  const positionAmounts = new Map<string, number>();
  for (const row of positionResult.results) positionAmounts.set(row.product_id, (positionAmounts.get(row.product_id) ?? 0) + Number(row.amount));
  const snapshot = parseSyncSnapshot(syncSnapshotResult.results[0]?.payload);
  const catalogById = new Map(catalogProducts.map((product) => [product.id, product]));
  const savedAmounts = new Map(holdingResult.results.map((row) => [row.product_id, Number(row.amount)]));
  if (hiddenProductsProvided) {
    for (const productId of hiddenProductIds) {
      const product = catalogById.get(productId);
      if (!product) continue;
      const positions = positionAmounts.get(productId) ?? 0;
      const knownZero = product.holdingDataMode === "api"
        ? trustedSnapshotAmount(snapshot, productId) === 0
        : (savedAmounts.get(productId) ?? 0) === 0;
      if (!knownZero || positions > 0) {
        return NextResponse.json({ error: "有持仓或暂时无法确认持仓的产品不能移除。" }, { status: 409, headers: privateResponseHeaders });
      }
    }
  }

  const changedHoldingProductIds = sanitizeChangedProductIds(payload?.changedHoldingProductIds ?? Object.keys(candidate), productIds);
  const changedOverrideProductIds = sanitizeChangedProductIds(payload?.changedOverrideProductIds ?? [], productIds);
  if (!changedHoldingProductIds || !changedOverrideProductIds) {
    return NextResponse.json({ error: "变更的产品格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  }
  const entries = changedHoldingProductIds.flatMap((productId) => {
    const rawAmount = (candidate as Record<string, unknown>)[productId];
    const amount = typeof rawAmount === "number" ? rawAmount : Number.NaN;
    const product = allProducts.find((item) => item.id === productId);
    const trustedAmount = product?.holdingDataMode === "api" ? trustedSnapshotAmount(snapshot, productId) : undefined;
    return product && Number.isFinite(amount) && amount >= 0 && amount <= 1e15
      && (product.holdingDataMode !== "api" || trustedAmount === amount)
      ? [[productId, amount] as const] : [];
  });
  if (entries.length !== changedHoldingProductIds.length) return NextResponse.json({ error: "持仓数据格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  const overrideCandidate = typeof payload?.overrides === "object" && payload.overrides !== null && !Array.isArray(payload.overrides)
    ? payload.overrides as Record<string, unknown>
    : {};
  const savedOverrides = new Map(overrideResult.results.map((row) => [row.product_id, row]));
  const typeSnapshot = parseSyncSnapshot(syncSnapshotResult.results[0]?.payload);
  const snapshotLastError = syncSnapshotResult.results[0]?.last_error;
  for (const productId of changedOverrideProductIds) {
    const raw = overrideCandidate[productId];
    if (!isRecord(raw) || !Object.hasOwn(raw, "manualKind")) continue;
    const product = allProducts.find((item) => item.id === productId)!;
    const previousKind = savedOverrides.get(productId)?.product_kind_override ?? null;
    const requestedKind = raw.manualKind ?? null;
    if (productNeedsManualType(product) && requestedKind !== previousKind
      && !productTypeSelectionAvailable(
        product,
        typeSnapshot?.holdingSyncStates?.[product.id],
        Object.hasOwn(typeSnapshot?.holdingFallbacks ?? {}, product.id),
        Boolean(snapshotLastError),
      )) {
      return NextResponse.json({ error: "产品类型数据暂不可用，需等待对应 API 同步成功后再修改。" }, { status: 409, headers: privateResponseHeaders });
    }
  }
  const overrideEntries = changedOverrideProductIds.map((productId) => {
    const product = allProducts.find((item) => item.id === productId)!;
    return parseProductOverride(product, overrideCandidate[productId]);
  });
  if (overrideEntries.some((entry) => entry === null)) {
    return NextResponse.json({ error: "人工额度、APR、期限或买入日格式不正确。" }, { status: 400, headers: privateResponseHeaders });
  }
  if (entries.length === 0 && overrideEntries.length === 0 && manualProductUpdates.length === 0 && deletedManualProductIds.length === 0 && !hiddenProductsProvided) {
    return NextResponse.json({ error: "没有需要保存的变更。" }, { status: 400, headers: privateResponseHeaders });
  }

  const updatedAt = new Date().toISOString();
  const source = parseChangeSource(payload?.source);
  const previousHoldings = Object.fromEntries(holdingResult.results.map((row) => [row.product_id, Number(row.amount)])) as HoldingMap;
  const nextHoldings = { ...previousHoldings, ...Object.fromEntries(entries) } as HoldingMap;
  const previousOverrides = buildOverrideMap(overrideResult.results, limitResult.results, termResult.results);
  const nextOverrides = { ...previousOverrides } as ProductOverrideMap;
  for (const entry of overrideEntries) {
    if (entry) nextOverrides[entry.productId] = {
      apr: entry.apr,
      firstTierLimit: entry.firstTierLimit,
      termDays: entry.termDays,
      purchaseDate: entry.purchaseDate,
      updatedAt,
      manualKind: entry.manualKind,
    };
  }
  const changeEvents = source === "手动编辑"
    ? buildManualChangeEvents(
      previousHoldings,
      nextHoldings,
      previousOverrides,
      nextOverrides,
      existingManualProducts,
      manualProducts,
      catalogProducts,
      {
        holdingProductIds: changedHoldingProductIds,
        overrideProductIds: changedOverrideProductIds,
        manualProductIds: manualProductUpdates.map((product) => product.id),
        deletedManualProductIds,
      },
      updatedAt,
    )
    : [];
  const statements = [
    ...prepareUserProductStatements(db, userId, manualProductUpdates, deletedManualProductIds, updatedAt),
    ...(hiddenProductsProvided ? [
      db.prepare("DELETE FROM hidden_products WHERE user_id = ?").bind(userId),
      db.prepare("DELETE FROM hidden_seed_products WHERE user_id = ?").bind(userId),
      ...hiddenProductIds.map((productId) => db.prepare(`INSERT INTO hidden_products (user_id, product_id, hidden_at)
        VALUES (?, ?, ?)`)
        .bind(userId, productId, updatedAt)),
    ] : []),
    ...entries.map(([productId, amount]) => db.prepare(`INSERT INTO holdings (user_id, product_id, amount, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, product_id)
      DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`)
      .bind(userId, productId, amount, updatedAt)),
    ...overrideEntries.flatMap((entry) => entry ? [db.prepare(`INSERT INTO product_overrides
        (user_id, product_id, confirmed_apr, purchase_date, product_kind_override, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, product_id)
        DO UPDATE SET confirmed_apr = excluded.confirmed_apr,
          purchase_date = excluded.purchase_date,
          product_kind_override = excluded.product_kind_override,
          updated_at = excluded.updated_at`)
      .bind(userId, entry.productId, entry.apr, entry.purchaseDate, entry.manualKind, updatedAt)] : []),
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
    ...prepareProductChangeEventStatements(db, userId, changeEvents),
  ];
  if (statements.length > 0) await db.batch(statements);
  const history = new URL(request.url).searchParams.get("history") === "summary"
    ? { historySummaries: await loadProductHistorySummaries(db, userId) }
    : { changeEvents: await loadProductChangeEvents(db, userId) };
  return NextResponse.json({ saved: entries.length, manualUpdated: overrideEntries.length, productUpdated: manualProductUpdates.length, productDeleted: deletedManualProductIds.length, productHidden: hiddenProductsProvided ? hiddenProductIds.length : 0, updatedAt, ...history }, { headers: privateResponseHeaders });
}

function parseChangeSource(value: unknown): ProductChangeSource {
  return value === "定时刷新" || value === "手动刷新" || value === "每日首次打开" || value === "手动编辑"
    ? value
    : "手动编辑";
}

function buildOverrideMap(overrides: OverrideSnapshotRow[], limits: LimitRow[], terms: TermRow[]) {
  const limitMap = new Map(limits.map((row) => [row.product_id, row.first_tier_limit]));
  const termMap = new Map(terms.map((row) => [row.product_id, row.term_days]));
  return Object.fromEntries(overrides.map((row) => [row.product_id, {
    apr: row.confirmed_apr === null ? null : Number(row.confirmed_apr),
    firstTierLimit: limitMap.get(row.product_id) ?? null,
    termDays: termMap.get(row.product_id) ?? null,
    purchaseDate: row.purchase_date,
    updatedAt: null,
    manualKind: row.product_kind_override,
  }])) as ProductOverrideMap;
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

function parseSyncSnapshot(payload: string | null | undefined) {
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as {
      holdingUpdates?: unknown;
      holdingSyncStates?: unknown;
      holdingFallbacks?: unknown;
    };
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const holdingSyncStates = isRecord(value.holdingSyncStates)
      ? Object.fromEntries(Object.entries(value.holdingSyncStates).filter((entry): entry is [string, HoldingSyncState] => isHoldingSyncState(entry[1])))
      : undefined;
    const holdingFallbacks = isRecord(value.holdingFallbacks) ? value.holdingFallbacks : undefined;
    const holdingUpdates = isRecord(value.holdingUpdates) ? value.holdingUpdates : undefined;
    return { holdingUpdates, holdingSyncStates, holdingFallbacks };
  } catch {
    return null;
  }
}

function isHoldingSyncState(value: unknown): value is HoldingSyncState {
  return value === "not_configured" || value === "synced" || value === "partial" || value === "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trustedSnapshotAmount(snapshot: ReturnType<typeof parseSyncSnapshot>, productId: string) {
  if (snapshot?.holdingSyncStates?.[productId] !== "synced") return undefined;
  if (!Object.hasOwn(snapshot.holdingUpdates ?? {}, productId)) return undefined;
  const amount = snapshot.holdingUpdates?.[productId];
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}
