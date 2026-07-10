import type { UsageTimePeriod } from '../../../shared/types';

/** The shared range set (same union the old status-bar strip used). */
export const PERIOD_OPTIONS: ReadonlyArray<{ value: UsageTimePeriod; label: string }> = [
  { value: 'live', label: 'Live' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
  { value: 'all', label: 'All Time' },
];

export const PERIOD_LABELS: Record<UsageTimePeriod, string> = Object.fromEntries(
  PERIOD_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<UsageTimePeriod, string>;
