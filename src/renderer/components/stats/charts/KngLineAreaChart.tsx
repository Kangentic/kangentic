import { memo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  matchByDataKey,
} from 'recharts';
import type { TimePoint } from '../useStatsData';
import { ChartTooltip } from './ChartTooltip';

interface KngLineAreaChartProps {
  points: TimePoint[];
  /** CSS custom property name for the series color (e.g. '--kng-accent'). */
  colorVar: string;
  yFormatter: (value: number) => string;
  xFormatter: (ms: number) => string;
  /** Series name shown in the tooltip row. */
  seriesLabel: string;
  ariaLabel: string;
  /** When set, buckets are clickable (day drill-down) and the cursor says so. */
  onBucketClick?: (bucketStartMs: number) => void;
  /** Suspend data animations (e.g. during an active window resize). */
  animate?: boolean;
}

/**
 * Single-series area/line time chart (burn rate, cumulative spend). Thin
 * wrapper over Recharts behind a Kng* contract so the engine stays swappable;
 * colors are CSS custom properties resolved by the SVG itself, so all 10
 * themes re-skin with zero JS. `animationMatchBy` keys the update animation
 * on the bucket timestamp, so live appends slide smoothly instead of
 * re-animating the whole series.
 */
export const KngLineAreaChart = memo(function KngLineAreaChart({
  points,
  colorVar,
  yFormatter,
  xFormatter,
  seriesLabel,
  ariaLabel,
  onBucketClick,
  animate = true,
}: KngLineAreaChartProps) {
  return (
    <div className={`h-full w-full ${onBucketClick ? 'cursor-pointer' : ''}`} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={points}
          margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
          onClick={onBucketClick
            ? (chartState) => {
                const index = Number(chartState?.activeIndex);
                const point = Number.isInteger(index) ? points[index] : undefined;
                if (point) onBucketClick(point.x);
              }
            : undefined}
        >
          <CartesianGrid stroke="var(--kng-edge-subtle)" strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="x"
            type="number"
            domain={['dataMin', 'dataMax']}
            scale="linear"
            tickFormatter={xFormatter}
            tick={{ fill: 'var(--kng-fg-faint)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--kng-edge-subtle)' }}
            minTickGap={48}
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
            cursor={{ stroke: 'var(--kng-fg-faint)', strokeWidth: 1 }}
            isAnimationActive={false}
            wrapperStyle={{ zIndex: 10 }}
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const point = payload[0].payload as TimePoint;
              return (
                <ChartTooltip
                  title={xFormatter(point.x)}
                  rows={[{ label: seriesLabel, value: yFormatter(point.y), colorVar }]}
                />
              );
            }}
          />
          <Area
            dataKey="y"
            type="monotone"
            stroke={`var(${colorVar})`}
            strokeWidth={2}
            fill={`var(${colorVar})`}
            fillOpacity={0.14}
            dot={false}
            activeDot={{ r: 3, stroke: 'var(--kng-surface-raised)', strokeWidth: 2 }}
            isAnimationActive={animate}
            animationDuration={250}
            animationEasing="ease-out"
            animationMatchBy={matchByDataKey('x')}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
});
