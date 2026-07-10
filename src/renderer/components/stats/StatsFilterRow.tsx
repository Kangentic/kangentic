import { X } from 'lucide-react';
import { ButtonGroup } from '../ButtonGroup';
import type { UsageCustomWindow, UsageTimePeriod } from '../../../shared/types';
import { StatsCustomRangePicker } from './StatsCustomRangePicker';
import { PERIOD_OPTIONS } from './period-options';

interface StatsFilterRowProps {
  period: UsageTimePeriod;
  onPeriodChange: (period: UsageTimePeriod) => void;
  /** Active custom month window; renders as the picker's applied chip and
   *  blanks the quick-period active state (the window overrides it). */
  customWindow: UsageCustomWindow | null;
  onCustomWindowApply: (customWindow: UsageCustomWindow) => void;
  onCustomWindowClear: () => void;
  /** Active single-day drill (chart click); renders the back chip. */
  drillLabel: string | null;
  onDrillClear: () => void;
}

/**
 * The TIME row above the charts: quick range pills, the custom month-window
 * picker, then the drill-day chip when a chart day has been clicked into.
 * The "what am I looking at" controls (project scope, the cost/tokens metric
 * toggle) live in the page HEADER above. Every card below re-renders against
 * the same slice.
 */
export function StatsFilterRow({
  period,
  onPeriodChange,
  customWindow,
  onCustomWindowApply,
  onCustomWindowClear,
  drillLabel,
  onDrillClear,
}: StatsFilterRowProps) {
  return (
    <div className="flex items-center gap-3 flex-wrap" data-testid="stats-filter-row">
      <div data-testid="stats-period-group">
        <ButtonGroup<UsageTimePeriod | 'custom'>
          options={[...PERIOD_OPTIONS]}
          // No quick pill reads active while a custom window overrides them.
          value={customWindow ? 'custom' : period}
          onChange={(value) => {
            if (value !== 'custom') onPeriodChange(value);
          }}
          size="sm"
        />
      </div>
      <StatsCustomRangePicker
        customWindow={customWindow}
        onApply={onCustomWindowApply}
        onClear={onCustomWindowClear}
      />
      {drillLabel && (
        <button
          type="button"
          onClick={onDrillClear}
          className="flex items-center gap-1.5 rounded-full border border-accent/60 bg-accent/10 px-2.5 py-1 text-xs text-fg cursor-pointer hover:bg-accent/20 transition-colors"
          title="Back to the full range"
          data-testid="stats-drill-chip"
        >
          {drillLabel}
          <X size={14} className="text-fg-muted" />
        </button>
      )}
    </div>
  );
}
