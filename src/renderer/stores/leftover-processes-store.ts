import { create } from 'zustand';
import type { LeftoverProcessReport } from '../../shared/types';
import type { LeftoverStopState } from '../lib/leftover-processes';

/** Reports kept for Review. A toast's Review link outlives few of them. */
const RETAINED_REPORTS = 20;

interface LeftoverProcessesStore {
  /** Recent reports by id, oldest first, for the toast's Review link. */
  reports: Record<string, LeftoverProcessReport>;
  /** The report the list shows, or null when it is closed. */
  openReportId: string | null;
  /** What the user's Stop did to a row, by process id. */
  stopStates: Record<string, LeftoverStopState>;
  addReport: (report: LeftoverProcessReport) => void;
  openReport: (reportId: string) => void;
  closeReport: () => void;
  /** Stop one listed process. The row reads `stopping` until main answers. */
  stopProcess: (processId: string) => Promise<void>;
}

interface PreservedState {
  reports: Record<string, LeftoverProcessReport>;
  openReportId: string | null;
  stopStates: Record<string, LeftoverStopState>;
}

/** Preserve reports across a Vite Fast Refresh, as toast-store does for its
 *  toasts: a toast that survives the refresh keeps a Review link into this
 *  store, and a reset store would leave that link opening nothing. Production
 *  has no `import.meta.hot`, so this is a no-op there. */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preserved: PreservedState | undefined = import.meta.hot?.data?.leftoverProcesses;

export const useLeftoverProcessesStore = create<LeftoverProcessesStore>((set, get) => ({
  reports: preserved?.reports ?? {},
  openReportId: preserved?.openReportId ?? null,
  stopStates: preserved?.stopStates ?? {},

  addReport: (report) => {
    set((state) => {
      const ids = [...Object.keys(state.reports), report.id];
      const kept = ids.slice(-RETAINED_REPORTS);
      const reports: Record<string, LeftoverProcessReport> = {};
      for (const id of kept) reports[id] = id === report.id ? report : state.reports[id];
      return { reports };
    });
  },

  openReport: (reportId) => {
    if (get().reports[reportId]) set({ openReportId: reportId });
  },

  closeReport: () => set({ openReportId: null }),

  stopProcess: async (processId) => {
    set((state) => ({ stopStates: { ...state.stopStates, [processId]: 'stopping' } }));
    let outcome: LeftoverStopState;
    try {
      outcome = await window.electronAPI.leftoverProcesses.stop(processId);
    } catch {
      outcome = 'failed';
    }
    set((state) => ({ stopStates: { ...state.stopStates, [processId]: outcome } }));
  },
}));

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    const { reports, openReportId, stopStates } = useLeftoverProcessesStore.getState();
    data.leftoverProcesses = { reports, openReportId, stopStates } satisfies PreservedState;
  });
}
