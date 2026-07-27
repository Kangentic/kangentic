import { useEffect, useRef, useState } from 'react';
import { CalendarRange, X } from 'lucide-react';
import { OverlayPopover } from '../OverlayPopover';
import { Select } from '../settings/shared';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import type { UsageCustomWindow } from '../../../shared/types';

interface StatsCustomRangePickerProps {
  customWindow: UsageCustomWindow | null;
  onApply: (customWindow: UsageCustomWindow) => void;
  onClear: () => void;
}

/** How many months back the From/To dropdowns offer (rolling). */
const MONTH_OPTION_COUNT = 24;

interface MonthOption {
  /** `${year}-${monthIndex}` (local calendar). */
  value: string;
  label: string;
}

function monthLabel(monthStartMs: number): string {
  return new Date(monthStartMs).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function monthValue(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}`;
}

function parseMonthValue(value: string): { year: number; monthIndex: number } {
  const [year, monthIndex] = value.split('-').map((part) => parseInt(part, 10));
  return { year, monthIndex };
}

function buildMonthOptions(): MonthOption[] {
  const nowDate = new Date();
  const options: MonthOption[] = [];
  for (let monthsBack = 0; monthsBack < MONTH_OPTION_COUNT; monthsBack++) {
    const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth() - monthsBack, 1);
    options.push({ value: monthValue(monthStart), label: monthLabel(monthStart.getTime()) });
  }
  return options;
}

/** Human label for an applied window ("May 2026" or "May - Jul 2026"). */
export function customWindowLabel(customWindow: UsageCustomWindow): string {
  const untilDate = new Date(customWindow.untilMs);
  const lastMonthStartMs = new Date(untilDate.getFullYear(), untilDate.getMonth() - 1, 1).getTime();
  if (lastMonthStartMs <= customWindow.sinceMs) return monthLabel(customWindow.sinceMs);
  const fromDate = new Date(customWindow.sinceMs);
  const sameYear = fromDate.getFullYear() === new Date(lastMonthStartMs).getFullYear();
  const fromLabel = sameYear
    ? fromDate.toLocaleDateString(undefined, { month: 'short' })
    : monthLabel(customWindow.sinceMs);
  return `${fromLabel} - ${monthLabel(lastMonthStartMs)}`;
}

/**
 * The "Custom" month-window picker beside the quick period pills: From/To
 * month dropdowns (rolling 24 months) applying a bounded window that
 * overrides the quick period - single months, month spans, and (via the
 * automatic "vs preceding window" deltas) month-over-month comparison.
 * Applied state renders as a dismissible accent chip, like the drill chip.
 */
export function StatsCustomRangePicker({ customWindow, onApply, onClear }: StatsCustomRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [fromValue, setFromValue] = useState<string>(() => monthValue(new Date()));
  const [toValue, setToValue] = useState<string>(() => monthValue(new Date()));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Portal + fixed: in the popped-out Stats window this sits inside
  // PopOutWindowFrame's `overflow-hidden`, which clipped the in-flow popover.
  const { style: popoverStyle } = usePopoverPosition(triggerRef, popoverRef, open, {
    mode: 'dropdown',
    strategy: 'fixed',
  });
  const monthOptions = buildMonthOptions();

  const openPicker = () => {
    // Seed the dropdowns from the applied window so reopening edits in place.
    if (customWindow) {
      const untilDate = new Date(customWindow.untilMs);
      setFromValue(monthValue(new Date(customWindow.sinceMs)));
      setToValue(monthValue(new Date(untilDate.getFullYear(), untilDate.getMonth() - 1, 1)));
    }
    setOpen(true);
  };

  // Close on click outside (capture so it wins over other handlers).
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current && !popoverRef.current.contains(event.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [open]);

  // Close on Escape - capture phase with stopPropagation so the page's own
  // bubble-phase Escape (which closes the whole dashboard) does not fire.
  useEffect(() => {
    if (!open) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [open]);

  const apply = () => {
    const from = parseMonthValue(fromValue);
    const to = parseMonthValue(toValue);
    // Order-agnostic: picking "Jul to May" means May through July.
    const fromStartMs = new Date(from.year, from.monthIndex, 1).getTime();
    const toStartMs = new Date(to.year, to.monthIndex, 1).getTime();
    const [firstYearMonth, lastYearMonth] = fromStartMs <= toStartMs ? [from, to] : [to, from];
    onApply({
      sinceMs: new Date(firstYearMonth.year, firstYearMonth.monthIndex, 1).getTime(),
      untilMs: new Date(lastYearMonth.year, lastYearMonth.monthIndex + 1, 1).getTime(),
    });
    setOpen(false);
  };

  return (
    <div className="relative">
      {customWindow ? (
        <span className="flex items-center rounded-full border border-accent/60 bg-accent/10 text-xs text-fg">
          <button
            ref={triggerRef}
            type="button"
            onClick={openPicker}
            className="flex items-center gap-1.5 pl-2.5 py-1 cursor-pointer hover:text-fg transition-colors"
            title="Edit the custom range"
            data-testid="stats-custom-trigger"
          >
            <CalendarRange size={14} className="text-fg-muted" />
            {customWindowLabel(customWindow)}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="pl-1.5 pr-2 py-1 cursor-pointer text-fg-muted hover:text-fg transition-colors"
            title="Back to the quick ranges"
            aria-label="Clear custom range"
            data-testid="stats-custom-clear"
          >
            <X size={14} />
          </button>
        </span>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={openPicker}
          className="flex items-center gap-1.5 rounded-full border border-edge px-2.5 py-1 text-xs text-fg-secondary cursor-pointer hover:text-fg hover:bg-surface-hover/40 transition-colors"
          title="Pick a custom month range"
          data-testid="stats-custom-trigger"
        >
          <CalendarRange size={14} />
          Custom
        </button>
      )}
      <OverlayPopover
        open={open}
        popoverRef={popoverRef}
        style={popoverStyle}
        portal
        className="fixed z-[2147483646] bg-surface-raised border border-edge rounded-lg shadow-xl p-3 min-w-[220px]"
      >
        <div className="flex flex-col gap-2">
          <label className="flex items-center justify-between gap-3 text-xs text-fg-secondary">
            From
            <Select
              value={fromValue}
              onChange={(event) => setFromValue(event.target.value)}
              wrapperClassName="relative w-32"
              chevronSize={14}
              data-testid="stats-custom-from"
            >
              {monthOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
          </label>
          <label className="flex items-center justify-between gap-3 text-xs text-fg-secondary">
            To
            <Select
              value={toValue}
              onChange={(event) => setToValue(event.target.value)}
              wrapperClassName="relative w-32"
              chevronSize={14}
              data-testid="stats-custom-to"
            >
              {monthOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
          </label>
          <button
            type="button"
            onClick={apply}
            className="mt-1 rounded-md bg-accent/15 border border-accent/40 px-2.5 py-1 text-xs font-medium text-fg cursor-pointer hover:bg-accent/25 transition-colors"
            data-testid="stats-custom-apply"
          >
            Apply
          </button>
        </div>
      </OverlayPopover>
    </div>
  );
}
