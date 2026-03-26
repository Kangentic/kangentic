import type { UsageTimePeriod } from './types';

/** Compute the ISO date string cutoff for a usage time period, or null for 'all'. */
export function computePeriodCutoff(period: UsageTimePeriod): string | null {
  const now = new Date();
  switch (period) {
    case 'live':
    case 'all':
      return null;
    case 'today': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return start.toISOString();
    }
    case 'week': {
      const day = now.getDay();
      const daysFromMonday = day === 0 ? 6 : day - 1;
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysFromMonday);
      return start.toISOString();
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return start.toISOString();
    }
  }
}
