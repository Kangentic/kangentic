import { type StateCreator } from 'zustand';
import { useProjectStore } from '../project-store';
import type { GitDiffScope, Task, TaskDetailViewState } from '../../../shared/types';
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
   * viewed file paths. A reviewed file's row dims. Persisted in the task's
   * `detail_view_state` blob and hydrated on load, so the marks survive an app
   * restart along with the rest of the dialog layout.
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
  /**
   * Internal hydration guard: task ids already seeded from their persisted
   * `detail_view_state` blob this session. Lives in store state (not module
   * scope) so it resets together with the view-state fields on a Fast Refresh,
   * letting the board-tasks effect re-seed after an HMR reload.
   */
  hydratedDetailViewTasks: Set<string>;
  toggleChangesOpen: (taskId: string) => void;
  setChangesSelectedFile: (taskId: string, filePath: string | null) => void;
  setChangesScope: (taskId: string, scope: GitDiffScope) => void;
  setChangesFileTreeWidth: (taskId: string, width: number) => void;
  toggleChangesFileViewed: (taskId: string, filePath: string) => void;
  markChangesFileViewed: (taskId: string, filePath: string) => void;
  setChangesViewMode: (taskId: string, mode: 'split' | 'expanded') => void;
  setDividerRatio: (taskId: string, ratio: number) => void;
  toggleBrowserOpen: (taskId: string) => void;
  toggleMaximized: (taskId: string) => void;
  /**
   * Seed the per-task detail-view fields above from each task's persisted
   * `detail_view_state` blob. Idempotent per task per session (a guard set
   * ensures a later board refresh, which may carry a stale blob, never
   * re-hydrates and clobbers live edits). Driven by a board-tasks effect so it
   * also re-runs after the HMR `vite:afterUpdate` board reload.
   */
  hydrateDetailViewStateForTasks: (tasks: Task[]) => void;
}

/** Debounce settle for persisting a task's detail-view-state blob to the DB. */
const DETAIL_VIEW_SAVE_DEBOUNCE_MS = 500;

/**
 * Pending debounced saves: the latest blob + the project id captured at the
 * interaction that scheduled the save (project-scoped-ipc rule). Kept separate
 * from the timer map so a flush always writes the most recent snapshot.
 */
const detailViewPendingSaves = new Map<string, { state: TaskDetailViewState; projectId: string | null }>();
const detailViewSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Write a pending blob to the DB now, clearing its timer + pending entry. */
function flushDetailViewSave(taskId: string): void {
  const timer = detailViewSaveTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    detailViewSaveTimers.delete(taskId);
  }
  const pending = detailViewPendingSaves.get(taskId);
  if (!pending) return;
  detailViewPendingSaves.delete(taskId);
  if (typeof window !== 'undefined' && window.electronAPI?.tasks?.setDetailViewState) {
    void window.electronAPI.tasks.setDetailViewState(taskId, pending.state, pending.projectId);
  }
}

/** Build the persisted blob for a task from the current slice state. */
function buildDetailViewBlob(state: SessionStore, taskId: string): TaskDetailViewState {
  const blob: TaskDetailViewState = {};
  const ratio = state.dividerRatio[taskId];
  if (ratio !== undefined) blob.dividerRatio = ratio;
  if (state.changesOpenTasks.has(taskId)) blob.changesOpen = true;
  if (state.browserOpenTasks.has(taskId)) blob.browserOpen = true;
  const viewMode = state.changesViewMode[taskId];
  if (viewMode !== undefined) blob.changesViewMode = viewMode;
  const selectedFile = state.changesSelectedFile[taskId];
  if (selectedFile !== undefined) blob.changesSelectedFile = selectedFile;
  const viewed = state.changesViewedFiles[taskId];
  if (viewed && viewed.size > 0) blob.changesViewedFiles = [...viewed];
  const scope = state.changesScope[taskId];
  if (scope !== undefined) blob.changesScope = scope;
  const treeWidth = state.changesFileTreeWidth[taskId];
  if (treeWidth !== undefined) blob.changesFileTreeWidth = treeWidth;
  return blob;
}

/**
 * Non-task entity ids that share the Changes-panel setters (the create dialogs
 * and the Command Terminal) but have no `tasks` row to persist into. They must
 * not schedule a `detail_view_state` save: the DB UPDATE would be a no-op, and
 * the Command Terminal would otherwise emit a spurious IPC write on every Changes
 * interaction.
 */
const NON_TASK_DETAIL_VIEW_IDS = new Set(['new-task-dialog', 'new-backlog-task-dialog', 'command-terminal']);

/**
 * Schedule a debounced persist of a task's detail-view layout. Captures the
 * project id at interaction time (project-scoped-ipc rule) and the latest blob.
 * Sentinel (non-task) ids are ignored - they have no `tasks` row to write.
 */
function scheduleDetailViewSave(taskId: string, get: () => SessionStore): void {
  if (NON_TASK_DETAIL_VIEW_IDS.has(taskId)) return;
  const projectId = useProjectStore.getState().currentProject?.id ?? null;
  detailViewPendingSaves.set(taskId, { state: buildDetailViewBlob(get(), taskId), projectId });
  const existing = detailViewSaveTimers.get(taskId);
  if (existing) clearTimeout(existing);
  detailViewSaveTimers.set(taskId, setTimeout(() => flushDetailViewSave(taskId), DETAIL_VIEW_SAVE_DEBOUNCE_MS));
}

