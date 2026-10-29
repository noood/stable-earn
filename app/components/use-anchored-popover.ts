"use client";

import { useLayoutEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

/** Keep portal panels anchored, inside the viewport, and hidden when their trigger is clipped. */
export function useAnchoredPopover<TTrigger extends HTMLElement, TPanel extends HTMLElement>(
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
  triggerRef: RefObject<TTrigger | null>,
  panelRef: RefObject<TPanel | null>,
  align: "start" | "end" = "start",
) {
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!open || !trigger || !panel) return;

    function updatePosition() {
      const anchor = trigger!.getBoundingClientRect();
      const bounds = panel!.getBoundingClientRect();
      const rootStyle = getComputedStyle(document.documentElement);
      const gutter = spacingPixels(rootStyle, "--space-3");
      const gap = spacingPixels(rootStyle, "--space-2");
      const preferredLeft = align === "end" ? anchor.right - bounds.width : anchor.left;
      const left = Math.max(gutter, Math.min(preferredLeft, window.innerWidth - bounds.width - gutter));
      const preferredTop = window.innerHeight - anchor.bottom >= bounds.height + gap || anchor.top < bounds.height + gap
        ? anchor.bottom + gap : anchor.top - bounds.height - gap;
      const top = Math.max(gutter, Math.min(preferredTop, window.innerHeight - bounds.height - gutter));
      setPosition((current) => current.top === top && current.left === left ? current : { top, left });
    }

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    const sizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    sizeObserver?.observe(panel);
    const visibilityObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      if (entry && (!entry.isIntersecting || entry.intersectionRect.width <= 0 || entry.intersectionRect.height <= 0)) setOpen(false);
    });
    visibilityObserver?.observe(trigger);

    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
      sizeObserver?.disconnect();
      visibilityObserver?.disconnect();
    };
  }, [align, open, panelRef, setOpen, triggerRef]);

  return position;
}

function spacingPixels(style: CSSStyleDeclaration, name: string) {
  const value = style.getPropertyValue(name).trim();
  return parseFloat(value) * (value.endsWith("rem") ? parseFloat(style.fontSize) : 1);
}
