import { type StateCreator } from 'zustand';
import type { Task, TaskUnarchiveInput } from '../../../shared/types';
import { useSessionStore } from '../session-store';
import { useToastStore } from '../toast-store';
import type { BoardStore } from './types';

export interface ArchivedTasksSlice {
  archivedTasks: Task[];
  loadArchivedTasks: () => Promise<void>;
  archiveTask: (id: string) => void;
  unarchiveTask: (input: TaskUnarchiveInput) => Promise<void>;
  deleteArchivedTask: (id: string) => Promise<void>;
  bulkDeleteArchivedTasks: (ids: string[]) => Promise<void>;
  bulkUnarchiveTasks: (ids: string[], targetSwimlaneId: string) => Promise<void>;
}

export const createArchivedTasksSlice: StateCreator<BoardStore, [], [], ArchivedTasksSlice> = (set, get) => ({
  archivedTasks: [],

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
    const taskTitle = get().archivedTasks.find((t) => t.id === input.id)?.title;

    // Optimistic: remove from archivedTasks
    set((s) => ({
      archivedTasks: s.archivedTasks.filter((t) => t.id !== input.id),
    }));

    await window.electronAPI.tasks.unarchive(input);

    // Reload tasks (sessions arrive via push-based session-changed events)
    const tasks = await window.electronAPI.tasks.list();
    set({ tasks });

    const targetLane = get().swimlanes.find((s) => s.id === input.targetSwimlaneId);
    useToastStore.getState().addToast({
      message: `"${taskTitle}" restored to ${targetLane?.name || 'board'}`,
      variant: 'success',
    });

    // Detect if the unarchived task got a session (transition engine fired).
    // Unarchiving from Done always attempts to resume the suspended session,
    // preserving Claude's conversation history via --resume.
    const restoredTask = tasks.find((t) => t.id === input.id);
    if (restoredTask?.session_id) {
      useSessionStore.setState({ activeSessionId: restoredTask.session_id });
      useToastStore.getState().addToast({
        message: `Agent resumed for "${restoredTask.title}"`,
        variant: 'success',
      });
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
    }));
    try {
      await window.electronAPI.tasks.bulkDelete(ids);
      // Clean up sessions
      useSessionStore.setState((state) => ({
        sessions: state.sessions.filter((session) => !idSet.has(session.taskId)),
      }));
    } catch (error) {
      set({ archivedTasks: prevArchived });
      useToastStore.getState().addToast({
        message: `Failed to delete tasks: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: 'error',
      });
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
