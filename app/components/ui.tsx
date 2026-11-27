"use client";

import { useEffect, useRef, type ButtonHTMLAttributes, type ComponentPropsWithoutRef, type ReactNode } from "react";
import type { Account } from "@/lib/domain";
import { InfoTooltip } from "./info-tooltip";

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "text";
  size?: "default" | "small";
};

export function ActionButton({ variant = "primary", size = "default", className = "", ...props }: ActionButtonProps) {
  return <button {...props} className={`button button-${variant} ${size === "small" ? "button-small" : ""} ${className}`} />;
}

export function CheckIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 14 14" aria-hidden="true" focusable="false"><path d="m2.5 7.25 2.8 2.8 6.2-6.1" /></svg>;
}

export function AccountBadge({ account }: { account: Account }) {
  // Small local brand assets need no image optimizer; the adjacent text names the account.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="account-badge" src={account.logo} alt="" aria-hidden="true" title={account.name} width={44} height={44} decoding="async" />;
}

export function MetricsPanel(props: Pick<ComponentPropsWithoutRef<"section">, "children" | "aria-busy" | "aria-label">) {
  return <section className="metrics-panel card mb-4 overflow-hidden" {...props} />;
}

function MetricLabel({ label, description }: { label: string; description?: string }) {
  return <p className="text-muted type-caption">{description ? <InfoTooltip trigger="text" label={label}>{description}</InfoTooltip> : label}</p>;
}

export function Metric({ label, description, value, note, highlight = false, valueTone = "default" }: { label: string; description?: string; value: string; note?: string; highlight?: boolean; valueTone?: "default" | "danger" }) {
  return <div className={`metric-item ${highlight ? "metric-item-highlight" : ""}`}>
    <MetricLabel label={label} description={description} />
    <p className={`metric-value type-metric ${valueTone === "danger" ? "text-danger" : ""}`}>{value}</p>
    {note && <p className="metric-note text-muted type-micro">{note}</p>}
  </div>;
}

export function MetricSkeleton({ highlight = false, label, description }: { highlight?: boolean; label?: string; description?: string }) {
  return <div className={`metric-item ${highlight ? "metric-item-highlight" : ""}`}>
    {label ? <MetricLabel label={label} description={description} /> : <span className="skeleton-block skeleton-label" aria-hidden="true" />}
    <span className="skeleton-block skeleton-value" aria-hidden="true" />
  </div>;
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

export function FeedbackPanel({ children, tone = "neutral", role = tone === "danger" ? "alert" : "status", className = "" }: {
  children: ReactNode;
  tone?: "neutral" | "danger";
  role?: "alert" | "status";
  className?: string;
}) {
  return <div className={`feedback-panel ${tone === "danger" ? "error-panel" : "muted-panel"} type-caption ${className}`} role={role}>{children}</div>;
}

function modalFocusableElements(panel: HTMLElement) {
  const controls = panel.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]");
  return Array.from(controls).filter((element) => {
    if (element.tabIndex < 0 || element.matches(":disabled") || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const closedMenu = element.closest("details:not([open])");
    if (closedMenu && !closedMenu.querySelector(":scope > summary")?.contains(element)) return false;
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
  });
}

export function ModalFrame({ ariaLabel, title, description, onClose, busy = false, bodyClassName = "", animateEntrance = false, children }: {
  ariaLabel: string;
  title: string;
  description?: string;
  onClose: () => void;
  busy?: boolean;
  bodyClassName?: string;
  animateEntrance?: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel) (modalFocusableElements(panel)[0] ?? panel).focus();
  }, [ariaLabel]);

  useEffect(() => {
    const dialog = panelRef.current;
    if (!dialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        if (!busy) {
          event.preventDefault();
          onClose();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = modalFocusableElements(dialog);
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
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [busy, onClose]);

  return (
    <div
      className={`modal-backdrop${animateEntrance ? " modal-backdrop-enter" : ""}`}
      role="presentation"
      onMouseDown={(event) => { if (!busy && event.currentTarget === event.target) onClose(); }}
    >
      <section ref={panelRef} role="dialog" aria-modal="true" aria-label={ariaLabel} className="modal-panel" tabIndex={-1}>
        <div className="modal-header">
          <div>
            <h2 className="type-label font-semibold tracking-[-.015em]">{title}</h2>
            {description && <p className="text-muted type-caption mt-1">{description}</p>}
          </div>
          <button type="button" className="icon-button modal-close" onClick={onClose} disabled={busy} aria-label="关闭">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4l12 12M16 4L4 16" /></svg>
          </button>
        </div>
        <div className={`modal-body ${bodyClassName}`}>{children}</div>
      </section>
    </div>
  );
}
