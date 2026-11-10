import { Calendar, Clock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { RateLimitWindow } from '../../../shared/types';
import { getProgressColor } from '../../utils/progress-color';
import { windowElapsedPercentage } from '../../utils/rate-limit-window';
import { formatDuration } from '../../utils/format-session';
import { formatMonthDayTime } from '../../lib/datetime';

/**
 * The pieces a rate-limit window is drawn from, shared by the context bar's pill and the
 * Accounts tab's usage lines so the two cannot drift.
 */

// Maps adapter-declared RateLimitWindow.iconKind to a Lucide icon. The visual
// vocabulary lives here in the renderer so adapters declare semantics, not chrome.
export const RATE_LIMIT_ICON: Record<RateLimitWindow['iconKind'], LucideIcon> = {
  session: Clock,
  period: Calendar,
};

/**
 * When a window resets, as a sentence: "Resets in 2h 10m", "Resets Nov 12, 10:00 AM". Empty for a
 * window with no reset time (`resetsAt` 0, a CLI that reports none), which is not "now".
 */
export function formatResetTime(epochSeconds: number): string {
  if (epochSeconds <= 0) return '';
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return i18n._(msg`Resets now`);
  if (ms < 24 * 60 * 60 * 1000) {
    const duration = formatDuration(ms);
    return i18n._(msg`Resets in ${duration}`);
  }
  const resetMoment = formatMonthDayTime(epochSeconds * 1000);
  return i18n._(msg`Resets ${resetMoment}`);
}

/** The same moment with no verb, for a column a reset icon already heads: "2h 10m", "Nov 12, 10:00 AM". */
export function formatResetMoment(epochSeconds: number, nowMs: number): string {
  const ms = epochSeconds * 1000 - nowMs;
  if (ms <= 0) return i18n._(msg({ message: 'now', context: 'when a usage window resets' }));
  // Under an hour, whole minutes: the column is read at a glance and ticks every half minute.
  // Rounded down, so the last minute before the hour reads 59m, never 60m.
  if (ms < 60 * 60 * 1000) {
    const minutes = Math.max(1, Math.floor(ms / 60_000));
    return i18n._(msg`${minutes}m`);
  }
  if (ms < 24 * 60 * 60 * 1000) return formatDuration(ms);
  return formatMonthDayTime(epochSeconds * 1000);
}

/**
 * A window's usage track. The colored fill is driven by `usedPercentage` (budget spent); a
 * caret-topped vertical tick marks how far through the time window we are (elapsed time, not
 * budget), creeping right as the reset time draws nearer. `now` is epoch ms. With no window
 * (`limitWindow` null) it draws the empty track, for a reading that has not arrived.
 */
export function RateLimitTrack({ limitWindow, now, className }: { limitWindow: RateLimitWindow | null; now: number; className?: string }) {
  const roundedUsedPercentage = limitWindow ? Math.round(limitWindow.usedPercentage) : 0;
  // windowDurationSeconds is optional: a window with no fixed duration draws no
  // time marker, so only compute the position when the adapter supplied one.
  const markerPercentage = !limitWindow || limitWindow.windowDurationSeconds === undefined
    ? null
    : windowElapsedPercentage(limitWindow.resetsAt, limitWindow.windowDurationSeconds, now);
  return (
    // No overflow-hidden so the caret atop the tick marker, which extends a
    // few px above the track, is not clipped. The fill is width-capped at
    // 100%, so nothing overflows horizontally and the track still reads as a
    // pill.
    <span className={`relative h-1.5 bg-surface-hover rounded-full ${className ?? 'flex-1 min-w-[40px]'}`} data-meter-track="">
      {/* This one stays on `width` on purpose, unlike the context fill and
          ContextUsageFooter's. The `minWidth: 2px` floor below keeps a barely
          started window visible, and that is a width-space idea with no
          scale-space equivalent short of measuring the track and dividing - a
          layout read on every render, to remove a transition that fires when a
          rate-limit window ticks, which is minutes apart rather than per token.
          The composited-transform rewrite is not worth that trade here. */}
      <span
        className="block h-full rounded-full transition-[width,background-color] duration-300"
        style={{
          width: `${Math.min(roundedUsedPercentage, 100)}%`,
          minWidth: roundedUsedPercentage > 0 ? '2px' : undefined,
          backgroundColor: getProgressColor(roundedUsedPercentage),
        }}
      />
      {markerPercentage !== null && (
        <span
          data-testid="rate-limit-time-marker"
          aria-hidden="true"
          className="absolute inset-y-0 w-px -translate-x-1/2 bg-fg/70"
          style={{ left: `${markerPercentage}%` }}
        >
          {/* Caret cap riding on the top edge of the tick, so the marker reads
              as a deliberate playhead anchored to the bar rather than a bare
              line. It extends upward only; the tick itself stays inside the
              track height. */}
          <span
            aria-hidden="true"
            className="absolute -top-1 left-1/2 -translate-x-1/2 w-1.5 h-1 bg-fg/70"
            style={{ clipPath: 'polygon(50% 100%, 0 0, 100% 0)' }}
          />
        </span>
      )}
    </span>
  );
}
