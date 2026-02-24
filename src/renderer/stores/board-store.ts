import { create } from 'zustand';
import type { Task, Swimlane, TaskCreateInput, TaskUpdateInput, TaskMoveInput, TaskUnarchiveInput, SwimlaneCreateInput, SwimlaneUpdateInput } from '../../shared/types';
import { useSessionStore } from './session-store';
import { useToastStore } from './toast-store';

interface CompletingTask {
  taskId: string;
  targetSwimlaneId: string;
  targetPosition: number;
  originSwimlaneId: string;
  task: Task;
  startRect: { left: number; top: number; width: number; height: number };
}

interface BoardStore {
  tasks: Task[];
  swimlanes: Swimlane[];
  archivedTasks: Task[];
  loading: boolean;

  // Completion animation state
  completingTask: CompletingTask | null;
  recentlyArchivedId: string | null;

  loadBoard: () => Promise<void>;

  // Tasks
  createTask: (input: TaskCreateInput) => Promise<Task>;
  updateTask: (input: TaskUpdateInput) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  moveTask: (input: TaskMoveInput) => Promise<void>;
  getTasksBySwimlane: (swimlaneId: string) => Task[];

  // Archive
  loadArchivedTasks: () => Promise<void>;
  archiveTask: (id: string) => void;
  unarchiveTask: (input: TaskUnarchiveInput) => Promise<void>;
  deleteArchivedTask: (id: string) => Promise<void>;

  // Completion animation
  setCompletingTask: (task: CompletingTask | null) => void;
  finalizeCompletion: () => Promise<void>;
  clearRecentlyArchived: () => void;

  // Swimlanes
  createSwimlane: (input: SwimlaneCreateInput) => Promise<Swimlane>;
  updateSwimlane: (input: SwimlaneUpdateInput) => Promise<Swimlane>;
  deleteSwimlane: (id: string) => Promise<void>;
  reorderSwimlanes: (ids: string[]) => Promise<void>;
}

