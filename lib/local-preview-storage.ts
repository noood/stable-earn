import type { ProductKind } from "./domain";
import type { ProductOverrideMap } from "./product-overrides";

const storageKey = "stable-earn:local-preview:product-overrides:v1";
const productKinds = new Set<ProductKind>(["flexible", "fixed", "limited"]);

/** The local browser preview mimics saved settings without touching a database. */
export function readLocalPreviewOverrides(): ProductOverrideMap {
  if (typeof window === "undefined") return {};
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (!isRecord(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([productId, raw]) => {
      if (!/^[-a-z0-9]{1,100}$/i.test(productId) || !isRecord(raw)) return [];
      const manualKind = raw.manualKind === null || raw.manualKind === undefined || productKinds.has(raw.manualKind as ProductKind)
        ? raw.manualKind as ProductKind | null | undefined
        : undefined;
      if (manualKind === undefined && raw.manualKind !== undefined) return [];
      const numberField = (entry: unknown) => entry === null || (typeof entry === "number" && Number.isFinite(entry)) ? entry : null;
      const date = raw.purchaseDate === null || typeof raw.purchaseDate === "string" ? raw.purchaseDate : null;
      return [[productId, {
        apr: numberField(raw.apr) as number | null,
        firstTierLimit: numberField(raw.firstTierLimit) as number | null,
        termDays: numberField(raw.termDays) as number | null,
        purchaseDate: date,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
        ...(manualKind !== undefined ? { manualKind } : {}),
      } satisfies ProductOverrideMap[string]]];
    }));
  } catch {
    return {};
  }
}

export function saveLocalPreviewOverrides(overrides: ProductOverrideMap) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(overrides));
  } catch {
    // The preview remains usable when browser storage is unavailable.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
