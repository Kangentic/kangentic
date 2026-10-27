import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { UsageTimePeriod } from '../../../shared/types';

/**
 * The shared range set (same union the old status-bar strip used). Labels are
 * descriptors, resolved where they are drawn, so they read the session's catalog.
 */
export const PERIOD_OPTIONS: ReadonlyArray<{ value: UsageTimePeriod; label: MessageDescriptor }> = [
  { value: 'live', label: msg({ message: 'Live', context: 'Usage statistics' }) },
  { value: 'today', label: msg`Today` },
  { value: 'week', label: msg`This Week` },
  { value: 'month', label: msg`This Month` },
  { value: 'all', label: msg`All Time` },
];

export const PERIOD_LABELS: Record<UsageTimePeriod, MessageDescriptor> = Object.fromEntries(
  PERIOD_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<UsageTimePeriod, MessageDescriptor>;
