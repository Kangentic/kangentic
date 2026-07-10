import { CircleDollarSign, Hash } from 'lucide-react';
import type { UsageMetricMode } from '../../stores/usage-dashboard-store';

interface StatsMetricToggleProps {
  metric: UsageMetricMode;
  onChange: (metric: UsageMetricMode) => void;
}

const METRIC_TOGGLE_OPTIONS: ReadonlyArray<{ value: UsageMetricMode; label: string; Icon: typeof CircleDollarSign }> = [
  { value: 'cost', label: 'Cost', Icon: CircleDollarSign },
  { value: 'tokens', label: 'Tokens', Icon: Hash },
];

/**
 * The dashboard's PRIMARY lens: every chart re-keys between dollars and
 * tokens. It lives in the title row beside the scope picker (the two "what am
 * I looking at" controls) as a prominent accent segmented toggle, not among
 * the quieter time filters on the row below.
 */
export function StatsMetricToggle({ metric, onChange }: StatsMetricToggleProps) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-full border border-edge bg-surface/60 p-0.5"
      role="group"
      aria-label="Chart metric"
      data-testid="stats-metric-group"
    >
      {METRIC_TOGGLE_OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold cursor-pointer transition-colors ${
            metric === value
              ? 'bg-accent/20 text-fg shadow-sm'
              : 'text-fg-muted hover:text-fg hover:bg-surface-hover/40'
          }`}
          aria-pressed={metric === value}
        >
          <Icon size={14} className={metric === value ? 'text-accent' : ''} aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
