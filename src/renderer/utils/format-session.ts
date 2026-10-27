/**
 * Shared formatting utilities for session metrics (cost, duration).
 */
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';

/** "1h 30m", "4m 12s", "9s", with the unit letters from the active catalog. */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return i18n._(msg`${{ hours }}h ${{ minutes }}m`);
  if (minutes > 0) return i18n._(msg`${{ minutes }}m ${{ seconds }}s`);
  return i18n._(msg`${{ seconds }}s`);
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "9d 9h", "1h 59m", "37m 37s", "5s": the two largest units, a zero second one dropped ("16d", "20m"). */
export function formatSpan(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / SECOND_MS));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pair = (first: string, second: number, unit: string) => (second > 0 ? `${first} ${second}${unit}` : first);
  if (days > 0) return pair(`${days}d`, hours, 'h');
  if (hours > 0) return pair(`${hours}h`, minutes, 'm');
  if (minutes > 0) return pair(`${minutes}m`, seconds, 's');
  return `${seconds}s`;
}

/**
 * A span sized for a small pill: whole minutes once it passes one ("24m" for
 * 23m 43s), otherwise as `formatSpan` reads it. The exact span goes in the title.
 */
export function formatSpanCompact(milliseconds: number): string {
  // Rounded before the unit is chosen, so 59m 40s reads "1h", never "60m".
  if (milliseconds >= MINUTE_MS && milliseconds < DAY_MS) return formatSpan(Math.round(milliseconds / MINUTE_MS) * MINUTE_MS);
  if (milliseconds >= DAY_MS) return formatSpan(Math.round(milliseconds / HOUR_MS) * HOUR_MS);
  return formatSpan(milliseconds);
}

/** A short call's runtime to a tenth of a second ("2.4s"), a longer one as `formatSpan`. */
export function formatCallDuration(milliseconds: number): string {
  // Rounded before the unit is chosen, so 59.96s reads "1m", never "60.0s".
  const tenths = Math.round(milliseconds / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  return formatSpan(milliseconds);
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
