import type { ProductChangeEvent } from "./domain";

type ProductHistoryPage = { events: ProductChangeEvent[]; nextCursor: string | null };
type PreviewScenario = "initial-error" | "pagination" | "more-error";

const scenarios: Record<string, PreviewScenario> = {
  "by-g-usdt-short-fixed": "initial-error",
  "preview-apr-six": "pagination",
  "preview-below-threshold-held": "more-error",
};

/** Local-only Bybit USDT fixtures: one product per history loading scenario. */
export function createLocalProductHistoryPreviewLoader() {
  const failedInitial = new Set<string>();
  const failedMore = new Set<string>();

  return async (productId: string, cursor: string | null): Promise<ProductHistoryPage> => {
    const scenario = scenarios[productId];
    if (!scenario) throw new Error("Unknown local product history preview");
    await new Promise((resolve) => setTimeout(resolve, 450));

    if (scenario === "initial-error" && cursor === null && !failedInitial.has(productId)) {
      failedInitial.add(productId);
      throw new Error("Local history preview: initial request failed");
    }
    if (scenario === "more-error" && cursor !== null && !failedMore.has(productId)) {
      failedMore.add(productId);
      throw new Error("Local history preview: next page failed");
    }

    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isInteger(offset) || offset < 0 || offset > 6 || (offset !== 0 && offset !== 3)) {
      throw new Error("Invalid local history cursor");
    }
    const events = createEvents(productId);
    const pageEvents = events.slice(offset, offset + 3);
    const nextOffset = offset + pageEvents.length;
    const hasMore = scenario !== "initial-error" && nextOffset < events.length;
    return { events: pageEvents, nextCursor: hasMore ? String(nextOffset) : null };
  };
}

function createEvents(productId: string): ProductChangeEvent[] {
  const eventTypes: ProductChangeEvent["type"][] = ["rate", "capacity", "holding"];
  const titles = ["APR 调整", "申购额度调整", "持仓变化"];
  const before = ["8.80%", "1,000 USDT", "80 USDT"];
  const after = ["8.60%", "800 USDT", "100 USDT"];
  return Array.from({ length: 6 }, (_, index) => ({
    id: `local-${productId}-history-${index + 1}`,
    productId,
    type: eventTypes[index % eventTypes.length],
    title: titles[index % titles.length],
    before: before[index % before.length],
    after: after[index % after.length],
    observedAt: new Date(Date.UTC(2026, 9, 7) - index * 60 * 60 * 1000).toISOString(),
    source: index % 2 === 0 ? "手动刷新" : "每日首次打开",
  }));
}
