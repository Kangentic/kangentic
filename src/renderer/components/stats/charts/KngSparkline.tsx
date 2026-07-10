import { memo } from 'react';
import { Area, AreaChart, ResponsiveContainer, matchByDataKey } from 'recharts';
import type { TimePoint } from '../useStatsData';

/**
 * Axis-less mini trend inside a KPI stat tile (dataviz stat-tile form:
 * value + sparkline). Decorative reinforcement only - the tile's number is
 * the accessible value - so it is aria-hidden and has no tooltip layer.
 */
export const KngSparkline = memo(function KngSparkline({
  points,
  colorVar,
  className = 'h-7 w-full',
  animate = true,
}: {
  points: TimePoint[];
  colorVar: string;
  /** Container sizing (hero tiles use a taller fill). */
  className?: string;
  /** Suspend data animations (e.g. during an active window resize). */
  animate?: boolean;
}) {
  if (points.length < 2) return null;
  return (
    <div className={className} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <Area
            dataKey="y"
            type="monotone"
            stroke={`var(${colorVar})`}
            strokeWidth={1.5}
            fill={`var(${colorVar})`}
            fillOpacity={0.12}
            dot={false}
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
