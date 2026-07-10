import { memo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  matchByDataKey,
} from 'recharts';
import type { ModelStackRow, ModelStackSeries } from '../useStatsData';
import { ChartTooltip } from './ChartTooltip';

interface KngBarChartProps {
  series: ModelStackSeries[];
  rows: ModelStackRow[];
  yFormatter: (value: number) => string;
  ariaLabel: string;
  /** When set, buckets are clickable (day drill-down) and the cursor says so. */
  onBucketClick?: (bucketStartMs: number) => void;
  /** Suspend data animations (e.g. during an active window resize). */
  animate?: boolean;
}

/**
 * Stacked column chart over dense, evenly-spaced time buckets (the by-model
 * daily cost/token bars). Category x-axis (buckets are pre-densified server
 * side); a 1px surface-colored stroke gives the mark-spec gap between stacked
 * segments; the hover tooltip lists EVERY series at the hovered bucket
 * (values lead, line-keyed swatches); the visible legend lives in the parent
 * card so identity is never color-alone. Single-series data renders as plain
 * bars with 4px rounded data-end caps; the caps are skipped for stacks (only
 * the top segment could carry them, and it is often zero-valued).
 */
export const KngBarChart = memo(function KngBarChart({
  series,
  rows,
  yFormatter,
  ariaLabel,
  onBucketClick,
  animate = true,
}: KngBarChartProps) {
  const isStacked = series.length > 1;
  return (
    <div className={`h-full w-full ${onBucketClick ? 'cursor-pointer' : ''}`} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
          barCategoryGap="12%"
          onClick={onBucketClick
            ? (chartState) => {
                const index = Number(chartState?.activeIndex);
                const row = Number.isInteger(index) ? rows[index] : undefined;
                if (row) onBucketClick(row.x as number);
              }
            : undefined}
        >
          <CartesianGrid stroke="var(--kng-edge-subtle)" strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: 'var(--kng-fg-faint)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--kng-edge-subtle)' }}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            width={52}
            tickFormatter={yFormatter}
            tick={{ fill: 'var(--kng-fg-faint)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ fill: 'var(--kng-surface-hover)', fillOpacity: 0.35 }}
            isAnimationActive={false}
            wrapperStyle={{ zIndex: 10 }}
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const row = payload[0].payload as ModelStackRow;
              // One tooltip, every series at this X (nonzero ones), values lead.
              const tooltipRows = series
                .map((entry) => ({ entry, value: row[entry.key] as number }))
                .filter(({ value }) => value > 0)
                .map(({ entry, value }) => ({
                  label: entry.label,
                  value: yFormatter(value),
                  colorVar: entry.colorVar,
                }));
              if (tooltipRows.length === 0) return null;
              return <ChartTooltip title={row.label} rows={tooltipRows} />;
            }}
          />
          {series.map((entry) => (
            <Bar
              key={entry.key}
              dataKey={entry.key}
              stackId="stack"
              fill={`var(${entry.colorVar})`}
              stroke="var(--kng-surface-raised)"
              strokeWidth={isStacked ? 1 : 0}
              radius={isStacked ? 0 : [4, 4, 0, 0]}
              maxBarSize={28}
              isAnimationActive={animate}
              animationDuration={250}
              animationEasing="ease-out"
              animationMatchBy={matchByDataKey('x')}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
});
