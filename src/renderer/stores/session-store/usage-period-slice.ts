import { type StateCreator } from 'zustand';
import type { UsageTimePeriod, PeriodUsageStats } from '../../../shared/types';
import type { SessionStore } from './types';

export interface UsagePeriodSlice {
  /** Selected time period for status bar usage stats. */
  selectedPeriod: UsageTimePeriod;
  /** Aggregated DB stats for the selected period (excludes live sessions). */
  periodStats: PeriodUsageStats | null;
  setSelectedPeriod: (period: UsageTimePeriod) => void;
  fetchPeriodStats: (period?: UsageTimePeriod) => Promise<void>;
}

/**
 * Status-bar usage-stats period selector. `live` means "show whatever
 * live sessions are producing right now" (no DB aggregation); the
 * other periods trigger a server-side aggregate query.
 *
 * Selection is persisted to AppConfig (fire-and-forget) so it survives
 * app restarts.
 */
export const createUsagePeriodSlice: StateCreator<SessionStore, [], [], UsagePeriodSlice> = (set, get) => ({
  selectedPeriod: 'live',
  periodStats: null,

  setSelectedPeriod: (period) => {
    if (period === 'live') {
      set({ selectedPeriod: period, periodStats: null });
    } else {
      set({ selectedPeriod: period });
      get().fetchPeriodStats(period);
    }
    // Persist selection to config (fire-and-forget)
    window.electronAPI.config.set({ statusBarPeriod: period });
  },

  fetchPeriodStats: async (period?) => {
    const targetPeriod = period ?? get().selectedPeriod;
    if (targetPeriod === 'live') return;
    try {
      const stats = await window.electronAPI.sessions.getPeriodStats(targetPeriod);
      set({ periodStats: stats });
    } catch {
      // Ignore - project may have been closed
    }
  },
});
