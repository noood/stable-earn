"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ProductChangeEvent } from "@/lib/domain";
import { useDismissiblePopover } from "@/app/components/use-dismissible-popover";
import { ActionButton } from "@/app/components/ui";
import { mergeNewProductHistoryEvents, mergeProductHistoryEvents, productHistoryRevision } from "@/lib/product-history-state";

export type ProductHistoryPage = { events: ProductChangeEvent[]; nextCursor: string | null };
const PRODUCT_HISTORY_OPEN_EVENT = "stable-earn:product-history-open";

export function ProductHistory({ productId, events, loadPage, onEventsRead, readOnlyPreview = false }: {
  productId: string;
  events: ProductChangeEvent[];
  loadPage?: (cursor: string | null) => Promise<ProductHistoryPage>;
  onEventsRead?: (readAt: string, eventIds: string[]) => void;
  readOnlyPreview?: boolean;
}) {
  const instanceId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestedRevisionRef = useRef<string | null>(null);
  const historyRequestIdRef = useRef(0);
  const failedCursorRef = useRef<string | null>(null);
  const pendingReadIdsRef = useRef(new Set<string>());
  const focusPopoverOnOpenRef = useRef(false);
  const restorePopoverFocusAfterLoadRef = useRef(false);
  const suppressFocusOpenRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [acknowledgedEventIds, setAcknowledgedEventIds] = useState<string[]>([]);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [loadedHistoryEvents, setLoadedHistoryEvents] = useState<ProductChangeEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [initialHistoryLoadComplete, setInitialHistoryLoadComplete] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [loadedRevision, setLoadedRevision] = useState<string | null>(null);
  const [initialSnapshotIds, setInitialSnapshotIds] = useState<string[] | null>(null);
  const eventsRevision = useMemo(() => productHistoryRevision(events), [events]);
  // API snapshot props can contain thousands of older events. They drive the
  // dot/revision, not the paged timeline before those pages have been read.
  const historyEvents = useMemo(() => {
    if (loadedHistoryEvents === null) return loadPage ? [] : mergeProductHistoryEvents(events);
    return mergeNewProductHistoryEvents(loadedHistoryEvents, events, initialSnapshotIds ?? []);
  }, [events, loadedHistoryEvents, loadPage, initialSnapshotIds]);
  const attention = events.some((event) => event.attention && !event.readAt && !acknowledgedEventIds.includes(event.id))
    || historyEvents.some((event) => event.attention && !event.readAt && !acknowledgedEventIds.includes(event.id));
  const sortedEvents = historyEvents;

  useDismissiblePopover(open, setOpen, buttonRef, popoverRef, { closeOnScroll: false });

  useLayoutEffect(() => {
    if (!open) return;
    if (focusPopoverOnOpenRef.current) {
      focusPopoverOnOpenRef.current = false;
      focusPopover();
    } else if (!historyLoading && restorePopoverFocusAfterLoadRef.current) {
      restorePopoverFocusAfterLoadRef.current = false;
      // A retry can replace its focused button with a non-interactive result.
      if (document.activeElement === document.body) popoverRef.current?.focus({ preventScroll: true });
    }
  }, [open, historyLoading, sortedEvents.length]);

  useEffect(() => {
    if (!open) return;
    function closeWhenAnotherOpens(event: Event) {
      if ((event as CustomEvent<string>).detail === instanceId) return;
      cancelScheduledClose();
      cancelScheduledHoverOpen();
      setOpen(false);
    }
    function closeWhenFocusLeaves(event: FocusEvent) {
      const next = event.target;
      if (!(next instanceof Node) || buttonRef.current?.contains(next) || popoverRef.current?.contains(next)) return;
      restorePopoverFocusAfterLoadRef.current = false;
      cancelScheduledClose();
      cancelScheduledHoverOpen();
      setOpen(false);
    }
    window.addEventListener(PRODUCT_HISTORY_OPEN_EVENT, closeWhenAnotherOpens);
    document.addEventListener("focusin", closeWhenFocusLeaves);
    return () => {
      window.removeEventListener(PRODUCT_HISTORY_OPEN_EVENT, closeWhenAnotherOpens);
      document.removeEventListener("focusin", closeWhenFocusLeaves);
    };
  }, [open, instanceId]);

  useEffect(() => {
    if (!open || typeof IntersectionObserver === "undefined") return;
    const trigger = buttonRef.current;
    if (!trigger) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      const triggerVisible = entry.isIntersecting
        && entry.intersectionRect.width > 0
        && entry.intersectionRect.height > 0;
      if (!triggerVisible) {
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
        setOpen(false);
      }
    });
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [open, setOpen]);

  useLayoutEffect(() => {
    if (!open) return;
    function updatePosition() {
      const trigger = buttonRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
      const triggerRect = trigger.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const gutter = 12;
      const left = Math.max(gutter, Math.min(triggerRect.right - popoverRect.width, window.innerWidth - popoverRect.width - gutter));
      const preferredTop = window.innerHeight - triggerRect.bottom >= popoverRect.height + 8 || triggerRect.top < popoverRect.height + 8
        ? triggerRect.bottom + 8
        : triggerRect.top - popoverRect.height - 8;
      const top = Math.max(gutter, Math.min(preferredTop, window.innerHeight - popoverRect.height - gutter));
      setPosition((current) => current.top === top && current.left === left ? current : { top, left });
    }
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, sortedEvents.length]);

  useEffect(() => () => {
    historyRequestIdRef.current += 1;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  function cancelScheduledClose() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function cancelScheduledHoverOpen() {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }

  function scheduleClose() {
    cancelScheduledHoverOpen();
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      const focused = document.activeElement;
      const keyboardFocusWithin = focused instanceof HTMLElement && focused.matches(":focus-visible")
        && (buttonRef.current?.contains(focused) || popoverRef.current?.contains(focused));
      const keyboardLoadingLostFocus = focused === document.body && restorePopoverFocusAfterLoadRef.current;
      if (!keyboardFocusWithin && !keyboardLoadingLostFocus && !popoverRef.current?.matches(":hover")) setOpen(false);
    }, 180);
  }

  const requestHistoryPage = useCallback(async (cursor: string | null) => {
    if (!loadPage) return;
    const requestId = ++historyRequestIdRef.current;
    if (cursor === null) requestedRevisionRef.current = eventsRevision;
    const focused = document.activeElement;
    restorePopoverFocusAfterLoadRef.current = focused instanceof HTMLElement && focused.matches(":focus-visible")
      && !!popoverRef.current?.contains(focused);
    setHistoryLoading(true);
    try {
      const page = await loadPage(cursor);
      if (requestId !== historyRequestIdRef.current) return;
      setInitialSnapshotIds((current) => current ?? events.map((event) => event.id));
      setLoadedHistoryEvents((current) => mergeProductHistoryEvents(
        current === null ? [] : mergeNewProductHistoryEvents(current, events, initialSnapshotIds ?? []),
        page.events,
      ));
      setNextCursor(page.nextCursor);
      setHistoryError(false);
      if (cursor === null) setLoadedRevision(eventsRevision);
    } catch {
      if (requestId !== historyRequestIdRef.current) return;
      failedCursorRef.current = cursor;
      setHistoryError(true);
    } finally {
      if (requestId === historyRequestIdRef.current) {
        setHistoryLoading(false);
        if (cursor === null) setInitialHistoryLoadComplete(true);
      }
    }
  }, [loadPage, eventsRevision, events, initialSnapshotIds]);

  const ensureInitialHistoryRequest = useCallback(() => {
    if (!loadPage || requestedRevisionRef.current === eventsRevision) return;
    void requestHistoryPage(null);
  }, [loadPage, eventsRevision, requestHistoryPage]);

  const persistReadState = useCallback(async () => {
    const unreadIds = historyEvents.filter((event) => event.attention && !event.readAt
      && !acknowledgedEventIds.includes(event.id) && !pendingReadIdsRef.current.has(event.id)).map((event) => event.id).slice(0, 50);
    if (unreadIds.length === 0) return;
    if (!loadPage || readOnlyPreview) {
      setAcknowledgedEventIds((current) => [...new Set([...current, ...unreadIds])]);
      return;
    }
    unreadIds.forEach((id) => pendingReadIdsRef.current.add(id));
    try {
      const response = await fetch("/private/api/product-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, eventIds: unreadIds }),
      });
      if (!response.ok) return;
      const result = await response.json() as { readAt?: unknown };
      if (typeof result.readAt !== "string") return;
      setAcknowledgedEventIds((current) => [...new Set([...current, ...unreadIds])]);
      const confirmed = new Set(unreadIds);
      setLoadedHistoryEvents((current) => (current ?? historyEvents).map((event) => confirmed.has(event.id)
        ? { ...event, readAt: result.readAt as string }
        : event));
      onEventsRead?.(result.readAt, unreadIds);
    } catch {
      // Leave the dot visible when persistence fails; a later open can retry.
    } finally {
      unreadIds.forEach((id) => pendingReadIdsRef.current.delete(id));
    }
  }, [historyEvents, acknowledgedEventIds, loadPage, readOnlyPreview, productId, onEventsRead]);

  useEffect(() => {
    if (open) ensureInitialHistoryRequest();
  }, [open, ensureInitialHistoryRequest]);

  useEffect(() => {
    // A first-page failure must not clear a dot for history the user never
    // received. Effects run after the confirmed list has been rendered.
    if (!open || historyLoading || historyError) return;
    if (loadPage && (!initialHistoryLoadComplete || loadedRevision !== eventsRevision)) return;
    void persistReadState();
  }, [open, historyLoading, historyError, loadPage, initialHistoryLoadComplete, loadedRevision, eventsRevision, persistReadState]);

  function openPopover() {
    cancelScheduledClose();
    cancelScheduledHoverOpen();
    window.dispatchEvent(new CustomEvent(PRODUCT_HISTORY_OPEN_EVENT, { detail: instanceId }));
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(288, window.innerWidth - 24);
      const estimatedHeight = Math.min(352, Math.max(108, sortedEvents.length * 92 + 58));
      const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
      const top = window.innerHeight - rect.bottom >= estimatedHeight + 8 || rect.top < estimatedHeight + 8
        ? rect.bottom + 8
        : rect.top - estimatedHeight - 8;
      setPosition({ top, left });
    }
    setOpen(true);
    ensureInitialHistoryRequest();
  }

  function scheduleHoverOpen() {
    cancelScheduledClose();
    cancelScheduledHoverOpen();
    if (open) return;
    // Use the hover-intent delay to fetch the first page before the bubble appears.
    ensureInitialHistoryRequest();
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      openPopover();
    }, 220);
  }

  function handleTriggerClick() {
    cancelScheduledHoverOpen();
    // Clicking only opens the transient hover-style popover; it never pins it.
    if (open) {
      cancelScheduledClose();
      cancelScheduledHoverOpen();
    }
    else openPopover();
  }

  function focusPopover() {
    const popover = popoverRef.current;
    if (!popover) return;
    (getTabStops(popover)[0] ?? popover).focus({ preventScroll: true });
  }

  function focusTrigger() {
    suppressFocusOpenRef.current = true;
    buttonRef.current?.focus({ preventScroll: true });
    suppressFocusOpenRef.current = false;
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelScheduledClose();
      cancelScheduledHoverOpen();
      setOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== " " && !(event.key === "Tab" && !event.shiftKey && open)) return;
    event.preventDefault();
    if (open) focusPopover();
    else {
      focusPopoverOnOpenRef.current = true;
      openPopover();
    }
  }

  function handlePopoverKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelScheduledClose();
      cancelScheduledHoverOpen();
      setOpen(false);
      focusTrigger();
      return;
    }
    if (event.key !== "Tab") return;
    const popover = event.currentTarget;
    const tabStops = getTabStops(popover);
    const focused = document.activeElement;
    if (event.shiftKey && (focused === popover || focused === tabStops[0])) {
      event.preventDefault();
      focusTrigger();
    } else if (!event.shiftKey && focused === popover && tabStops.length > 0) {
      event.preventDefault();
      tabStops[0].focus();
    } else if (!event.shiftKey && (focused === popover || focused === tabStops[tabStops.length - 1])) {
      // The portal sits at the end of body; continue after its trigger, not
      // after the portal, and never wrap or trap keyboard focus in this bubble.
      const pageTabStops = getTabStops(document.body).filter((element) => !popover.contains(element));
      const next = pageTabStops[pageTabStops.indexOf(buttonRef.current!) + 1];
      if (next) {
        event.preventDefault();
        next.focus();
      }
      restorePopoverFocusAfterLoadRef.current = false;
      setOpen(false);
    }
  }

  return <div className="product-history">
    <button
      ref={buttonRef}
      type="button"
      className="product-history-trigger"
      aria-label={attention ? "查看变更记录，有需要关注的变化" : "查看变更记录"}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? `${instanceId}-history` : undefined}
      onMouseEnter={scheduleHoverOpen}
      onMouseLeave={scheduleClose}
      onFocus={(event) => {
        cancelScheduledClose();
        if (!suppressFocusOpenRef.current && event.currentTarget.matches(":focus-visible")) openPopover();
      }}
      onBlur={(event) => {
        if (!event.relatedTarget || !(event.relatedTarget instanceof Node && popoverRef.current?.contains(event.relatedTarget))) scheduleClose();
      }}
      onClick={handleTriggerClick}
      onKeyDown={handleTriggerKeyDown}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.8" /><path d="M10 6.4v3.9l2.6 1.6" /><path d="M10 2.1v1.4M10 16.5v1.4M2.1 10h1.4M16.5 10h1.4" /></svg>
      {attention && <span className="product-history-dot" aria-hidden="true" />}
    </button>
    {open && createPortal(
      <div
        ref={popoverRef}
        id={`${instanceId}-history`}
        className="product-history-popover surface-popover"
        role="dialog"
        aria-label="产品变更记录"
        tabIndex={-1}
        style={{ top: position.top, left: position.left }}
        onMouseEnter={() => { cancelScheduledClose(); cancelScheduledHoverOpen(); }}
        onMouseLeave={scheduleClose}
        onFocus={() => { cancelScheduledClose(); cancelScheduledHoverOpen(); }}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && (event.currentTarget.contains(next) || buttonRef.current?.contains(next))) return;
          // Disabling/removing a loading action can blur it to body without
          // the user leaving. Do not close before its result can be shown.
          if (!next && (historyLoading || restorePopoverFocusAfterLoadRef.current)) return;
          restorePopoverFocusAfterLoadRef.current = false;
          scheduleClose();
        }}
        onKeyDown={handlePopoverKeyDown}
      >
        <div className="product-history-header"><p className="product-history-title">变更记录</p></div>
        {sortedEvents.length === 0
          ? <div className="product-history-state">
            {historyLoading && !initialHistoryLoadComplete
              ? <div className="product-history-loading" role="status" aria-label="正在加载变更记录">
                <span className="skeleton-block product-history-loading-line product-history-loading-line-primary" aria-hidden="true" />
                <span className="skeleton-block product-history-loading-line product-history-loading-line-secondary" aria-hidden="true" />
              </div>
              : historyError
                ? <ActionButton type="button" variant="text" className={`button-text-inline-action product-history-more product-history-state-action${historyLoading ? " product-history-loading-state" : " product-history-error"}`} aria-busy={historyLoading} disabled={historyLoading} onClick={() => void requestHistoryPage(failedCursorRef.current)}>{historyLoading ? "加载中…" : "加载失败，点击重试"}</ActionButton>
                : loadPage && !initialHistoryLoadComplete
                  ? null
                  : <p className="product-history-empty">暂无变更记录</p>}
          </div>
          : <ol className="product-history-list">{sortedEvents.map((event, index) => <li key={event.id} className="product-history-event">
            <span className={`product-history-node ${index === 0 ? "product-history-node-latest" : ""}`} aria-hidden="true" />
            <div className="product-history-event-copy">
              <div className="product-history-event-meta"><time dateTime={event.observedAt}>{formatDateTime(event.observedAt)}</time><span>{event.source}</span></div>
              <p className="product-history-event-title"><span>{event.title}</span>{event.before !== undefined && event.after !== undefined && <span className="product-history-event-change"><span>{event.before}</span><span className="product-history-arrow" aria-hidden="true">→</span><strong>{event.after}</strong></span>}</p>
            </div>
          </li>)}</ol>}
        {historyError && sortedEvents.length > 0 && <ActionButton type="button" variant="text" className={`button-text-inline-action product-history-more${historyLoading ? " product-history-loading-state" : " product-history-error"}`} aria-busy={historyLoading} disabled={historyLoading} onClick={() => void requestHistoryPage(failedCursorRef.current)}>{historyLoading ? "加载中…" : "加载失败，点击重试"}</ActionButton>}
        {!historyError && nextCursor && <ActionButton type="button" variant="text" className="button-text-inline-action product-history-more" aria-busy={historyLoading} disabled={historyLoading} onClick={() => void requestHistoryPage(nextCursor)}>{historyLoading ? "加载中…" : "加载更早记录"}</ActionButton>}
      </div>,
      document.body,
    )}
  </div>;
}

function getTabStops(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")]
    .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert]") && element.getClientRects().length > 0);
}

function formatDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
