"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon } from "@/app/components/ui";
import { InfoTooltip } from "@/app/components/info-tooltip";
import { useDismissiblePopover } from "@/app/components/use-dismissible-popover";
import { useAnchoredPopover } from "@/app/components/use-anchored-popover";
import type { Asset } from "@/lib/domain";

export function InlineSelect({ ariaLabel, value, options, disabled, className = "", emptyValueLabel, iconOnly = false, onChange }: { ariaLabel: string; value: string; options: Array<{ value: string; label: string }>; disabled: boolean; className?: string; emptyValueLabel?: string; iconOnly?: boolean; onChange: (value: string) => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const position = useAnchoredPopover(open, setOpen, buttonRef, menuRef, iconOnly ? "end" : "start");
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedLabel = options[selectedIndex]?.label ?? (value === "" ? emptyValueLabel ?? "" : value);
  const activeOption = options[activeIndex];
  useDismissiblePopover(open, setOpen, buttonRef, menuRef, { closeOnScroll: false });

  function openMenu() {
    if (disabled || options.length === 0) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function selectOption(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
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

  return <><button ref={buttonRef} type="button" role="combobox" className={`inline-select-trigger${iconOnly ? " inline-select-trigger-icon" : ""} ${className}`} aria-label={ariaLabel} aria-describedby={iconOnly ? `${menuId}-value` : undefined} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-activedescendant={open && activeOption ? `${menuId}-option-${activeIndex}` : undefined} disabled={disabled} onClick={() => open ? setOpen(false) : openMenu()} onKeyDown={handleKeyDown}>{!iconOnly && <span>{selectedLabel}</span>}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>{iconOnly && <span id={`${menuId}-value`} className="sr-only">{selectedLabel}</span>}{open && createPortal(<div ref={menuRef} id={menuId} className="inline-select-menu surface-popover" role="listbox" aria-label={ariaLabel} style={position} onKeyDown={handleKeyDown}>{options.map((option, index) => <div key={option.value} id={`${menuId}-option-${index}`} role="option" aria-selected={option.value === value} data-active={index === activeIndex} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActiveIndex(index)} onClick={() => selectOption(index)}><span>{option.label}</span><span className="inline-select-check" aria-hidden="true">{option.value === value && <CheckIcon />}</span></div>)}</div>, document.body)}</>;
}

const limitModeOptions = [{ value: "limited", label: "限额" }, { value: "unlimited", label: "不限额" }];

export function ManualLimitInput({ value, unlimited, placeholder, asset, disabled, onChange }: { value: number | null; unlimited: boolean; placeholder?: number; asset: Asset; disabled: boolean; onChange: (value: number | null, unlimited: boolean) => void }) {
  const modeControl = <InlineSelect ariaLabel="首档额度类型" value={unlimited ? "unlimited" : "limited"} options={limitModeOptions} iconOnly disabled={disabled} onChange={(mode) => {
    if ((mode === "unlimited") !== unlimited) onChange(null, mode === "unlimited");
  }} />;
  return <ManualNumberInput label="首档额度" value={value} readOnlyValue={unlimited ? "不限额" : undefined} placeholder={placeholder} suffix={unlimited ? "" : asset} trailingControl={modeControl} disabled={disabled} maxDecimals={8} onChange={(nextValue) => onChange(nextValue !== null && nextValue > 0 ? nextValue : null, false)} />;
}

export function ManualAprInput({ value, placeholder, note, explanation, disabled, onChange }: { value: number | null; placeholder?: number; note?: string; explanation?: ReactNode; disabled: boolean; onChange: (value: number | null) => void }) {
  return <ManualNumberInput label="APR" value={value} placeholder={placeholder} suffix="%" note={note} explanation={explanation} disabled={disabled} maxDecimals={4} onChange={onChange} />;
}

export function ManualTermInput({ label = "期限", value, disabled, onChange }: { label?: string; value: number | null; disabled: boolean; onChange: (value: number | null) => void }) {
  return <ManualNumberInput label={label} value={value} placeholder="填写" suffix="天" disabled={disabled} maxDecimals={2} onChange={(termDays) => onChange(termDays !== null && termDays > 0 ? termDays : null)} />;
}

function ManualNumberInput({ label, value, readOnlyValue, placeholder, suffix, note, explanation, trailingControl, disabled, maxDecimals, onChange }: { label: string; value: number | null; readOnlyValue?: string; placeholder?: number | string; suffix: string; note?: string; explanation?: ReactNode; trailingControl?: ReactNode; disabled: boolean; maxDecimals: number; onChange: (value: number | null) => void }) {
  const inputId = useId();
  const [displayValue, setDisplayValue] = useState(value === null ? "" : String(value));
  const [previousReadOnlyValue, setPreviousReadOnlyValue] = useState(readOnlyValue);
  if (previousReadOnlyValue !== readOnlyValue) {
    setPreviousReadOnlyValue(readOnlyValue);
    setDisplayValue(value === null ? "" : String(value));
  }

  function updateValue(nextValue: string) {
    const normalized = nextValue.replace(",", ".");
    if (!new RegExp(`^\\d*(?:\\.\\d{0,${maxDecimals}})?$`).test(normalized)) return;
    const nextNumber = normalized === "" ? null : Math.max(0, Number(normalized) || 0);
    setDisplayValue(normalized);
    onChange(nextNumber);
  }

  const placeholderText = typeof placeholder === "number" ? placeholder.toFixed(2) : placeholder ?? "0.00";
  return <div className="manual-field"><span className="manual-field-label"><label htmlFor={inputId}>{label}</label>{explanation && <InfoTooltip label={`${label}说明`}>{explanation}</InfoTooltip>}</span><span className={`manual-field-control ${disabled ? "manual-field-control-disabled" : ""}`}><input id={inputId} type="text" inputMode={readOnlyValue === undefined ? "decimal" : undefined} placeholder={placeholderText} value={readOnlyValue ?? displayValue} readOnly={readOnlyValue !== undefined} onFocus={(event) => event.currentTarget.select()} onChange={(event) => updateValue(event.target.value)} onBlur={() => setDisplayValue(value === null ? "" : String(value))} disabled={disabled} aria-label={label} />{suffix && <span>{suffix}</span>}{trailingControl}</span>{note && <span className="manual-field-note manual-field-note-control">{note}</span>}</div>;
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
