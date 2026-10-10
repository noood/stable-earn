"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismissiblePopover } from "@/app/components/use-dismissible-popover";
import { ActionButton } from "@/app/components/ui";
import { formatShortDate } from "@/lib/product-overrides";

export function PurchaseDateInput({ value, durationDays, disabled, onChange }: { value: string | null; durationDays: number; disabled: boolean; onChange: (value: string | null) => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedDate = parseCalendarDate(value);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => firstCalendarMonth(selectedDate ?? todayCalendarDate()));
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const maturity = value ? new Date(`${value}T00:00:00Z`) : null;
  maturity?.setUTCDate(maturity.getUTCDate() + durationDays);
  useDismissiblePopover(open, setOpen, buttonRef, menuRef);

  function toggleCalendar() {
    if (disabled) return;
    if (!open) {
      setVisibleMonth(firstCalendarMonth(selectedDate ?? todayCalendarDate()));
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) {
        const width = 280;
        const height = 338;
        const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
        const top = window.innerHeight - rect.bottom >= height || rect.top < height
          ? rect.bottom + 6
          : rect.top - height - 6;
        setPosition({ top, left });
      }
    }
    setOpen((current) => !current);
  }

  const calendarDays = calendarMonthDays(visibleMonth);
  const selectedValue = selectedDate ? calendarDateValue(selectedDate) : null;
  const todayValue = calendarDateValue(todayCalendarDate());
  const visibleMonthIndex = visibleMonth.getUTCMonth();

  return <div className="manual-field"><span className="manual-field-label">买入日</span><button ref={buttonRef} type="button" className={`manual-date-trigger ${value ? "" : "manual-date-trigger-empty"}`} aria-label="买入日" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={toggleCalendar}><span>{selectedDate ? calendarDateLabel(selectedDate) : "选择日期"}</span><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12.5" rx="2" /><path d="M6.5 2.8v3.4M13.5 2.8v3.4M3 8h14" /></svg></button><span className="manual-field-note">{maturity && Number.isFinite(maturity.getTime()) ? `按 ${durationDays} 天自动计算：${formatShortDate(maturity.toISOString())} 到期` : `填写后按 ${durationDays} 天自动计算到期日`}</span>{open && createPortal(<div ref={menuRef} className="surface-popover calendar-popover" role="dialog" aria-label="选择买入日" style={{ top: position.top, left: position.left }}><div className="calendar-header"><button type="button" className="icon-button calendar-header-button" aria-label="上个月" disabled={disabled} onClick={() => setVisibleMonth((current) => shiftCalendarMonth(current, -1))}>‹</button><p>{visibleMonth.getUTCFullYear()} 年 {visibleMonthIndex + 1} 月</p><button type="button" className="icon-button calendar-header-button" aria-label="下个月" disabled={disabled} onClick={() => setVisibleMonth((current) => shiftCalendarMonth(current, 1))}>›</button></div><div className="calendar-weekdays" aria-hidden="true">{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-days" role="grid">{calendarDays.map((day) => { const dayValue = calendarDateValue(day); const outside = day.getUTCMonth() !== visibleMonthIndex; return <button key={dayValue} type="button" role="gridcell" aria-label={calendarDayAriaLabel(day)} aria-selected={dayValue === selectedValue} aria-current={dayValue === todayValue ? "date" : undefined} data-outside={outside ? "true" : undefined} disabled={disabled} onClick={() => { onChange(dayValue); setOpen(false); }}>{day.getUTCDate()}</button>; })}</div><div className="calendar-footer"><ActionButton type="button" variant="text" size="small" disabled={disabled || !value} onClick={() => { onChange(null); setOpen(false); }}>清除</ActionButton><ActionButton type="button" variant="text" size="small" disabled={disabled} onClick={() => { onChange(todayValue); setOpen(false); }}>今天</ActionButton></div></div>, document.body)}</div>;
}

export function parseCalendarDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

function todayCalendarDate() {
  const today = new Date();
  return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
}

function firstCalendarMonth(date: Date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)); }
function shiftCalendarMonth(date: Date, offset: number) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)); }
function calendarDateValue(date: Date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`; }
function calendarDateLabel(date: Date) { return `${date.getUTCFullYear()} / ${String(date.getUTCMonth() + 1).padStart(2, "0")} / ${String(date.getUTCDate()).padStart(2, "0")}`; }
function calendarDayAriaLabel(date: Date) { return `${date.getUTCFullYear()} 年 ${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日`; }
function calendarMonthDays(month: Date) {
  const firstWeekday = (month.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1 - firstWeekday));
  return Array.from({ length: 42 }, (_, index) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + index)));
}
