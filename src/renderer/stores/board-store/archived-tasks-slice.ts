import { type StateCreator } from 'zustand';
import type { Task, TaskUnarchiveInput, TaskBulkDeleteProgress } from '../../../shared/types';
import { useSessionStore } from '../session-store';
import { useToastStore } from '../toast-store';
import { applyStructuralSharing } from './structural-sharing';
import type { BoardStore } from './types';

export interface ArchivedTasksSlice {
  archivedTasks: Task[];
  /** Non-null while a bulk delete is in flight; rendered as a progress indicator. */
  bulkDeleteProgress: TaskBulkDeleteProgress | null;
  loadArchivedTasks: () => Promise<void>;
  archiveTask: (id: string) => void;
  unarchiveTask: (input: TaskUnarchiveInput) => Promise<void>;
  deleteArchivedTask: (id: string) => Promise<void>;
  bulkDeleteArchivedTasks: (ids: string[]) => Promise<void>;
  bulkUnarchiveTasks: (ids: string[], targetSwimlaneId: string) => Promise<void>;
}

export const createArchivedTasksSlice: StateCreator<BoardStore, [], [], ArchivedTasksSlice> = (set, get) => ({
  archivedTasks: [],
  bulkDeleteProgress: null,

  loadArchivedTasks: async () => {
    const archivedTasks = await window.electronAPI.tasks.listArchived();
    set({ archivedTasks });
  },

  archiveTask: (id) => {
    // Optimistic: move from tasks to archivedTasks
    set((s) => {
      const task = s.tasks.find((t) => t.id === id);
      if (!task) return s;
      const archived = { ...task, archived_at: new Date().toISOString() };
      return {
        tasks: s.tasks.filter((t) => t.id !== id),
        archivedTasks: [archived, ...s.archivedTasks],
      };
    });
  },

  unarchiveTask: async (input) => {
    const previousTasks = get().tasks;
    const previousArchivedTasks = get().archivedTasks;
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
    }));

    // Backend always attempts resume first on unarchive from Done; if no
    // suspended session record exists it falls back to fresh spawn. Either
    // way the badge should appear immediately to match moveTask's UX.
    if (targetLane?.auto_spawn) {
      useSessionStore.getState().setSpawnProgress(input.id, 'Resuming agent...');
    }

    try {
      await window.electronAPI.tasks.unarchive(input);

      const [nextTasks, nextArchivedTasks] = await Promise.all([
        window.electronAPI.tasks.list(),
        window.electronAPI.tasks.listArchived(),
      ]);
      set((state) => ({
        tasks: applyStructuralSharing(state.tasks, nextTasks),
        archivedTasks: applyStructuralSharing(state.archivedTasks, nextArchivedTasks),
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
      set({ tasks: previousTasks, archivedTasks: previousArchivedTasks });
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
    // Optimistic: remove from archivedTasks
    set((s) => ({
      archivedTasks: s.archivedTasks.filter((t) => t.id !== id),
    }));
    try {
      await window.electronAPI.tasks.delete(id);
      // Also clean up sessions in session store
      useSessionStore.setState((s) => ({
        sessions: s.sessions.filter((session) => session.taskId !== id),
      }));
    } catch (err) {
      // Revert optimistic removal so stale tasks don't reappear on next load
      set({ archivedTasks: prevArchived });
      useToastStore.getState().addToast({
        message: `Failed to delete task: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
    }
  },

  bulkDeleteArchivedTasks: async (ids) => {
    const prevArchived = get().archivedTasks;
    const idSet = new Set(ids);
    // Optimistic removal
    set((state) => ({
      archivedTasks: state.archivedTasks.filter((task) => !idSet.has(task.id)),
      bulkDeleteProgress: { completed: 0, total: ids.length, failures: [] },
    }));

    // Subscribe to per-task progress events so the UI can show a running
    // counter during long deletes (hundreds of tasks with worktree cleanup).
    const unsubscribe = window.electronAPI.tasks.onBulkDeleteProgress((progress) => {
      set({ bulkDeleteProgress: progress });
    });

    try {
      const result = await window.electronAPI.tasks.bulkDelete(ids);

      // Always clear sessions for fully-deleted tasks. Partial-failure tasks
      // still had their DB row deleted (cleanup just left worktree files
      // behind), so dropping the session is correct either way.
      useSessionStore.setState((state) => ({
        sessions: state.sessions.filter((session) => !idSet.has(session.taskId)),
      }));

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
      set({ archivedTasks: prevArchived });
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
    const idSet = new Set(ids);
    // Optimistic removal from archived
    set((state) => ({
      archivedTasks: state.archivedTasks.filter((task) => !idSet.has(task.id)),
    }));
    try {
      await window.electronAPI.tasks.bulkUnarchive(ids, targetSwimlaneId);
      // Reload tasks (sessions arrive via push-based session-changed events)
      const tasks = await window.electronAPI.tasks.list();
      set({ tasks });

      const targetLane = get().swimlanes.find((lane) => lane.id === targetSwimlaneId);
      useToastStore.getState().addToast({
        message: `${ids.length} tasks restored to ${targetLane?.name || 'board'}`,
        variant: 'success',
      });
    } catch (error) {
      set({ archivedTasks: prevArchived });
      await get().loadBoard();
      useToastStore.getState().addToast({
        message: `Failed to restore tasks: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: 'error',
      });
    }
  },
});
