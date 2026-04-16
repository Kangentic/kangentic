import { type StateCreator } from 'zustand';
import type { ShortcutConfig } from '../../../shared/types';
import type { BoardStore } from './types';

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
      const [tasks, swimlanes, archivedTasks] = await Promise.all([
        window.electronAPI.tasks.list(),
        window.electronAPI.swimlanes.list(),
        window.electronAPI.tasks.listArchived(),
      ]);
      set({ tasks, swimlanes, archivedTasks, loading: false, hydrated: true });
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
