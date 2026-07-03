import { type StateCreator } from 'zustand';
import type { ShortcutConfig } from '../../../shared/types';
import type { BoardStore } from './types';
import { applyStructuralSharing, applySwimlaneStructuralSharing } from './structural-sharing';
import { ARCHIVED_PREVIEW_LIMIT } from './archived-tasks-slice';

export interface BoardHydrationSlice {
  loading: boolean;
  hydrated: boolean;
  shortcuts: (ShortcutConfig & { source: 'team' | 'local' })[];
  /**
   * HMR invariant: this method is called from App.tsx `vite:afterUpdate`
   * to re-sync the store after a hot reload replaces the module. Any
   * rename of `loadBoard` must be mirrored in the HMR handler - a unit
   * test (hmr-resync.test.ts) enforces the pairing.
   */
  loadBoard: () => Promise<void>;
  /** Same HMR invariant as loadBoard. */
  loadShortcuts: () => Promise<void>;
}

export const createBoardHydrationSlice: StateCreator<BoardStore, [], [], BoardHydrationSlice> = (set, get) => ({
  loading: false,
  hydrated: false,
  shortcuts: [],

  loadBoard: async () => {
    set({ loading: true });
    try {
      // Hydrate from the cheap archived PREVIEW (newest N + total count) instead
      // of the full archive, which can be many MB once hundreds of tasks pile up
      // and was cloned on every agent-driven reload. The full list loads lazily
      // only while an archive viewer is mounted (Completed dialog / deep-anchor
      // detail window), tracked by archiveViewers.
      const [nextTasks, nextSwimlanes, archivedPreview] = await Promise.all([
        window.electronAPI.tasks.list(),
        window.electronAPI.swimlanes.list(),
        window.electronAPI.tasks.listArchivedPreview(ARCHIVED_PREVIEW_LIMIT),
      ]);
      // Reuse object references for unchanged tasks/swimlanes so React.memo can
      // short-circuit. Every IPC roundtrip returns fresh JSON objects - if we
      // set them directly, every card and column re-renders on every agent event
      // even when only one row actually changed.
      const keepFull = get().archiveViewers > 0 && get().archivedFullyLoaded;
      set((state) => ({
        tasks: applyStructuralSharing(state.tasks, nextTasks),
        swimlanes: applySwimlaneStructuralSharing(state.swimlanes, nextSwimlanes),
        // While a viewer holds the full archive, keep it (reconciled out-of-band
        // below); otherwise downgrade to the preview.
        archivedTasks: keepFull
          ? state.archivedTasks
          : applyStructuralSharing(state.archivedTasks, archivedPreview.tasks),
        archivedFullyLoaded: keepFull,
        archivedTotalCount: archivedPreview.totalCount,
        loading: false,
        hydrated: true,
      }));
      // A mounted viewer still needs an authoritative full refresh (an agent may
      // have archived a task); do it off the hydration critical path.
      if (keepFull) void get().loadArchivedTasks().catch(() => {});
    } catch (error) {
      console.error('[board-store] Failed to load board:', error);
      set({ loading: false, hydrated: true });
    }

    // Load shortcuts separately (non-blocking)
    get().loadShortcuts();
  },

  loadShortcuts: async () => {
    try {
      const shortcuts = await window.electronAPI.boardConfig.getShortcuts();
      set({ shortcuts });
    } catch {
      // Non-fatal: shortcuts are optional
    }
  },
});
