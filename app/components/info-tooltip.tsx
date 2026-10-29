"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "@/app/components/use-anchored-popover";
import { useDismissiblePopover } from "@/app/components/use-dismissible-popover";

export function InfoTooltip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const position = useAnchoredPopover(open, setOpen, triggerRef, tooltipRef);
  useDismissiblePopover(open, setOpen, triggerRef, tooltipRef, { closeOnScroll: false });

  function cancelClose() {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }

  function show() {
    cancelClose();
    setOpen(true);
  }

  function scheduleClose() {
    cancelClose();
    // Leave time to move from the icon into its explanation.
    closeTimer.current = setTimeout(() => {
      if (document.activeElement !== triggerRef.current) setOpen(false);
    }, 150);
  }

  useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  return <>
    <button ref={triggerRef} type="button" className="icon-button info-tooltip-trigger" aria-label={label} aria-describedby={open ? id : undefined} onMouseEnter={show} onMouseLeave={scheduleClose} onFocus={show} onBlur={() => { cancelClose(); setOpen(false); }} onClick={show}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 9v5M10 6v.1" /></svg>
    </button>
    {open && createPortal(<div ref={tooltipRef} id={id} role="tooltip" className="surface-popover anchored-popover info-tooltip" style={{ top: position.top, left: position.left }} onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>{children}</div>, document.body)}
  </>;
}
