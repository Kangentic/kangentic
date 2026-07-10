import { memo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip, matchByDataKey } from 'recharts';
import type { DonutSlice } from '../useStatsData';
import { ChartTooltip } from './ChartTooltip';

interface KngDonutProps {
  slices: DonutSlice[];
  centerValue: string;
  centerLabel: string;
  valueFormatter: (value: number) => string;
  /** Tooltip row label for the slice value (e.g. 'tokens' or 'cost'). */
  valueLabel?: string;
  ariaLabel: string;
  /** Slice currently hovered (donut sector OR its list row); other slices dim
   *  so the pair reads as one linked unit. */
  highlightedSliceId?: string | null;
  /** Hover linkage: fired with the hovered slice id (null on leave) so the
   *  sibling value list can highlight the matching row alongside the tooltip. */
  onSliceHover?: (sliceId: string | null) => void;
  /** Suspend data animations (e.g. during an active window resize). */
  animate?: boolean;
}

/**
 * Donut with a center total (mockup-faithful breakdown form). Segments carry a
 * 2px surface-colored stroke (the mark-spec gap between adjacent fills); the
 * center total is an absolutely-positioned HTML overlay so it wears text
 * tokens. Hover feedback is doubled: the cursor tooltip names the slice, and
 * the linked list-row highlight in the parent BreakdownCard confirms WHICH
 * row the slice is.
 */
export const KngDonut = memo(function KngDonut({
  slices,
  centerValue,
  centerLabel,
  valueFormatter,
  valueLabel = 'tokens',
  ariaLabel,
  highlightedSliceId = null,
  onSliceHover,
  animate = true,
}: KngDonutProps) {
  return (
    <div className="relative h-full w-full" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <Tooltip
            isAnimationActive={false}
            // Above the absolutely-positioned center-total overlay; without
            // this the tooltip renders underneath it and mushes into the text.
            wrapperStyle={{ zIndex: 10 }}
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const slice = payload[0].payload as DonutSlice;
              return (
                <ChartTooltip
                  title={slice.label}
                  rows={[{ label: valueLabel, value: valueFormatter(slice.value), colorVar: slice.colorVar }]}
                />
              );
            }}
          />
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            innerRadius="68%"
            outerRadius="94%"
            paddingAngle={1}
            stroke="var(--kng-surface-raised)"
            strokeWidth={2}
            isAnimationActive={animate}
            animationDuration={250}
            animationEasing="ease-out"
            animationMatchBy={matchByDataKey('id')}
            onMouseEnter={(sector) => onSliceHover?.((sector as { id?: string }).id ?? null)}
            onMouseLeave={() => onSliceHover?.(null)}
          >
            {slices.map((slice) => (
              <Cell
                key={slice.id}
                fill={`var(${slice.colorVar})`}
                fillOpacity={highlightedSliceId !== null && slice.id !== highlightedSliceId ? 0.35 : 1}
              />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-fg font-semibold text-sm tabular-nums">{centerValue}</span>
        {/* Bounded so a long entity name (model ids, "(default)") stays
            inside the donut hole. */}
        <span className="text-fg-faint text-[11px] max-w-[70%] truncate" title={centerLabel}>{centerLabel}</span>
      </div>
    </div>
  );
});
