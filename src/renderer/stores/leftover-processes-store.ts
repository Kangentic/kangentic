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

const createLeftoverProcessesStore = () => create<LeftoverProcessesStore>((set, get) => ({
  reports: {},
  openReportId: null,
  stopStates: {},

  addReport: (report) => {
    set((state) => {
      const ids = [...Object.keys(state.reports).filter((id) => id !== report.id), report.id];
      const kept = ids.slice(-RETAINED_REPORTS);
      const reports: Record<string, LeftoverProcessReport> = {};
      for (const id of kept) reports[id] = id === report.id ? report : state.reports[id];
      // A Stop outcome belongs to a row of a retained report; drop the rest
      // so the map does not outgrow the reports it describes.
      const retainedProcessIds = new Set(kept.flatMap((id) => reports[id].processes.map((entry) => entry.id)));
      const stopStates: Record<string, LeftoverStopState> = {};
      for (const [processId, stopState] of Object.entries(state.stopStates)) {
        if (retainedProcessIds.has(processId)) stopStates[processId] = stopState;
      }
      return { reports, stopStates };
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

// HMR instance pinning (Pattern E, see .claude/rules/hmr-patterns.md): this
// module's only runtime export is the non-component hook, so it is not a
// React Fast Refresh boundary. Pin the instance in `import.meta.hot.data` so a
// Fast Refresh cannot hand the dialog a second store while a toast that
// survived the refresh still opens its Review link on the first one.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedLeftoverProcessesStore: ReturnType<typeof createLeftoverProcessesStore> | undefined = import.meta.hot?.data?.leftoverProcessesStore;

export const useLeftoverProcessesStore = preservedLeftoverProcessesStore ?? createLeftoverProcessesStore();

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.leftoverProcessesStore = useLeftoverProcessesStore;
  // Editing this module's OWN code would leave the pinned instance running
  // stale closures; force a clean full reload instead. Rare; prod is
  // unaffected (import.meta.hot is undefined there, so this block is dropped).
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
