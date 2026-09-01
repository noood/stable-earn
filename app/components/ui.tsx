"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Account } from "@/lib/domain";

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "text";
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

export function TableCell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`product-cell ${className}`}>{children}</td>;
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const normalizedValue = Math.max(0, Math.min(100, value));
  return <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(normalizedValue)}><div className="progress-fill" style={{ width: `${normalizedValue}%` }} /></div>;
}

export function HoldingSummary({ label, value, note, cacheNote, progress, progressLabel, noteTone = "default", muted = false }: { label: ReactNode; value?: ReactNode; note?: ReactNode; cacheNote?: ReactNode; progress?: number; progressLabel?: string; noteTone?: "default" | "warning"; muted?: boolean }) {
  return (
    <div className={`holding-summary ${muted ? "holding-summary-muted" : ""}`}>
      <div className="holding-summary-head">
        <span className="tabular-nums">{label}</span>
        {value !== undefined && <span className="whitespace-nowrap tabular-nums">{value}</span>}
      </div>
      {progress !== undefined && <ProgressBar value={progress} label={progressLabel ?? "首档额度使用进度"} />}
      {cacheNote !== undefined && <p className="holding-summary-note holding-summary-note-warning">{cacheNote}</p>}
      {note !== undefined && <p className={`holding-summary-note ${noteTone === "warning" ? "holding-summary-note-warning" : ""}`}>{note}</p>}
    </div>
  );
}

export function SectionIntro({ title, description }: { title: string; description: string }) {
  return <div className="mb-3"><h3 className="type-label font-semibold">{title}</h3><p className="text-muted type-caption mt-1">{description}</p></div>;
}

export function ModalFrame({ ariaLabel, title, description, onClose, busy = false, bodyClassName = "", children }: { ariaLabel: string; title: string; description?: string; onClose: () => void; busy?: boolean; bodyClassName?: string; children: ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.currentTarget === event.target) onClose(); }}><section role="dialog" aria-modal="true" aria-label={ariaLabel} className="modal-panel"><div className="modal-header"><div><h2 className="type-label font-semibold tracking-[-.015em]">{title}</h2>{description && <p className="text-muted type-caption mt-1">{description}</p>}</div><button type="button" className="icon-button modal-close" onClick={onClose} disabled={busy} aria-label="关闭"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg></button></div><div className={`modal-body ${bodyClassName}`}>{children}</div></section></div>;
}
