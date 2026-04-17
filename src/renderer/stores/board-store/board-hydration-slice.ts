import { type StateCreator } from 'zustand';
import type { ShortcutConfig } from '../../../shared/types';
import type { BoardStore } from './types';
import { applyStructuralSharing } from './structural-sharing';

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
      const [nextTasks, swimlanes, nextArchivedTasks] = await Promise.all([
        window.electronAPI.tasks.list(),
        window.electronAPI.swimlanes.list(),
        window.electronAPI.tasks.listArchived(),
      ]);
      // Reuse object references for unchanged tasks so React.memo on TaskCard
      // can short-circuit. Every IPC roundtrip returns fresh JSON objects - if
      // we set them directly, 100 cards all re-render on every agent event even
      // when only one task actually changed.
      set((state) => ({
        tasks: applyStructuralSharing(state.tasks, nextTasks),
        swimlanes,
        archivedTasks: applyStructuralSharing(state.archivedTasks, nextArchivedTasks),
        loading: false,
        hydrated: true,
      }));
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
