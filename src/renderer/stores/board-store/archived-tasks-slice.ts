import { type StateCreator } from 'zustand';
import type { Task, TaskUnarchiveInput, TaskBulkDeleteProgress } from '../../../shared/types';
import { useSessionStore } from '../session-store';
import { withoutSessionsForTasks } from '../session-store/session-index';
import { useToastStore } from '../toast-store';
import { useProjectStore } from '../project-store';
import { applyStructuralSharing } from './structural-sharing';
import type { BoardStore } from './types';

/**
 * How many of the newest archived tasks the board hydrates for the Done
 * column's inline preview. Also the render cap in `DoneSwimlane`. The full
 * archive loads lazily only when a consumer (the Completed dialog, or a
 * detail window anchored to a deep archived task) is mounted.
 */
export const ARCHIVED_PREVIEW_LIMIT = 15;

/**
 * Collapses concurrent full-archive fetches into one round-trip. Several
 * consumers can request the full list at once (the Completed dialog mounting,
 * a deep-anchor detail window, loadBoard's out-of-band refresh, and React's
 * StrictMode double-invoking the mount effect in dev). Without this each would
 * fire its own ~1.2MB `listArchived`. This is an in-flight de-dupe, NOT a cache:
 * once the fetch resolves the flag clears, so the next call fetches fresh. It is
 * tagged with the project the fetch was started for so a different-project caller
 * never joins it and a result that resolves after a project switch is dropped
 * rather than applied to (and latched onto) the wrong project.
 */
// hmr-safe: transient in-flight guard; a reset-on-HMR just permits a fresh fetch.
let archivedFullLoad: { projectId: string | null; promise: Promise<void> } | null = null;

/**
 * Fetch the archived data appropriate to the current load state. When the full
 * archive is already loaded (a viewer is open), refetch the full list so the
 * open dialog reconciles against agent-driven archives; otherwise fetch only
 * the cheap newest-N preview. Exported for reconcile call sites in
 * `task-slice.ts`. Deliberately NOT named `load*`/`sync*` so the HMR re-sync
 * method scan (`hmr-resync.test.ts`) never treats it as a store load method.
 */
export async function fetchArchivedReconcile(
  fullyLoaded: boolean,
): Promise<{ tasks: Task[]; totalCount: number }> {
  if (fullyLoaded) {
    const tasks = await window.electronAPI.tasks.listArchived();
    return { tasks, totalCount: tasks.length };
  }
  const preview = await window.electronAPI.tasks.listArchivedPreview(ARCHIVED_PREVIEW_LIMIT);
  return { tasks: preview.tasks, totalCount: preview.totalCount };
}

export interface ArchivedTasksSlice {
  /** "What we have": the newest-N preview, or the full archive once loaded. */
  archivedTasks: Task[];
  /** Authoritative total archived count, source of truth for every header/badge. */
  archivedTotalCount: number;
  /** True while `archivedTasks` holds the full archive rather than the preview. */
  archivedFullyLoaded: boolean;
  /**
   * Refcount of mounted consumers that need the FULL archive (the Completed
   * dialog, deep-anchor detail windows). While > 0, board hydration keeps the
   * full list; when it drops to 0 the next hydration downgrades to the preview.
   * Refcounted purely by mount/unmount and never reset by a project switch.
   */
  archiveViewers: number;
  /** Non-null while a bulk delete is in flight; rendered as a progress indicator. */
  bulkDeleteProgress: TaskBulkDeleteProgress | null;
  loadArchivedTasks: () => Promise<void>;
  acquireArchiveView: () => void;
  releaseArchiveView: () => void;
  archiveTask: (id: string) => void;
  unarchiveTask: (input: TaskUnarchiveInput) => Promise<void>;
  deleteArchivedTask: (id: string) => Promise<void>;
  bulkDeleteArchivedTasks: (ids: string[]) => Promise<void>;
  bulkUnarchiveTasks: (ids: string[], targetSwimlaneId: string) => Promise<void>;
}

