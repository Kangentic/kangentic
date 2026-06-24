import { type StateCreator } from 'zustand';
import type { GitDiffScope } from '../../../shared/types';
import type { SessionStore } from './types';

export interface TaskChangesPanelSlice {
  /** Task IDs whose Changes panel is open (persists across dialog open/close). */
  changesOpenTasks: Set<string>;
  /** Last selected file in the Changes panel, keyed by task ID. */
  changesSelectedFile: Record<string, string>;
  /**
   * Live diff scope (working / staged / branch) for the Changes panel, keyed by
   * task ID. Absent means "use the global `diffDefaultScope` default". This is
   * panel state, not config: only the default is persisted in config.
   */
  changesScope: Record<string, GitDiffScope>;
  /**
   * Manually-set Changes panel file-tree width (px), keyed by task ID. Absent
   * means the panel auto-fits to the branch name / commit on open. Per-task so a
   * task with a long branch name can keep its own width (persists across dialog
   * open/close, like {@link dividerRatio}).
   */
  changesFileTreeWidth: Record<string, number>;
  /**
   * Per-file "viewed" marks for the Changes panel, keyed by task ID to the set of
   * viewed file paths. A reviewed file's row dims. Panel state (persists across
   * dialog open/close), reset on app restart like a review session.
   */
  changesViewedFiles: Record<string, Set<string>>;
  /** View mode for the task-detail Changes panel, keyed by task ID (default 'split'). */
  changesViewMode: Record<string, 'split' | 'expanded'>;
  /**
   * Divider ratio for the task-detail terminal / right-panel split, keyed by
   * task ID. The value is the fraction of horizontal space given to the LEFT
   * (terminal) pane; absent means the 50/50 default. One shared ratio per task
   * across both the Browser and Changes views (persists across dialog
   * open/close).
   */
  dividerRatio: Record<string, number>;
  /** Task IDs whose Browser pane is open (persists across dialog open/close). */
  browserOpenTasks: Set<string>;
  /**
   * Entity IDs whose dialog is maximized (persists across dialog open/close).
   * Keyed by task ID for the task detail dialog, and by a non-task sentinel id
   * for the command terminal ('command-terminal') and the create dialogs
   * ('new-task-dialog', 'new-backlog-task-dialog').
   */
  maximizedTasks: Set<string>;
  toggleChangesOpen: (taskId: string) => void;
  setChangesSelectedFile: (taskId: string, filePath: string | null) => void;
  setChangesScope: (taskId: string, scope: GitDiffScope) => void;
  setChangesFileTreeWidth: (taskId: string, width: number) => void;
  toggleChangesFileViewed: (taskId: string, filePath: string) => void;
  setChangesViewMode: (taskId: string, mode: 'split' | 'expanded') => void;
  setDividerRatio: (taskId: string, ratio: number) => void;
  toggleBrowserOpen: (taskId: string) => void;
  toggleMaximized: (taskId: string) => void;
}

/**
 * UI state for the Task Detail dialog's terminal / right-panel area, keyed by
 * task ID. Tracks which tasks have the Changes panel open, the selected file
 * inside it, the split-vs-expanded view mode, the draggable divider ratio, which
 * tasks have the Browser pane open, and which tasks are maximized. State persists
 * across dialog open/close so reopening a task shows the same panel state.
 */
export const createTaskChangesPanelSlice: StateCreator<SessionStore, [], [], TaskChangesPanelSlice> = (set, get) => ({
  changesOpenTasks: new Set<string>(),
  changesSelectedFile: {},
  changesScope: {},
  changesFileTreeWidth: {},
  changesViewedFiles: {},
  changesViewMode: {},
  dividerRatio: {},
  browserOpenTasks: new Set<string>(),
  maximizedTasks: new Set<string>(),

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

  toggleBrowserOpen: (taskId) => {
    const next = new Set(get().browserOpenTasks);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    set({ browserOpenTasks: next });
  },

  toggleMaximized: (taskId) => {
    const next = new Set(get().maximizedTasks);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    set({ maximizedTasks: next });
  },

  setChangesViewMode: (taskId, mode) => {
    set({ changesViewMode: { ...get().changesViewMode, [taskId]: mode } });
  },

  setDividerRatio: (taskId, ratio) => {
    set({ dividerRatio: { ...get().dividerRatio, [taskId]: ratio } });
  },

  setChangesScope: (taskId, scope) => {
    set({ changesScope: { ...get().changesScope, [taskId]: scope } });
  },

  setChangesFileTreeWidth: (taskId, width) => {
    set({ changesFileTreeWidth: { ...get().changesFileTreeWidth, [taskId]: width } });
  },

  toggleChangesFileViewed: (taskId, filePath) => {
    const next = new Set(get().changesViewedFiles[taskId] ?? []);
    if (next.has(filePath)) {
      next.delete(filePath);
    } else {
      next.add(filePath);
    }
    set({ changesViewedFiles: { ...get().changesViewedFiles, [taskId]: next } });
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
