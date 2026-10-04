"use client";

import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Account } from "@/lib/domain";

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "text";
  size?: "default" | "small";
};

export function ActionButton({ variant = "primary", size = "default", className = "", ...props }: ActionButtonProps) {
  return <button {...props} className={`button button-${variant} ${size === "small" ? "button-small" : ""} ${className}`} />;
}

export function AccountBadge({ account }: { account: Account }) {
  return <span className="account-badge" title={account.name} style={{ backgroundColor: account.color, color: account.foreground }}>{account.mark}</span>;
}

export function Metric({ label, value, note, highlight = false, valueTone = "default" }: { label: string; value: string; note: string; highlight?: boolean; valueTone?: "default" | "danger" }) {
  return <div className={`metric-item ${highlight ? "metric-item-highlight" : ""}`}><p className="text-muted type-caption">{label}</p><p className={`metric-value type-metric ${valueTone === "danger" ? "text-danger" : ""}`}>{value}</p><p className="metric-note text-muted type-micro">{note}</p></div>;
}

export function MetricSkeleton({ highlight = false }: { highlight?: boolean }) {
  return <div className={`metric-item ${highlight ? "metric-item-highlight" : ""}`} aria-hidden="true"><span className="skeleton-block skeleton-label" /><span className="skeleton-block skeleton-value" /><span className="skeleton-block skeleton-note" /></div>;
}

export function TableCell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`product-cell ${className}`}>{children}</td>;
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const normalizedValue = Math.max(0, Math.min(100, value));
  return <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(normalizedValue)}><div className="progress-fill" style={{ width: `${normalizedValue}%` }} /></div>;
}

export function HoldingSummary({ label, value, note, cacheNote, progress, progressLabel, noteTone = "default", muted = false, compact = false }: { label?: ReactNode; value?: ReactNode; note?: ReactNode; cacheNote?: ReactNode; progress?: number; progressLabel?: string; noteTone?: "default" | "danger"; muted?: boolean; compact?: boolean }) {
  return (
    <div className={`holding-summary ${muted ? "holding-summary-muted" : ""} ${compact ? "holding-summary-compact" : ""}`}>
      {(label !== undefined || value !== undefined) && <div className="holding-summary-head">
        <span className="tabular-nums">{label}</span>
        {value !== undefined && <span className="whitespace-nowrap tabular-nums">{value}</span>}
      </div>}
      {progress !== undefined && <ProgressBar value={progress} label={progressLabel ?? "首档额度使用进度"} />}
      {cacheNote !== undefined && <p className="holding-summary-note holding-summary-note-danger">{cacheNote}</p>}
      {note !== undefined && <p className={`holding-summary-note ${noteTone === "danger" ? "holding-summary-note-danger" : ""}`}>{note}</p>}
    </div>
  );
}

export function SectionIntro({ title, description }: { title: string; description?: string }) {
  return <div className="mb-3"><h3 className="type-label font-semibold">{title}</h3>{description && <p className="text-muted type-caption mt-1">{description}</p>}</div>;
}

export function ModalFrame({ ariaLabel, title, description, onClose, busy = false, bodyClassName = "", children }: { ariaLabel: string; title: string; description?: string; onClose: () => void; busy?: boolean; bodyClassName?: string; children: ReactNode }) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!panel) return;
    const getFocusable = () => [...panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
    (getFocusable()[0] ?? panel).focus();

    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const dialog = panelRef.current;
    if (!dialog) return;
    const getFocusable = () => [...dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
    function handleKeyDown(event: KeyboardEvent) {
      if (!dialog) return;
      if (event.key === "Escape") {
        if (!busy) {
          event.preventDefault();
          onClose();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [busy, onClose]);

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.currentTarget === event.target) onClose(); }}><section ref={panelRef} role="dialog" aria-modal="true" aria-label={ariaLabel} className="modal-panel" tabIndex={-1}><div className="modal-header"><div><h2 className="type-label font-semibold tracking-[-.015em]">{title}</h2>{description && <p className="text-muted type-caption mt-1">{description}</p>}</div><button type="button" className="icon-button modal-close" onClick={onClose} disabled={busy} aria-label="关闭"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4l12 12M16 4L4 16" /></svg></button></div><div className={`modal-body ${bodyClassName}`}>{children}</div></section></div>;
}
