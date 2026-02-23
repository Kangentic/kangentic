import { create } from 'zustand';
import type { Task, Swimlane, TaskCreateInput, TaskUpdateInput, TaskMoveInput, SwimlaneCreateInput, SwimlaneUpdateInput } from '../../shared/types';
import { useSessionStore } from './session-store';

interface BoardStore {
  tasks: Task[];
  swimlanes: Swimlane[];
  loading: boolean;

  loadBoard: () => Promise<void>;

  // Tasks
  createTask: (input: TaskCreateInput) => Promise<Task>;
  updateTask: (input: TaskUpdateInput) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  moveTask: (input: TaskMoveInput) => Promise<void>;
  getTasksBySwimlane: (swimlaneId: string) => Task[];

  // Swimlanes
  createSwimlane: (input: SwimlaneCreateInput) => Promise<Swimlane>;
  updateSwimlane: (input: SwimlaneUpdateInput) => Promise<Swimlane>;
  deleteSwimlane: (id: string) => Promise<void>;
  reorderSwimlanes: (ids: string[]) => Promise<void>;
}

export const useBoardStore = create<BoardStore>((set, get) => ({
  tasks: [],
  swimlanes: [],
  loading: false,

  loadBoard: async () => {
    set({ loading: true });
    const [tasks, swimlanes] = await Promise.all([
      window.electronAPI.tasks.list(),
      window.electronAPI.swimlanes.list(),
    ]);
    set({ tasks, swimlanes, loading: false });
  },

  createTask: async (input) => {
    const task = await window.electronAPI.tasks.create(input);
    set((s) => ({ tasks: [...s.tasks, task] }));
    return task;
  },

  updateTask: async (input) => {
    const task = await window.electronAPI.tasks.update(input);
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === task.id ? task : t)) }));
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
    // Reload tasks and sessions (transition engine may have spawned/killed sessions)
    const [tasks, sessions] = await Promise.all([
      window.electronAPI.tasks.list(),
      window.electronAPI.sessions.list(),
    ]);
    set({ tasks });
    const sessionStore = useSessionStore.getState();
    const prevCount = sessionStore.sessions.length;
    useSessionStore.setState({ sessions });
    // Auto-select newly spawned session
    if (sessions.length > prevCount) {
      const newest = sessions[sessions.length - 1];
      if (newest) useSessionStore.setState({ activeSessionId: newest.id });
    }
  },

  getTasksBySwimlane: (swimlaneId) => {
    return get().tasks
      .filter((t) => t.swimlane_id === swimlaneId)
      .sort((a, b) => a.position - b.position);
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
    await window.electronAPI.swimlanes.reorder(ids);
    set((s) => ({
      swimlanes: ids.map((id, index) => {
        const lane = s.swimlanes.find((l) => l.id === id)!;
        return { ...lane, position: index };
      }),
    }));
  },
}));
