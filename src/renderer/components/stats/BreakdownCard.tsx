import { useMemo, useState } from 'react';
import { formatTokenCount } from '../../utils/format-tokens';
import { formatCost } from '../../utils/format-session';
import type { UsageMetricMode } from '../../stores/usage-dashboard-store';
import { ChartCard } from './ChartCard';
import { Tooltip } from '../Tooltip';
import { KngDonut } from './charts/KngDonut';
import { rankSlicesByMetric, visibleSlices, type DonutSlice } from './useStatsData';

interface BreakdownCardProps {
  title: string;
  slices: DonutSlice[];
  costKnown: boolean;
  loading: boolean;
  testId: string;
  /** The dashboard's Cost/Tokens toggle: sizes the donut arcs, center total
   *  and share bars, and ranks the list, whose bright value is this metric. */
  metric: UsageMetricMode;
  /** Suspend donut animations (e.g. during an active window resize). */
  animate?: boolean;
}

/**
 * Donut + value list (the mockup's "by model" form). The list IS the
 * accessibility relief for the donut: every slice always renders with its
 * swatch, name, share bar, value and share, so identity and values are never
 * color-alone (this is what permits the sub-3:1 categorical slots the
 * palette validator WARNs about on some themes). The proportional share bar
 * doubles as the row's middle fill, so relative share reads at a glance
 * without matching donut colors.
 *
 * Colors are fixed by the token fold, so an entity keeps its color when the
 * metric toggles. The list RANKS by the selected metric and shows it as the
 * bright value beside its share; the other metric is in the row's tooltip.
 * A model that is 6% of tokens and 13% of spend moves up the Cost view's list.
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
  const { donutSlices, listSlices, metricTotal, leader } = useMemo(() => {
    // Only what this view has something to show for: a model with cost and
    // no turn tokens is in the Cost view, not the Tokens view.
    const shown = visibleSlices(slices, byCost);
    const mapped = shown.map((slice) => ({ ...slice, value: byCost ? slice.costUsd : slice.value }));
    return {
      donutSlices: mapped,
      listSlices: rankSlicesByMetric(shown, byCost),
      metricTotal: mapped.reduce((sum, slice) => sum + slice.value, 0),
      // The dimension's dominant entry BY THE SELECTED METRIC (the cost
      // leader can differ from the token leader).
      leader: mapped.reduce<(typeof mapped)[number] | null>(
        (best, slice) => (best === null || slice.value > best.value ? slice : best),
        null,
      ),
    };
  }, [slices, byCost]);
  const sharePercent = (slice: DonutSlice) =>
    (metricTotal > 0 ? Math.round((sliceMetricValue(slice) / metricTotal) * 100) : 0);
  // The row's tooltip: the shown metric, then the other one ("Opus 5: $43.26,
  // 111.2M tokens"). Cost is named only where it is known.
  const tokensText = (slice: DonutSlice) => `${formatTokenCount(slice.value)} tokens`;
  const rowTip = (slice: DonutSlice) => (byCost
    ? `${slice.label}: ${formatCost(slice.costUsd)}, ${tokensText(slice)}`
    : costKnown ? `${slice.label}: ${tokensText(slice)}, ${formatCost(slice.costUsd)}` : `${slice.label}: ${tokensText(slice)}`);

  return (
    <ChartCard
      title={title}
      loading={loading}
      empty={!loading && listSlices.length === 0}
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
            ariaLabel={`${title}: ${listSlices.map((slice) => `${slice.label} ${metricFormatter(sliceMetricValue(slice))}`).join(', ')}`}
            highlightedSliceId={hoveredSliceId}
            onSliceHover={setHoveredSliceId}
            animate={animate}
          />
        </div>
        <ul className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden max-h-full space-y-1.5" data-testid={`${testId}-list`}>
          {listSlices.map((slice) => (
            <Tooltip key={slice.id} label={rowTip(slice)}>
              <li
                className={`flex items-center gap-2 text-xs rounded transition-colors ${hoveredSliceId === slice.id ? 'bg-surface-hover/40' : ''}`}
                data-testid={`${testId}-row`}
                data-slice-id={slice.id}
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
                <span className="text-fg tabular-nums" data-testid={`${testId}-row-value`}>
                  {metricFormatter(sliceMetricValue(slice))}
                </span>
                <span className="text-fg-muted tabular-nums w-8 text-right">{`${sharePercent(slice)}%`}</span>
              </li>
            </Tooltip>
          ))}
        </ul>
      </div>
    </ChartCard>
  );
}
