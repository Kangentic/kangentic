import { type StateCreator } from 'zustand';
import { useToastStore } from '../toast-store';
import type { BoardStore, CompletingTask } from './types';

export interface TaskCompletionSlice {
  completingTask: CompletingTask | null;
  recentlyArchivedId: string | null;
  /** Task IDs currently being completed via a Done drop (from setCompletingTask
   *  until after moveTask's IPC+reload resolves). Superset of `completingTask`:
   *  the singular field drives the FlyingCard animation for the active drop,
   *  while this Set lets DoneSwimlane filter out any task whose archive is
   *  still in-flight. A racing loadBoard() between task-move.ts's tasks.move()
   *  and tasks.archive() can otherwise re-inject the task into the dropzone
   *  with swimlane_id = Done. */
  completingTaskIds: Set<string>;
  setCompletingTask: (task: CompletingTask | null) => void;
  finalizeCompletion: () => Promise<void>;
  clearRecentlyArchived: () => void;
  addCompletingTaskId: (taskId: string) => void;
  removeCompletingTaskId: (taskId: string) => void;
}

export const createTaskCompletionSlice: StateCreator<BoardStore, [], [], TaskCompletionSlice> = (set, get) => ({
  completingTask: null,
  recentlyArchivedId: null,
  completingTaskIds: new Set<string>(),

  setCompletingTask: (task) => {
    // If another task is already completing, finalize it immediately
    const previousCompleting = get().completingTask;
    if (previousCompleting) {
      get().finalizeCompletion();
    }
    // Remove the task from the tasks array so no column renders it during flight.
    // Also add to completingTaskIds so DoneSwimlane filters it out even if a
    // racing loadBoard() re-injects it with swimlane_id = Done before
    // tasks.archive() runs in the main process.
    set((s) => {
      if (!task) {
        return { completingTask: null };
      }
      const nextIds = new Set(s.completingTaskIds);
      nextIds.add(task.taskId);
      return {
        completingTask: task,
        tasks: s.tasks.filter((t) => t.id !== task.taskId),
        completingTaskIds: nextIds,
      };
    });
  },

  finalizeCompletion: async () => {
    const completing = get().completingTask;
    if (!completing) return;

    const { taskId, targetSwimlaneId, targetPosition } = completing;
    const taskTitle = completing.task.title;

    // Clear completingTask synchronously at entry so a subsequent drop can't
    // be clobbered by this finalizer's later resolution. The DoneSwimlane
    // filter relies on completingTaskIds (released in `finally`), not on
    // completingTask, so the dropzone race is still covered end-to-end.
    set({ completingTask: null });

    try {
      await get().moveTask({ taskId, targetSwimlaneId, targetPosition });
      set({ recentlyArchivedId: taskId });
      useToastStore.getState().addToast({
        message: `"${taskTitle}" completed and archived`,
        variant: 'success',
      });
    } catch (err) {
      await get().loadBoard();
      useToastStore.getState().addToast({
        message: `Failed to complete task: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
    } finally {
      get().removeCompletingTaskId(taskId);
    }
  },

  clearRecentlyArchived: () => {
    set({ recentlyArchivedId: null });
  },

  addCompletingTaskId: (taskId) => {
    set((s) => {
      if (s.completingTaskIds.has(taskId)) return s;
      const next = new Set(s.completingTaskIds);
      next.add(taskId);
      return { completingTaskIds: next };
    });
  },

  removeCompletingTaskId: (taskId) => {
    set((s) => {
      if (!s.completingTaskIds.has(taskId)) return s;
      const next = new Set(s.completingTaskIds);
      next.delete(taskId);
      return { completingTaskIds: next };
    });
  },
});