// HMR (Pattern A flavor): flush every pending save before this module is
// replaced so an edit made mid-debounce is not lost on Fast Refresh.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
import.meta.hot?.dispose(() => {
  for (const taskId of [...detailViewPendingSaves.keys()]) flushDetailViewSave(taskId);
});

/**
 * UI state for the Task Detail dialog's terminal / right-panel area, keyed by
 * task ID. Tracks which tasks have the Changes panel open, the selected file
 * inside it, the split-vs-expanded view mode, the draggable divider ratio, which
 * tasks have the Browser pane open, and which tasks are maximized. State persists
 * across dialog open/close, and (via the per-task `detail_view_state` blob)
 * across app restarts: each setter schedules a debounced save, and
 * `hydrateDetailViewStateForTasks` seeds it back on load.
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
  hydratedDetailViewTasks: new Set<string>(),

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
    scheduleDetailViewSave(taskId, get);
  },

  toggleBrowserOpen: (taskId) => {
    const next = new Set(get().browserOpenTasks);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    set({ browserOpenTasks: next });
    scheduleDetailViewSave(taskId, get);
  },

  toggleMaximized: (taskId) => {
    const next = new Set(get().maximizedTasks);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    set({ maximizedTasks: next });
    // Not persisted in detail_view_state: this set only keys the create-dialog
    // sentinels now (the task-detail window's maximize is window-manager state,
    // persisted via AppConfig.workspaceByProject).
  },

  setChangesViewMode: (taskId, mode) => {
    set({ changesViewMode: { ...get().changesViewMode, [taskId]: mode } });
    scheduleDetailViewSave(taskId, get);
  },

  setDividerRatio: (taskId, ratio) => {
    set({ dividerRatio: { ...get().dividerRatio, [taskId]: ratio } });
    scheduleDetailViewSave(taskId, get);
  },

  setChangesScope: (taskId, scope) => {
    set({ changesScope: { ...get().changesScope, [taskId]: scope } });
    scheduleDetailViewSave(taskId, get);
  },

  setChangesFileTreeWidth: (taskId, width) => {
    set({ changesFileTreeWidth: { ...get().changesFileTreeWidth, [taskId]: width } });
    scheduleDetailViewSave(taskId, get);
  },

  toggleChangesFileViewed: (taskId, filePath) => {
    const next = new Set(get().changesViewedFiles[taskId] ?? []);
    if (next.has(filePath)) {
      next.delete(filePath);
    } else {
      next.add(filePath);
    }
    set({ changesViewedFiles: { ...get().changesViewedFiles, [taskId]: next } });
    scheduleDetailViewSave(taskId, get);
  },

  markChangesFileViewed: (taskId, filePath) => {
    const current = get().changesViewedFiles[taskId];
    if (current?.has(filePath)) return; // already viewed; no-op (idempotent)
    const next = new Set(current ?? []);
    next.add(filePath);
    set({ changesViewedFiles: { ...get().changesViewedFiles, [taskId]: next } });
    scheduleDetailViewSave(taskId, get);
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
    scheduleDetailViewSave(taskId, get);
  },

  hydrateDetailViewStateForTasks: (tasks) => {
    const alreadyHydrated = get().hydratedDetailViewTasks;
    const unseen = tasks.filter((task) => !alreadyHydrated.has(task.id));
    if (unseen.length === 0) return;
    // Mark EVERY newly-seen task hydrated (even null-blob ones) so a later board
    // refresh never re-hydrates and clobbers live edits.
    const hydratedDetailViewTasks = new Set(alreadyHydrated);
    for (const task of unseen) hydratedDetailViewTasks.add(task.id);

    const pending = unseen.filter((task) => task.detail_view_state);
    if (pending.length === 0) {
      set({ hydratedDetailViewTasks });
      return;
    }

    const changesOpenTasks = new Set(get().changesOpenTasks);
    const browserOpenTasks = new Set(get().browserOpenTasks);
    const changesViewMode = { ...get().changesViewMode };
    const changesSelectedFile = { ...get().changesSelectedFile };
    const changesViewedFiles = { ...get().changesViewedFiles };
    const changesScope = { ...get().changesScope };
    const changesFileTreeWidth = { ...get().changesFileTreeWidth };
    const dividerRatio = { ...get().dividerRatio };

    for (const task of pending) {
      let blob: TaskDetailViewState;
      try {
        blob = JSON.parse(task.detail_view_state as string) as TaskDetailViewState;
      } catch {
        continue; // malformed; already marked hydrated so we won't retry
      }
      if (blob.dividerRatio !== undefined) dividerRatio[task.id] = blob.dividerRatio;
      if (blob.changesOpen) changesOpenTasks.add(task.id);
      if (blob.browserOpen) browserOpenTasks.add(task.id);
      if (blob.changesViewMode !== undefined) changesViewMode[task.id] = blob.changesViewMode;
      if (blob.changesSelectedFile !== undefined) changesSelectedFile[task.id] = blob.changesSelectedFile;
      if (blob.changesViewedFiles && blob.changesViewedFiles.length > 0) {
        changesViewedFiles[task.id] = new Set(blob.changesViewedFiles);
      }
      if (blob.changesScope !== undefined) changesScope[task.id] = blob.changesScope;
      if (blob.changesFileTreeWidth !== undefined) changesFileTreeWidth[task.id] = blob.changesFileTreeWidth;
    }

    set({
      hydratedDetailViewTasks,
      changesOpenTasks,
      browserOpenTasks,
      changesViewMode,
      changesSelectedFile,
      changesViewedFiles,
      changesScope,
      changesFileTreeWidth,
      dividerRatio,
    });
  },
});
