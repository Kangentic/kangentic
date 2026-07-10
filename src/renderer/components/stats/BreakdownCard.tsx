import { useMemo, useState } from 'react';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatCost } from '../../utils/format-session';
import type { UsageMetricMode } from '../../stores/usage-dashboard-store';
import { ChartCard } from './ChartCard';
import { KngDonut } from './charts/KngDonut';
import type { DonutSlice } from './useStatsData';

interface BreakdownCardProps {
  title: string;
  slices: DonutSlice[];
  costKnown: boolean;
  loading: boolean;
  testId: string;
  /** The dashboard's Cost/Tokens toggle: sizes the donut arcs, center total,
   *  share bars, and tooltips. The value list always shows BOTH numbers. */
  metric: UsageMetricMode;
  /** Suspend donut animations (e.g. during an active window resize). */
  animate?: boolean;
}

/**
 * Donut + value list (the mockup's "by model" form). The list IS the
 * accessibility relief for the donut: every slice always renders with its
 * swatch, name, share bar, tokens, and cost, so identity and values are never
 * color-alone (this is what permits the sub-3:1 categorical slots the
 * palette validator WARNs about on some themes). The proportional share bar
 * doubles as the row's middle fill, so relative share reads at a glance
 * without matching donut colors.
 *
 * Slice identity (rank order and colors) is fixed by the token fold so an
 * entity keeps its color when the metric toggles; only the PROPORTIONS
 * (arcs, bars, center total) re-key to the selected metric.
 */
export function BreakdownCard({ title, slices, costKnown, loading, testId, metric, animate = true }: BreakdownCardProps) {
  const byCost = metric === 'cost' && costKnown;
  const sliceMetricValue = (slice: DonutSlice) => (byCost ? slice.costUsd : slice.value);
  const metricFormatter = byCost ? formatCost : formatTokenCount;
  // Hover linkage between the donut and the list: hovering either highlights
  // both (the list row IS the donut's "tooltip", outside the chart).
  const [hoveredSliceId, setHoveredSliceId] = useState<string | null>(null);

  // Stable per (payload slices, metric): keeps the memo'd KngDonut from
  // re-rendering (and re-running its animation matcher) on unrelated
  // StatsPage renders such as live-usage ticks or poll refreshes.
  const { donutSlices, metricTotal, leader } = useMemo(() => {
    const mapped = slices.map((slice) => ({ ...slice, value: byCost ? slice.costUsd : slice.value }));
    return {
      donutSlices: mapped,
      metricTotal: mapped.reduce((sum, slice) => sum + slice.value, 0),
      // The dimension's dominant entry BY THE SELECTED METRIC (the cost
      // leader can differ from the token leader).
      leader: mapped.reduce<(typeof mapped)[number] | null>(
        (best, slice) => (best === null || slice.value > best.value ? slice : best),
        null,
      ),
    };
  }, [slices, byCost]);

  return (
    <ChartCard
      title={title}
      loading={loading}
      empty={!loading && slices.length === 0}
      bodyClassName="h-44"
      testId={testId}
    >
      <div className="h-full flex items-center gap-4">
        <div className="h-full aspect-square flex-shrink-0">
          {/* Center = this dimension's leader + share, the takeaway unique to
              each card (the grand total already headlines the hero tiles). */}
          <KngDonut
            slices={donutSlices}
            centerValue={leader && metricTotal > 0 ? `${Math.round((leader.value / metricTotal) * 100)}%` : '-'}
            centerLabel={leader?.label ?? ''}
            valueFormatter={metricFormatter}
            valueLabel={byCost ? 'cost' : 'tokens'}
            ariaLabel={`${title}: ${slices.map((slice) => `${slice.label} ${metricFormatter(sliceMetricValue(slice))}`).join(', ')}`}
            highlightedSliceId={hoveredSliceId}
            onSliceHover={setHoveredSliceId}
            animate={animate}
          />
        </div>
        <ul className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden max-h-full space-y-1.5" data-testid={`${testId}-list`}>
          {slices.map((slice) => (
            <li
              key={slice.id}
              className={`flex items-center gap-2 text-xs rounded transition-colors ${hoveredSliceId === slice.id ? 'bg-surface-hover/40' : ''}`}
              data-testid={`${testId}-row`}
              title={metricTotal > 0
                ? `${slice.label} - ${Math.round((sliceMetricValue(slice) / metricTotal) * 100)}% of ${byCost ? 'cost' : 'tokens'}`
                : slice.label}
              onMouseEnter={() => setHoveredSliceId(slice.id)}
              onMouseLeave={() => setHoveredSliceId(null)}
            >
              <span
                aria-hidden
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: `var(${slice.colorVar})` }}
              />
              <span className="text-fg-secondary truncate w-28 flex-shrink-0">{slice.label}</span>
              <div className="flex-1 min-w-4 h-1 rounded-full bg-edge/40 overflow-hidden" aria-hidden>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${metricTotal > 0 ? Math.max((sliceMetricValue(slice) / metricTotal) * 100, 2) : 0}%`,
                    backgroundColor: `var(${slice.colorVar})`,
                  }}
                />
              </div>
              <span className="text-fg tabular-nums">{formatTokenCount(slice.value)}</span>
              {costKnown && (
                <span className="text-fg-muted tabular-nums w-14 text-right">{formatCost(slice.costUsd)}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </ChartCard>
  );
}