export const createArchivedTasksSlice: StateCreator<BoardStore, [], [], ArchivedTasksSlice> = (set, get) => ({
  archivedTasks: [],
  archivedTotalCount: 0,
  archivedFullyLoaded: false,
  archiveViewers: 0,
  bulkDeleteProgress: null,

  loadArchivedTasks: async () => {
    const projectId = useProjectStore.getState().currentProject?.id ?? null;
    // Join an in-flight fetch for the SAME project instead of starting a
    // redundant one (see archivedFullLoad).
    if (archivedFullLoad && archivedFullLoad.projectId === projectId) return archivedFullLoad.promise;
    const promise = window.electronAPI.tasks.listArchived()
      .then((fullList) => {
        // Drop a result that resolved after a project switch: applying project
        // A's archive to project B (and latching archivedFullyLoaded) would show
        // the wrong data and suppress B's own correctly-scoped load.
        if ((useProjectStore.getState().currentProject?.id ?? null) !== projectId) return;
        // Structural sharing keeps the preview objects' identity when the full
        // list lands, so their already-mounted TaskCards don't churn.
        set((state) => ({
          archivedTasks: applyStructuralSharing(state.archivedTasks, fullList),
          archivedTotalCount: fullList.length,
          archivedFullyLoaded: true,
        }));
      })
      .finally(() => {
        // Clear the marker only if it is still ours (a project switch mid-flight
        // may have replaced it).
        if (archivedFullLoad?.promise === promise) archivedFullLoad = null;
      });
    archivedFullLoad = { projectId, promise };
    return promise;
  },

  acquireArchiveView: () => {
    set((state) => ({ archiveViewers: state.archiveViewers + 1 }));
  },

  releaseArchiveView: () => {
    set((state) => ({ archiveViewers: Math.max(0, state.archiveViewers - 1) }));
  },

  archiveTask: (id) => {
    // Optimistic: move from tasks to archivedTasks
    set((s) => {
      const task = s.tasks.find((t) => t.id === id);
      if (!task) return s;
      const archived = { ...task, archived_at: new Date().toISOString() };
      // Prepend keeps the newly-archived card at the front of the preview (it is
      // the newest by archived_at). DoneSwimlane slices to ARCHIVED_PREVIEW_LIMIT,
      // so a transient 16th preview entry is harmless.
      return {
        tasks: s.tasks.filter((t) => t.id !== id),
        archivedTasks: [archived, ...s.archivedTasks],
        archivedTotalCount: s.archivedTotalCount + 1,
      };
    });
  },

  unarchiveTask: async (input) => {
    const previousTasks = get().tasks;
    const previousArchivedTasks = get().archivedTasks;
    const previousArchivedTotalCount = get().archivedTotalCount;
    const archivedRecord = previousArchivedTasks.find((t) => t.id === input.id);
    if (!archivedRecord) return;

    const targetLane = get().swimlanes.find((lane) => lane.id === input.targetSwimlaneId);
    const endOfLanePosition = previousTasks.filter((t) => t.swimlane_id === input.targetSwimlaneId).length;
    const optimisticTask: Task = {
      ...archivedRecord,
      archived_at: null,
      swimlane_id: input.targetSwimlaneId,
      position: endOfLanePosition,
    };

    // Symmetric optimistic update: insert into tasks[] and remove from
    // archivedTasks[] in one set() so the card is continuously present in
    // some list. Without this, dnd-kit's DragOverlay has no handoff target
    // during the IPC window and animates back to Done.
    set((state) => ({
      tasks: [...state.tasks, optimisticTask],
      archivedTasks: state.archivedTasks.filter((t) => t.id !== input.id),
      archivedTotalCount: Math.max(0, state.archivedTotalCount - 1),
    }));

    // Backend always attempts resume first on unarchive from Done; if no
    // suspended session record exists it falls back to fresh spawn. Either
    // way the badge should appear immediately to match moveTask's UX.
    if (targetLane?.auto_spawn) {
      useSessionStore.getState().setSpawnProgress(input.id, 'Resuming agent...');
    }

    try {
      await window.electronAPI.tasks.unarchive(input, useProjectStore.getState().currentProject?.id ?? null);

      const [nextTasks, archivedReconcile] = await Promise.all([
        window.electronAPI.tasks.list(),
        fetchArchivedReconcile(get().archivedFullyLoaded),
      ]);
      set((state) => ({
        tasks: applyStructuralSharing(state.tasks, nextTasks),
        archivedTasks: applyStructuralSharing(state.archivedTasks, archivedReconcile.tasks),
        archivedTotalCount: archivedReconcile.totalCount,
      }));

      useToastStore.getState().addToast({
        message: `"${archivedRecord.title}" restored to ${targetLane?.name || 'board'}`,
        variant: 'success',
      });

      // Detect if the unarchived task got a session (transition engine fired).
      // Unarchiving from Done always attempts to resume the suspended session,
      // preserving Claude's conversation history via --resume.
      const restoredTask = nextTasks.find((t) => t.id === input.id);
      if (restoredTask?.session_id) {
        useSessionStore.setState({ activeSessionId: restoredTask.session_id });
        useToastStore.getState().addToast({
          message: `Agent resumed for "${restoredTask.title}"`,
          variant: 'success',
        });
      }
    } catch (err) {
      // Snapshot restore for immediate visual revert, then loadBoard() to
      // reconcile against concurrent ops that may have mutated either array
      // during the await window. Matches the pattern in bulkUnarchiveTasks.
      set({
        tasks: previousTasks,
        archivedTasks: previousArchivedTasks,
        archivedTotalCount: previousArchivedTotalCount,
      });
      await get().loadBoard();
      useToastStore.getState().addToast({
        message: `Failed to restore task: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
    } finally {
      // Backend unarchive handler awaits the full spawn flow before returning,
      // so by the time we're here the session is either attached or isn't -
      // no reason to leave an optimistic "Resuming agent..." badge stuck.
      useSessionStore.getState().setSpawnProgress(input.id, null);
    }
  },

  deleteArchivedTask: async (id) => {
    // Snapshot for rollback
    const prevArchived = get().archivedTasks;
    const prevArchivedTotalCount = get().archivedTotalCount;
    // Optimistic: remove from archivedTasks (decrement only when we actually
    // held the row, so a preview miss doesn't skew the count).
    set((s) => {
      const held = s.archivedTasks.some((t) => t.id === id);
      return {
        archivedTasks: s.archivedTasks.filter((t) => t.id !== id),
        archivedTotalCount: held ? Math.max(0, s.archivedTotalCount - 1) : s.archivedTotalCount,
      };
    });
    try {
      await window.electronAPI.tasks.delete(id, useProjectStore.getState().currentProject?.id ?? null);
      // Also clean up sessions in session store
      useSessionStore.setState((s) => withoutSessionsForTasks(s.sessions, id));
    } catch (err) {
      // Revert optimistic removal so stale tasks don't reappear on next load
      set({ archivedTasks: prevArchived, archivedTotalCount: prevArchivedTotalCount });
      useToastStore.getState().addToast({
        message: `Failed to delete task: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
    }
  },

  bulkDeleteArchivedTasks: async (ids) => {
    const prevArchived = get().archivedTasks;
    const prevArchivedTotalCount = get().archivedTotalCount;
    const idSet = new Set(ids);
    // Optimistic removal. Decrement by the number of rows we actually held, so
    // ids not present in a preview don't skew the count.
    set((state) => {
      const removedCount = state.archivedTasks.filter((task) => idSet.has(task.id)).length;
      return {
        archivedTasks: state.archivedTasks.filter((task) => !idSet.has(task.id)),
        archivedTotalCount: Math.max(0, state.archivedTotalCount - removedCount),
        bulkDeleteProgress: { completed: 0, total: ids.length, failures: [] },
      };
    });

    // Subscribe to per-task progress events so the UI can show a running
    // counter during long deletes (hundreds of tasks with worktree cleanup).
    const unsubscribe = window.electronAPI.tasks.onBulkDeleteProgress((progress) => {
      set({ bulkDeleteProgress: progress });
    });

    try {
      const result = await window.electronAPI.tasks.bulkDelete(ids, useProjectStore.getState().currentProject?.id ?? null);

      // Always clear sessions for fully-deleted tasks. Partial-failure tasks
      // still had their DB row deleted (cleanup just left worktree files
      // behind), so dropping the session is correct either way.
      useSessionStore.setState((state) => withoutSessionsForTasks(state.sessions, idSet));

      if (result.failures.length > 0) {
        // Partial success: keep the successfully deleted tasks removed from
        // the dialog, surface the failure count.
        useToastStore.getState().addToast({
          message: `Deleted ${result.deleted} task${result.deleted === 1 ? '' : 's'}. `
            + `Failed to clean up ${result.failures.length} worktree${result.failures.length === 1 ? '' : 's'} - check logs.`,
          variant: 'error',
        });
      }
    } catch (error) {
      // Hard failure (IPC threw - e.g. no project open). Revert optimistic
      // removal since we can't trust any partial state.
      set({ archivedTasks: prevArchived, archivedTotalCount: prevArchivedTotalCount });
      useToastStore.getState().addToast({
        message: `Failed to delete tasks: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: 'error',
      });
    } finally {
      unsubscribe();
      set({ bulkDeleteProgress: null });
    }
  },

  bulkUnarchiveTasks: async (ids, targetSwimlaneId) => {
    const prevArchived = get().archivedTasks;
    const prevArchivedTotalCount = get().archivedTotalCount;
    const idSet = new Set(ids);
    // Optimistic removal from archived. Decrement by rows actually held.
    set((state) => {
      const removedCount = state.archivedTasks.filter((task) => idSet.has(task.id)).length;
      return {
        archivedTasks: state.archivedTasks.filter((task) => !idSet.has(task.id)),
        archivedTotalCount: Math.max(0, state.archivedTotalCount - removedCount),
      };
    });
    try {
      await window.electronAPI.tasks.bulkUnarchive(ids, targetSwimlaneId, useProjectStore.getState().currentProject?.id ?? null);
      // Reload tasks (sessions arrive via push-based session-changed events)
      const tasks = await window.electronAPI.tasks.list();
      set({ tasks });

      const targetLane = get().swimlanes.find((lane) => lane.id === targetSwimlaneId);
      useToastStore.getState().addToast({
        message: `${ids.length} tasks restored to ${targetLane?.name || 'board'}`,
        variant: 'success',
      });
    } catch (error) {
      set({ archivedTasks: prevArchived, archivedTotalCount: prevArchivedTotalCount });
      await get().loadBoard();
      useToastStore.getState().addToast({
        message: `Failed to restore tasks: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: 'error',
      });
    }
  },
});
