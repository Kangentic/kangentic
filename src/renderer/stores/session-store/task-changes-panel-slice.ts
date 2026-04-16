import { type StateCreator } from 'zustand';
import type { SessionStore } from './types';

export interface TaskChangesPanelSlice {
  /** Task IDs whose Changes panel is open (persists across dialog open/close). */
  changesOpenTasks: Set<string>;
  /** Last selected file in the Changes panel, keyed by task ID. */
  changesSelectedFile: Record<string, string>;
  /** View mode for the task-detail Changes panel, keyed by task ID (default 'split'). */
  changesViewMode: Record<string, 'split' | 'expanded'>;
  toggleChangesOpen: (taskId: string) => void;
  setChangesSelectedFile: (taskId: string, filePath: string | null) => void;
  setChangesViewMode: (taskId: string, mode: 'split' | 'expanded') => void;
}

/**
 * UI state for the Changes panel inside TaskDetailDialog. Tracks which
 * tasks have the panel open, which file is selected inside each, and
 * the split-vs-expanded view mode. State persists across dialog
 * open/close so reopening a task shows the same panel state.
 */
export const createTaskChangesPanelSlice: StateCreator<SessionStore, [], [], TaskChangesPanelSlice> = (set, get) => ({
  changesOpenTasks: new Set<string>(),
  changesSelectedFile: {},
  changesViewMode: {},

  toggleChangesOpen: (taskId) => {
    const next = new Set(get().changesOpenTasks);
    const viewMode = { ...get().changesViewMode };
    if (next.has(taskId)) {
      next.delete(taskId);
      delete viewMode[taskId];
    } else {
      next.add(taskId);
      viewMode[taskId] = 'split';
    }
    set({ changesOpenTasks: next, changesViewMode: viewMode });
  },

  setChangesViewMode: (taskId, mode) => {
    set({ changesViewMode: { ...get().changesViewMode, [taskId]: mode } });
  },

  setChangesSelectedFile: (taskId, filePath) => {
    const current = get().changesSelectedFile;
    if (filePath === null) {
      if (!(taskId in current)) return;
      const { [taskId]: _removed, ...rest } = current;
      set({ changesSelectedFile: rest });
    } else {
      set({ changesSelectedFile: { ...current, [taskId]: filePath } });
    }
  },
});
