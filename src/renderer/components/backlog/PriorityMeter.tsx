import React from 'react';
import meterContract from '@kangentic/branding/assets/priority/meter.json';
import { useDevicePixelRatio } from '../../hooks/useDevicePixelRatio';

/**
 * The meter's numbers come from `@kangentic/branding` (`assets/priority/meter.json`), the
 * contract the desktop, the web demo and the phone all draw from (#1160), so the three
 * cannot drift apart. The contract's bar height is the capital height of the card title's
 * 14px text, so the meter sits level with #N and the globe in a card's title row.
 */
const BAR = meterContract.bar;
const OPACITY = meterContract.opacity;

/** The most levels a scale may have. Adding a level stops here; a longer scale still draws. */
export const MAX_PRIORITY_LEVELS = meterContract.maxLevels;

export interface PriorityMeterBar {
  filled: boolean;
  opacity: number;
}

/**
 * One bar per level above the scale's bottom entry, all the same height, lit up to
 * `level` from the left. The number of lit bars carries the rank, so two levels never
 * differ by color alone. A level past the end of the scale lights every bar. Lit bars
 * draw at full strength, the rest dimmed, and every bar of the bottom entry (None)
 * dimmed a little less, so None reads as a meter rather than as nothing.
 */
export function priorityMeterBars(level: number, levelCount: number): PriorityMeterBar[] {
  const barCount = Math.max(1, levelCount - 1);
  const litCount = Math.min(Math.max(level, 0), barCount);
  return Array.from({ length: barCount }, (_unused, index) => {
    const filled = index < litCount;
    return {
      filled,
      opacity: filled ? OPACITY.lit : (level > 0 ? OPACITY.unlit : OPACITY.none),
    };
  });
}

/**
 * The meter's width in px for a scale of `levelCount` entries, as `PriorityMeter` draws it
 * at `devicePixelRatio`: its bars and gaps snapped to whole device pixels. At 1x it is the
 * contract's width.
 */
export function priorityMeterWidth(levelCount: number, devicePixelRatio = 1): number {
  const barCount = Math.max(1, levelCount - 1);
  return barCount * snapToDevicePixels(BAR.width, devicePixelRatio)
    + (barCount - 1) * snapToDevicePixels(BAR.gap, devicePixelRatio);
}

/**
 * A length in layout px rounded to whole device pixels, half up (the contract's
 * `pixelSnap`). Each edge of a bar otherwise rounds on its own, and 3px bars come out
 * unequal at 125%, 150% and 175% display scaling.
 */
export function snapToDevicePixels(lengthPx: number, devicePixelRatio: number): number {
  return Math.floor(lengthPx * devicePixelRatio + 0.5) / devicePixelRatio;
}

interface PriorityMeterProps {
  level: number;
  levelCount: number;
  color: string;
}

/**
 * The priority level meter, drawn from spans rather than an inline SVG
 * (ui-conventions.md). Every surface that shows a priority draws this one meter.
 * Decorative: the element around it carries the name, the level's (`PriorityBadge`, a
 * picker row) or its own (the toolbar's Priorities button, which draws it as an icon).
 */
export const PriorityMeter = React.memo(function PriorityMeter({ level, levelCount, color }: PriorityMeterProps) {
  const devicePixelRatio = useDevicePixelRatio();
  const barWidth = snapToDevicePixels(BAR.width, devicePixelRatio);
  const barGap = snapToDevicePixels(BAR.gap, devicePixelRatio);
  const barHeight = snapToDevicePixels(BAR.height, devicePixelRatio);
  const bars = priorityMeterBars(level, levelCount);
  return (
    <span
      className="inline-flex shrink-0 items-center"
      style={{ height: barHeight, gap: barGap }}
      aria-hidden
      data-testid="priority-meter"
    >
      {bars.map((bar, index) => (
        <span
          key={index}
          className="block"
          data-filled={bar.filled ? 'true' : undefined}
          style={{
            width: barWidth,
            height: barHeight,
            borderRadius: BAR.radius,
            backgroundColor: color,
            opacity: bar.opacity,
          }}
        />
      ))}
    </span>
  );
});
