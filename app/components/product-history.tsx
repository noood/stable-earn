"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProductChangeEvent } from "@/lib/domain";
import { useDismissiblePopover } from "@/app/components/use-dismissible-popover";
import { ActionButton } from "@/app/components/ui";

export type ProductHistoryPage = { events: ProductChangeEvent[]; nextCursor: string | null };
const PRODUCT_HISTORY_OPEN_EVENT = "stable-earn:product-history-open";

export function ProductHistory({ productId, events, loadPage, onEventsRead, readOnlyPreview = false }: {
  productId: string;
  events: ProductChangeEvent[];
  loadPage?: (cursor: string | null) => Promise<ProductHistoryPage>;
  onEventsRead?: (readAt: string) => void;
  readOnlyPreview?: boolean;
}) {
  const instanceId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialHistoryRequestStartedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [acknowledgedEventIds, setAcknowledgedEventIds] = useState<string[]>([]);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [loadedHistoryEvents, setLoadedHistoryEvents] = useState<ProductChangeEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [initialHistoryLoadComplete, setInitialHistoryLoadComplete] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const historyEvents = loadedHistoryEvents ?? events;
  const attention = events.some((event) => event.attention && !event.readAt && !acknowledgedEventIds.includes(event.id))
    || historyEvents.some((event) => event.attention && !event.readAt && !acknowledgedEventIds.includes(event.id));
  const sortedEvents = useMemo(() => [...historyEvents].sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt)), [historyEvents]);

  useDismissiblePopover(open, setOpen, buttonRef, popoverRef, { closeOnScroll: false });

  useEffect(() => {
    if (!open) return;
    function closeWhenAnotherOpens(event: Event) {
      if ((event as CustomEvent<string>).detail === instanceId) return;
      cancelScheduledClose();
      cancelScheduledHoverOpen();
      setOpen(false);
    }
    window.addEventListener(PRODUCT_HISTORY_OPEN_EVENT, closeWhenAnotherOpens);
    return () => window.removeEventListener(PRODUCT_HISTORY_OPEN_EVENT, closeWhenAnotherOpens);
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
      setOpen(false);
    }, 180);
  }

  async function requestHistoryPage(cursor: string | null, replace: boolean) {
    if (!loadPage) return;
    const isFirstInitialLoad = replace && cursor === null && !initialHistoryLoadComplete;
    setHistoryLoading(true);
    try {
      const page = await loadPage(cursor);
      setLoadedHistoryEvents((current) => {
        if (replace) return page.events;
        const known = new Set((current ?? events).map((event) => event.id));
        return [...(current ?? events), ...page.events.filter((event) => !known.has(event.id))];
      });
      setNextCursor(page.nextCursor);
      setHistoryError(false);
    } catch {
      setHistoryError(true);
    } finally {
      setHistoryLoading(false);
      if (isFirstInitialLoad) setInitialHistoryLoadComplete(true);
    }
  }

  async function persistReadState() {
    const unreadIds = historyEvents.filter((event) => event.attention && !event.readAt).map((event) => event.id);
    if (!loadPage || readOnlyPreview) {
      setAcknowledgedEventIds((current) => [...new Set([...current, ...unreadIds])]);
      return;
    }
    try {
      const response = await fetch("/private/api/product-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      if (!response.ok) return;
      const result = await response.json() as { readAt?: unknown };
      if (typeof result.readAt !== "string") return;
      setAcknowledgedEventIds((current) => [...new Set([...current, ...unreadIds])]);
      setLoadedHistoryEvents((current) => (current ?? events).map((event) => event.attention && !event.readAt
        ? { ...event, readAt: result.readAt as string }
        : event));
      onEventsRead?.(result.readAt);
    } catch {
      // Leave the dot visible when persistence fails; a later open can retry.
    }
  }

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
    void persistReadState();
    if (loadPage && !initialHistoryRequestStartedRef.current) {
      initialHistoryRequestStartedRef.current = true;
      void requestHistoryPage(null, true);
    }
  }

  function scheduleHoverOpen() {
    cancelScheduledClose();
    cancelScheduledHoverOpen();
    if (open) return;
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

  return <div className="product-history">
    <button
      ref={buttonRef}
      type="button"
      className="product-history-trigger"
      aria-label={attention ? "查看变更记录，有需要关注的变化" : "查看变更记录"}
      aria-haspopup="dialog"
      aria-expanded={open}
      onMouseEnter={scheduleHoverOpen}
      onMouseLeave={scheduleClose}
      onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) openPopover(); }}
      onBlur={(event) => {
        if (!event.relatedTarget || !(event.relatedTarget instanceof Node && popoverRef.current?.contains(event.relatedTarget))) scheduleClose();
      }}
      onClick={handleTriggerClick}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.8" /><path d="M10 6.4v3.9l2.6 1.6" /><path d="M10 2.1v1.4M10 16.5v1.4M2.1 10h1.4M16.5 10h1.4" /></svg>
      {attention && <span className="product-history-dot" aria-hidden="true" />}
    </button>
    {open && createPortal(
      <div
        ref={popoverRef}
        className="product-history-popover surface-popover"
        role="dialog"
        aria-label="产品变更记录"
        style={{ top: position.top, left: position.left }}
        onMouseEnter={() => { cancelScheduledClose(); cancelScheduledHoverOpen(); }}
        onMouseLeave={scheduleClose}
      >
        <div className="product-history-header"><p className="product-history-title">变更记录</p></div>
        {sortedEvents.length === 0
          ? historyLoading && !initialHistoryLoadComplete
            ? <div className="product-history-loading" role="status" aria-label="正在加载变更记录">
              <span className="skeleton-block product-history-loading-line product-history-loading-line-primary" aria-hidden="true" />
              <span className="skeleton-block product-history-loading-line product-history-loading-line-secondary" aria-hidden="true" />
            </div>
            : historyError || (loadPage && !initialHistoryLoadComplete)
              ? null
              : <p className="product-history-empty">暂无变更记录</p>
          : <ol className="product-history-list">{sortedEvents.map((event, index) => <li key={event.id} className="product-history-event">
            <span className={`product-history-node ${index === 0 ? "product-history-node-latest" : ""}`} aria-hidden="true" />
            <div className="product-history-event-copy">
              <div className="product-history-event-meta"><time dateTime={event.observedAt}>{formatDateTime(event.observedAt)}</time><span>{event.source}</span></div>
              <p className="product-history-event-title"><span>{event.title}</span>{event.before !== undefined && event.after !== undefined && <span className="product-history-event-change"><span>{event.before}</span><span className="product-history-arrow" aria-hidden="true">→</span><strong>{event.after}</strong></span>}</p>
            </div>
          </li>)}</ol>}
        {historyError && <ActionButton type="button" variant="text" className={`button-text-inline-action product-history-more${historyLoading ? " product-history-loading-state" : " product-history-error"}`} aria-busy={historyLoading} disabled={historyLoading} onClick={() => void requestHistoryPage(nextCursor, nextCursor === null)}>{historyLoading ? "加载中…" : "加载失败，点击重试"}</ActionButton>}
        {!historyError && nextCursor && <ActionButton type="button" variant="text" className="button-text-inline-action product-history-more" aria-busy={historyLoading} disabled={historyLoading} onClick={() => void requestHistoryPage(nextCursor, false)}>{historyLoading ? "加载中…" : "加载更早记录"}</ActionButton>}
      </div>,
      document.body,
    )}
  </div>;
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
