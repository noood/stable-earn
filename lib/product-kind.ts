import type { ProductKind } from "./domain";

export type ProductKindResolution =
  | { status: "missing" }
  | { status: "unrecognized" }
  | { status: "known"; kind: ProductKind };

/** Normalize only explicit, recognized category values; never guess a default. */
export function resolveProductKind(value: unknown): ProductKindResolution {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return { status: "missing" };
  }
  if (typeof value !== "string") return { status: "unrecognized" };

  const normalized = value.trim().toLocaleLowerCase().replace(/[\s_-]+/g, " ");
  if (["flexible", "flexible earn", "flexible saving", "活期", "活期理财"].includes(normalized)) {
    return { status: "known", kind: "flexible" };
  }
  if (["fixed", "fixed earn", "fixed saving", "locked", "定期", "定期理财"].includes(normalized)) {
    return { status: "known", kind: "fixed" };
  }
  if (["limited", "limited flexible", "limited time flexible", "限时活期", "限时活期理财"].includes(normalized)) {
    return { status: "known", kind: "limited" };
  }
  return { status: "unrecognized" };
}

export function productKindLabel(kind: ProductKind) {
  switch (kind) {
    case "flexible": return "活期理财";
    case "fixed": return "定期理财";
    case "limited": return "限时活期";
  }
}

export function productTypeForKind(kind: ProductKind) {
  return kind === "fixed" ? "fixed" as const : "flexible" as const;
}
