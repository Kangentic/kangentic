import React from 'react';

/** Width of one bar, in px. */
const BAR_WIDTH_PX = 3;
/** Gap between two bars, in px. */
const BAR_GAP_PX = 2;
/** Height of the first bar, in px. */
const SHORTEST_BAR_PX = 5;
/** Height of the last bar, and of the meter, in px. */
const TALLEST_BAR_PX = 14;
/** Opacity of a bar above the level. */
const UNFILLED_OPACITY = 0.3;
/** Opacity of every bar of the bottom entry (None). */
const NONE_OPACITY = 0.45;

export interface PriorityMeterBar {
  heightPx: number;
  filled: boolean;
}

/**
 * One bar per level above the scale's bottom entry, rising from the shortest bar to the tallest, filled up to
 * `level`. The bar count carries the rank, so two levels never differ by color alone. A
 * level past the end of the scale fills every bar.
 */
export function priorityMeterBars(level: number, levelCount: number): PriorityMeterBar[] {
  const barCount = Math.max(1, levelCount - 1);
  const filledCount = Math.max(0, Math.min(level, barCount));
  const rise = TALLEST_BAR_PX - SHORTEST_BAR_PX;
  return Array.from({ length: barCount }, (_unused, index) => ({
    heightPx: SHORTEST_BAR_PX + Math.round((index * rise) / Math.max(1, barCount - 1)),
    filled: index < filledCount,
  }));
}

/** The meter's width in px for a scale of `levelCount` entries. */
export function priorityMeterWidth(levelCount: number): number {
  const barCount = Math.max(1, levelCount - 1);
  return barCount * BAR_WIDTH_PX + (barCount - 1) * BAR_GAP_PX;
}

interface PriorityMeterProps {
  level: number;
  levelCount: number;
  color: string;
}

/**
 * The priority level meter, drawn from spans rather than an inline SVG
 * (ui-conventions.md). Decorative: the `PriorityBadge` around it carries the level's name.
 */
export const PriorityMeter = React.memo(function PriorityMeter({ level, levelCount, color }: PriorityMeterProps) {
  const bars = priorityMeterBars(level, levelCount);
  return (
    <span
      className="inline-flex shrink-0 items-end"
      style={{ height: TALLEST_BAR_PX, gap: BAR_GAP_PX }}
      aria-hidden
      data-testid="priority-meter"
    >
      {bars.map((bar, index) => (
        <span
          key={index}
          className="block rounded-[1px]"
          data-filled={bar.filled ? 'true' : undefined}
          style={{
            width: BAR_WIDTH_PX,
            height: bar.heightPx,
            backgroundColor: color,
            opacity: bar.filled ? 1 : (level > 0 ? UNFILLED_OPACITY : NONE_OPACITY),
          }}
        />
      ))}
    </span>
  );
});