export const useBoardStore = create<BoardStore>((set, get) => ({
  tasks: [],
  swimlanes: [],
  archivedTasks: [],
  loading: false,
  completingTask: null,
  recentlyArchivedId: null,

  loadBoard: async () => {
    set({ loading: true });
    const [tasks, swimlanes, archivedTasks] = await Promise.all([
      window.electronAPI.tasks.list(),
      window.electronAPI.swimlanes.list(),
      window.electronAPI.tasks.listArchived(),
    ]);
    set({ tasks, swimlanes, archivedTasks, loading: false });
  },

  createTask: async (input) => {
    const task = await window.electronAPI.tasks.create(input);
    set((s) => ({ tasks: [...s.tasks, task] }));
    return task;
  },

  updateTask: async (input) => {
    const task = await window.electronAPI.tasks.update(input);
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === task.id ? task : t)),
      archivedTasks: s.archivedTasks.map((t) => (t.id === task.id ? task : t)),
    }));
    return task;
  },

  deleteTask: async (id) => {
    await window.electronAPI.tasks.delete(id);
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    // Remove ALL sessions for this task from the session store
    useSessionStore.setState((s) => ({
      sessions: s.sessions.filter((sess) => sess.taskId !== id),
    }));
  },

  moveTask: async (input) => {
    // Capture the task's current session before the move
    const prevTask = get().tasks.find((t) => t.id === input.taskId);
    const prevSessionId = prevTask?.session_id ?? null;

    // Optimistic update
    set((s) => {
      const tasks = [...s.tasks];
      const taskIndex = tasks.findIndex((t) => t.id === input.taskId);
      if (taskIndex < 0) return s;

      const task = { ...tasks[taskIndex] };
      task.swimlane_id = input.targetSwimlaneId;
      task.position = input.targetPosition;
      tasks[taskIndex] = task;

      return { tasks };
    });

    await window.electronAPI.tasks.move(input);
    // Reload tasks, archived tasks, and sessions (transition engine may have spawned/killed sessions)
    const [tasks, archivedTasks, sessions] = await Promise.all([
      window.electronAPI.tasks.list(),
      window.electronAPI.tasks.listArchived(),
      window.electronAPI.sessions.list(),
    ]);
    set({ tasks, archivedTasks });
    useSessionStore.setState({ sessions });

    // Detect if the moved task now has a new/different session
    const movedTask = tasks.find((t) => t.id === input.taskId);
    if (movedTask?.session_id && movedTask.session_id !== prevSessionId) {
      useSessionStore.setState({ activeSessionId: movedTask.session_id });
      const isResume = prevSessionId !== null;
      useToastStore.getState().addToast({
        message: isResume
          ? `Agent resumed for "${movedTask.title}"`
          : `Agent started for "${movedTask.title}"`,
        variant: 'success',
      });
    }
  },

  getTasksBySwimlane: (swimlaneId) => {
    return get().tasks
      .filter((t) => t.swimlane_id === swimlaneId)
      .sort((a, b) => a.position - b.position);
  },

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

    // Reload tasks and sessions (transition engine may have spawned sessions)
    const [tasks, sessions] = await Promise.all([
      window.electronAPI.tasks.list(),
      window.electronAPI.sessions.list(),
    ]);
    set({ tasks });

    const targetLane = get().swimlanes.find((s) => s.id === input.targetSwimlaneId);
    useToastStore.getState().addToast({
      message: `"${taskTitle}" restored to ${targetLane?.name || 'board'}`,
      variant: 'success',
    });

    useSessionStore.setState({ sessions });

    // Detect if the unarchived task got a session (transition engine fired)
    const restoredTask = tasks.find((t) => t.id === input.id);
    if (restoredTask?.session_id) {
      useSessionStore.setState({ activeSessionId: restoredTask.session_id });
      useToastStore.getState().addToast({
        message: `Agent started for "${restoredTask.title}"`,
        variant: 'success',
      });
    }
  },

  deleteArchivedTask: async (id) => {
    // Optimistic: remove from archivedTasks
    set((s) => ({
      archivedTasks: s.archivedTasks.filter((t) => t.id !== id),
    }));
    await window.electronAPI.tasks.delete(id);
    // Also clean up sessions in session store
    useSessionStore.setState((s) => ({
      sessions: s.sessions.filter((sess) => sess.taskId !== id),
    }));
  },

  setCompletingTask: (task) => {
    // If another task is already completing, finalize it immediately
    const prev = get().completingTask;
    if (prev) {
      get().finalizeCompletion();
    }
    // Remove the task from the tasks array so no column renders it during flight
    set((s) => ({
      completingTask: task,
      tasks: task ? s.tasks.filter((t) => t.id !== task.taskId) : s.tasks,
    }));
  },

  finalizeCompletion: async () => {
    const completing = get().completingTask;
    if (!completing) return;

    const { taskId, targetSwimlaneId, targetPosition } = completing;
    set({ completingTask: null });

    try {
      const taskTitle = completing.task.title;
      await get().moveTask({ taskId, targetSwimlaneId, targetPosition });
      set({ recentlyArchivedId: taskId });
      useToastStore.getState().addToast({
        message: `"${taskTitle}" completed and archived`,
        variant: 'success',
      });
    } catch (err) {
      // Recover: reload board and show error toast
      await get().loadBoard();
      useToastStore.getState().addToast({
        message: `Failed to complete task: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
    }
  },

  clearRecentlyArchived: () => {
    set({ recentlyArchivedId: null });
  },

  createSwimlane: async (input) => {
    const swimlane = await window.electronAPI.swimlanes.create(input);
    set((s) => ({ swimlanes: [...s.swimlanes, swimlane] }));
    return swimlane;
  },

  updateSwimlane: async (input) => {
    const swimlane = await window.electronAPI.swimlanes.update(input);
    set((s) => ({ swimlanes: s.swimlanes.map((l) => (l.id === swimlane.id ? swimlane : l)) }));
    return swimlane;
  },

  deleteSwimlane: async (id) => {
    await window.electronAPI.swimlanes.delete(id);
    set((s) => ({ swimlanes: s.swimlanes.filter((l) => l.id !== id) }));
  },

  reorderSwimlanes: async (ids) => {
    // Optimistic update: reorder in store immediately so dnd-kit's
    // transform release sees the correct DOM order (no snap-back).
    set((s) => ({
      swimlanes: ids.map((id, index) => {
        const lane = s.swimlanes.find((l) => l.id === id)!;
        return { ...lane, position: index };
      }),
    }));
    await window.electronAPI.swimlanes.reorder(ids);
  },
}));
