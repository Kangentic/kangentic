import { create } from 'zustand';
import type { LeftoverProcessReport } from '../../shared/types';
import type { LeftoverStopState } from '../lib/leftover-processes';

/** Reports kept for Review. A toast whose report is evicted closes with it. */
const RETAINED_REPORTS = 20;

interface LeftoverProcessesStore {
  /** Recent reports by id, oldest first, for the toast's Review link. */
  reports: Record<string, LeftoverProcessReport>;
  /** The toast each retained report opened, by report id. */
  reportToasts: Record<string, string>;
  /** The report the list shows, or null when it is closed. */
  openReportId: string | null;
  /** What the user's Stop did to a row, by process id. */
  stopStates: Record<string, LeftoverStopState>;
  /**
   * Keep a report for Review, with the id of the toast that links to it.
   * Returns the toast ids of the reports this evicted: their Review links
   * would open nothing, so the caller closes them. A toast that waits to be
   * closed can outlive many newer reports.
   */
  addReport: (report: LeftoverProcessReport, toastId?: string) => string[];
  openReport: (reportId: string) => void;
  closeReport: () => void;
  /** Stop one listed process. The row reads `stopping` until main answers. */
  stopProcess: (processId: string) => Promise<void>;
}

const createLeftoverProcessesStore = () => create<LeftoverProcessesStore>((set, get) => ({
  reports: {},
  reportToasts: {},
  openReportId: null,
  stopStates: {},

  addReport: (report, toastId) => {
    const state = get();
    const ids = [...Object.keys(state.reports).filter((id) => id !== report.id), report.id];
    const kept = ids.slice(-RETAINED_REPORTS);
    const keptIds = new Set(kept);
    const reports: Record<string, LeftoverProcessReport> = {};
    for (const id of kept) reports[id] = id === report.id ? report : state.reports[id];
    const reportToasts: Record<string, string> = {};
    for (const id of kept) {
      const reportToastId = id === report.id ? toastId : state.reportToasts[id];
      if (reportToastId !== undefined) reportToasts[id] = reportToastId;
    }
    const evictedToastIds = Object.keys(state.reportToasts)
      .filter((id) => !keptIds.has(id))
      .map((id) => state.reportToasts[id]);
    // A Stop outcome belongs to a row of a retained report; drop the rest
    // so the map does not outgrow the reports it describes.
    const retainedProcessIds = new Set(kept.flatMap((id) => reports[id].processes.map((entry) => entry.id)));
    const stopStates: Record<string, LeftoverStopState> = {};
    for (const [processId, stopState] of Object.entries(state.stopStates)) {
      if (retainedProcessIds.has(processId)) stopStates[processId] = stopState;
    }
    set({ reports, reportToasts, stopStates });
    return evictedToastIds;
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
    // A newer report may have evicted this row's report while main answered,
    // and addReport dropped its state with it: do not bring it back.
    set((state) => (Object.hasOwn(state.stopStates, processId)
      ? { stopStates: { ...state.stopStates, [processId]: outcome } }
      : state));
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
