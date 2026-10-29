"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { InfoTooltip } from "@/app/components/info-tooltip";
import { useDismissiblePopover } from "@/app/components/use-dismissible-popover";
import type { Asset } from "@/lib/domain";

export function InlineSelect({ ariaLabel, value, options, disabled, className = "", emptyValueLabel, onChange }: { ariaLabel: string; value: string; options: Array<{ value: string; label: string }>; disabled: boolean; className?: string; emptyValueLabel?: string; onChange: (value: string) => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 240 });
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedLabel = options[selectedIndex]?.label ?? (value === "" ? emptyValueLabel ?? "" : value);
  const activeOption = options[activeIndex];
  useDismissiblePopover(open, setOpen, buttonRef, menuRef);

  function openMenu() {
    if (disabled || options.length === 0) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 6, left: rect.left, maxHeight: Math.max(120, window.innerHeight - rect.bottom - 20) });
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function selectOption(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }

    if (event.key === "Tab") {
      setOpen(false);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + options.length) % options.length);
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : Math.max(0, options.length - 1));
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectOption(activeIndex);
    }
  }

  return <><button ref={buttonRef} type="button" role="combobox" className={`inline-select-trigger ${className}`} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-activedescendant={open && activeOption ? `${menuId}-option-${activeIndex}` : undefined} disabled={disabled} onClick={() => open ? setOpen(false) : openMenu()} onKeyDown={handleKeyDown}><span>{selectedLabel}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>{open && createPortal(<div ref={menuRef} id={menuId} className="inline-select-menu" role="listbox" aria-label={ariaLabel} style={{ top: position.top, left: position.left, maxHeight: position.maxHeight }} onKeyDown={handleKeyDown}>{options.map((option, index) => <div key={option.value} id={`${menuId}-option-${index}`} role="option" aria-selected={option.value === value} data-active={index === activeIndex} onMouseMove={() => setActiveIndex(index)} onClick={() => selectOption(index)}><span>{option.label}</span>{option.value === value && <span aria-hidden="true">✓</span>}</div>)}</div>, document.body)}</>;
}

export function ManualLimitInput({ value, placeholder, asset, disabled, onChange }: { value: number | null; placeholder?: number; asset: Asset; disabled: boolean; onChange: (value: number | null) => void }) {
  return <ManualNumberInput label="首档额度" value={value} placeholder={placeholder} suffix={asset} disabled={disabled} maxDecimals={8} onChange={(nextValue) => onChange(nextValue !== null && nextValue > 0 ? nextValue : null)} />;
}

export function ManualAprInput({ value, placeholder, note, explanation, disabled, onChange }: { value: number | null; placeholder?: number; note?: string; explanation?: ReactNode; disabled: boolean; onChange: (value: number | null) => void }) {
  return <ManualNumberInput label="APR" value={value} placeholder={placeholder} suffix="%" note={note} explanation={explanation} disabled={disabled} maxDecimals={4} onChange={onChange} />;
}

export function ManualTermInput({ label = "期限", value, disabled, onChange }: { label?: string; value: number | null; disabled: boolean; onChange: (value: number | null) => void }) {
  return <ManualNumberInput label={label} value={value} placeholder="填写" suffix="天" disabled={disabled} maxDecimals={2} onChange={(termDays) => onChange(termDays !== null && termDays > 0 ? termDays : null)} />;
}

function ManualNumberInput({ label, value, placeholder, suffix, note, explanation, disabled, maxDecimals, onChange }: { label: string; value: number | null; placeholder?: number | string; suffix: string; note?: string; explanation?: ReactNode; disabled: boolean; maxDecimals: number; onChange: (value: number | null) => void }) {
  const inputId = useId();
  const [displayValue, setDisplayValue] = useState(value === null ? "" : String(value));

  function updateValue(nextValue: string) {
    const normalized = nextValue.replace(",", ".");
    if (!new RegExp(`^\\d*(?:\\.\\d{0,${maxDecimals}})?$`).test(normalized)) return;
    setDisplayValue(normalized);
    onChange(normalized === "" ? null : Math.max(0, Number(normalized) || 0));
  }

  const placeholderText = typeof placeholder === "number" ? placeholder.toFixed(2) : placeholder ?? "0.00";
  return <div className="manual-field"><span className="manual-field-label"><label htmlFor={inputId}>{label}</label>{explanation && <InfoTooltip label={`${label}说明`}>{explanation}</InfoTooltip>}</span><span className={`manual-field-control ${disabled ? "manual-field-control-disabled" : ""}`}><input id={inputId} type="text" inputMode="decimal" placeholder={placeholderText} value={displayValue} onFocus={(event) => event.currentTarget.select()} onChange={(event) => updateValue(event.target.value)} onBlur={() => setDisplayValue(value === null ? "" : String(value))} disabled={disabled} aria-label={label} /><span>{suffix}</span></span>{note && <span className="manual-field-note manual-field-note-control">{note}</span>}</div>;
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
