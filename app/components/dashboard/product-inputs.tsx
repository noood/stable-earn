"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismissiblePopover } from "@/app/components/use-dismissible-popover";
import type { Asset } from "@/lib/domain";

export function InlineSelect({ ariaLabel, value, options, disabled, className = "", onChange }: { ariaLabel: string; value: string; options: Array<{ value: string; label: string }>; disabled: boolean; className?: string; onChange: (value: string) => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 240 });
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;
  useDismissiblePopover(open, setOpen, buttonRef, menuRef);

  function toggleMenu() {
    if (disabled) return;
    if (!open) {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setPosition({ top: rect.bottom + 6, left: rect.left, maxHeight: Math.max(120, window.innerHeight - rect.bottom - 20) });
    }
    setOpen((current) => !current);
  }

  return <><button ref={buttonRef} type="button" className={`inline-select-trigger ${className}`} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={toggleMenu}><span>{selectedLabel}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>{open && createPortal(<div ref={menuRef} className="inline-select-menu" role="listbox" aria-label={ariaLabel} style={{ top: position.top, left: position.left, maxHeight: position.maxHeight }}>{options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} disabled={disabled} onClick={() => { onChange(option.value); setOpen(false); }}><span>{option.label}</span>{option.value === value && <span aria-hidden="true">✓</span>}</button>)}</div>, document.body)}</>;
}

export function ManualLimitInput({ value, placeholder, asset, disabled, onChange }: { value: number | null; placeholder?: number; asset: Asset; disabled: boolean; onChange: (value: number | null) => void }) {
  return <ManualNumberInput label="首档额度" value={value} placeholder={placeholder} suffix={asset} disabled={disabled} maxDecimals={8} onChange={(nextValue) => onChange(nextValue !== null && nextValue > 0 ? nextValue : null)} />;
}

export function ManualAprInput({ value, placeholder, note, disabled, onChange }: { value: number | null; placeholder?: number; note?: string; disabled: boolean; onChange: (value: number | null) => void }) {
  return <ManualNumberInput label="APR" value={value} placeholder={placeholder} suffix="%" note={note} disabled={disabled} maxDecimals={4} onChange={onChange} />;
}

export function ManualTermInput({ label = "期限", value, disabled, onChange }: { label?: string; value: number | null; disabled: boolean; onChange: (value: number | null) => void }) {
  return <ManualNumberInput label={label} value={value} placeholder="填写" suffix="天" disabled={disabled} maxDecimals={2} onChange={(termDays) => onChange(termDays !== null && termDays > 0 ? termDays : null)} />;
}

function ManualNumberInput({ label, value, placeholder, suffix, note, disabled, maxDecimals, onChange }: { label: string; value: number | null; placeholder?: number | string; suffix: string; note?: string; disabled: boolean; maxDecimals: number; onChange: (value: number | null) => void }) {
  const [displayValue, setDisplayValue] = useState(value === null ? "" : String(value));

  function updateValue(nextValue: string) {
    const normalized = nextValue.replace(",", ".");
    if (!new RegExp(`^\\d*(?:\\.\\d{0,${maxDecimals}})?$`).test(normalized)) return;
    setDisplayValue(normalized);
    onChange(normalized === "" ? null : Math.max(0, Number(normalized) || 0));
  }

  const placeholderText = typeof placeholder === "number" ? placeholder.toFixed(2) : placeholder ?? "0.00";
  return <label className="manual-field"><span className="manual-field-label">{label}</span><span className={`manual-field-control ${disabled ? "manual-field-control-disabled" : ""}`}><input type="text" inputMode="decimal" placeholder={placeholderText} value={displayValue} onFocus={(event) => event.currentTarget.select()} onChange={(event) => updateValue(event.target.value)} onBlur={() => setDisplayValue(value === null ? "" : String(value))} disabled={disabled} aria-label={label} /><span>{suffix}</span></span>{note && <span className="manual-field-note manual-field-note-control">{note}</span>}</label>;
}

export function HoldingInput({ value, asset, disabled, onChange }: { value: number; asset: Asset; disabled: boolean; onChange: (value: number) => void }) {
  const [displayValue, setDisplayValue] = useState(value > 0 ? String(value) : "");

  function updateValue(nextValue: string) {
    const normalized = nextValue.replace(",", ".");
    if (!/^\d*(?:\.\d{0,8})?$/.test(normalized)) return;
    setDisplayValue(normalized);
    onChange(Math.max(0, Number(normalized) || 0));
  }

  return <label className={`holding-editor holding-editor-editable ${disabled ? "holding-editor-disabled" : ""}`}><span className="text-muted type-micro pointer-events-none font-normal">{asset}</span><input type="text" inputMode="decimal" placeholder="0.00" value={displayValue} onFocus={(event) => event.currentTarget.select()} onChange={(event) => updateValue(event.target.value)} onBlur={() => setDisplayValue(value > 0 ? String(value) : "")} disabled={disabled} aria-label={`${asset} 产品持仓`} className="type-body min-w-0 flex-1 bg-transparent text-left font-semibold tabular-nums outline-none" /></label>;
}
