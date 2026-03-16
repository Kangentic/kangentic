import { create } from 'zustand';
import { arrayMove } from '@dnd-kit/sortable';
import type { Task, Swimlane, TaskCreateInput, TaskUpdateInput, TaskMoveInput, TaskUnarchiveInput, SwimlaneCreateInput, SwimlaneUpdateInput, ShortcutConfig } from '../../shared/types';
import { useConfigStore } from './config-store';
import { useSessionStore } from './session-store';
import { useToastStore } from './toast-store';
import { useProjectStore } from './project-store';

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
  shortcuts: (ShortcutConfig & { source: 'team' | 'local' })[];
  loading: boolean;
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  // Board config warnings (shown as banner when kangentic.json has errors)
  configWarnings: string[];
  pendingConfigChange: string | null; // projectId that changed, or null

  // Completion animation state
  completingTask: CompletingTask | null;
  recentlyArchivedId: string | null;

  loadBoard: () => Promise<void>;
  loadShortcuts: () => Promise<void>;

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
  bulkDeleteArchivedTasks: (ids: string[]) => Promise<void>;
  bulkUnarchiveTasks: (ids: string[], targetSwimlaneId: string) => Promise<void>;

  // Completion animation
  setCompletingTask: (task: CompletingTask | null) => void;
  finalizeCompletion: () => Promise<void>;
  clearRecentlyArchived: () => void;

  // Within-column reorder
  reorderTaskInColumn: (taskId: string, swimlaneId: string, activeId: string, overId: string) => Promise<void>;

  // Attachment count sync
  updateAttachmentCount: (taskId: string, delta: number) => void;

  // Swimlanes
  createSwimlane: (input: SwimlaneCreateInput) => Promise<Swimlane>;
  updateSwimlane: (input: SwimlaneUpdateInput) => Promise<Swimlane>;
  deleteSwimlane: (id: string) => Promise<void>;
  reorderSwimlanes: (ids: string[]) => Promise<void>;

  // Config warnings
  setConfigWarnings: (warnings: string[]) => void;
  dismissConfigWarnings: () => void;

  // Pending config change (file watcher detected external change)
  setPendingConfigChange: (projectId: string | null) => void;
  applyConfigChange: () => Promise<void>;
  dismissConfigChange: () => void;
}

/** Generation counter for stale reload protection.
 *  Each moveTask/reorderTaskInColumn increments before async work.
 *  After IPC completes, the reload is only applied if no newer move has started. */
let moveGeneration = 0;

export const useBoardStore = create<BoardStore>((set, get) => ({
  tasks: [],
  swimlanes: [],
  archivedTasks: [],
  shortcuts: [],
  loading: false,
  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),
  configWarnings: [],
  pendingConfigChange: null,
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

  createTask: async (input) => {
    const task = await window.electronAPI.tasks.create(input);
    set((s) => ({ tasks: [...s.tasks, task] }));

    // Mark first-run onboarding complete after the user's first task creation
    const { config, updateConfig } = useConfigStore.getState();
    if (!config.hasCompletedFirstRun) {
      updateConfig({ hasCompletedFirstRun: true });
    }

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
    // IPC first -- only update UI on success
    await window.electronAPI.tasks.delete(id);
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== id),
      archivedTasks: s.archivedTasks.filter((t) => t.id !== id),
    }));
    // Remove ALL sessions for this task from the session store
    useSessionStore.setState((s) => ({
      sessions: s.sessions.filter((sess) => sess.taskId !== id),
    }));
  },

  moveTask: async (input) => {
    const thisGen = ++moveGeneration;

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

    // If the task is changing columns and the target has an auto_command, set
    // pendingCommandLabel so the overlay shows the command name instead of
    // generic "Resuming agent...". Skip within-column reorders.
    const isColumnChange = prevTask?.swimlane_id !== input.targetSwimlaneId;
    const targetLane = get().swimlanes.find((s) => s.id === input.targetSwimlaneId);
    const targetAutoCommand = isColumnChange ? targetLane?.auto_command?.trim() : undefined;
    if (targetAutoCommand && targetLane?.auto_spawn) {
      useSessionStore.getState().setPendingCommandLabel(input.taskId, targetAutoCommand);
    }

    // Optimistically clear session for tasks moving to backlog
    // (the backend will destroy the session during TASK_MOVE via cleanupTaskSession)
    if (isColumnChange && targetLane?.role === 'backlog') {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.filter((session) => session.taskId !== input.taskId),
      }));
    }

    try {
      await window.electronAPI.tasks.move(input);
      if (moveGeneration !== thisGen) return; // Skip stale reload

      // Reload tasks, archived tasks, and sessions (transition engine may have spawned/killed sessions)
      const [tasks, archivedTasks, sessions] = await Promise.all([
        window.electronAPI.tasks.list(),
        window.electronAPI.tasks.listArchived(),
        window.electronAPI.sessions.list(),
      ]);
      if (moveGeneration !== thisGen) return; // Skip stale reload

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
    } catch (err) {
      if (moveGeneration !== thisGen) return; // Don't clobber newer state on error
      if (targetAutoCommand) {
        useSessionStore.getState().clearPendingCommandLabel(input.taskId);
      }
      await get().loadBoard();
      useToastStore.getState().addToast({
        message: `Failed to move task: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
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
        sessions: s.sessions.filter((sess) => sess.taskId !== id),
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
      // Reload tasks and sessions
      const [tasks, sessions] = await Promise.all([
        window.electronAPI.tasks.list(),
        window.electronAPI.sessions.list(),
      ]);
      set({ tasks });
      useSessionStore.setState({ sessions });

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

  reorderTaskInColumn: async (taskId, swimlaneId, activeId, overId) => {
    if (activeId === overId) return;
    const thisGen = ++moveGeneration;

    // Compute indices from IDs
    const laneTasks = get().tasks
      .filter((t) => t.swimlane_id === swimlaneId)
      .sort((a, b) => a.position - b.position);

    const oldIndex = laneTasks.findIndex((t) => t.id === activeId);
    const newIndex = laneTasks.findIndex((t) => t.id === overId);
    if (oldIndex === -1 || newIndex === -1) {
      await get().loadBoard();
      return;
    }

    // Optimistic update: reorder tasks in store immediately so dnd-kit's
    // transform release sees the correct DOM order (no snap-back).
    const reordered = arrayMove([...laneTasks], oldIndex, newIndex);

    const positionMap = new Map<string, number>();
    reordered.forEach((t, i) => positionMap.set(t.id, i));

    set((s) => ({
      tasks: s.tasks.map((t) => {
        const pos = positionMap.get(t.id);
        return pos !== undefined ? { ...t, position: pos } : t;
      }),
    }));

    try {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: newIndex,
      });
      if (moveGeneration !== thisGen) return; // Skip stale reload

      // Lightweight reload -- only tasks (no session changes for same-column reorder)
      const tasks = await window.electronAPI.tasks.list();
      if (moveGeneration !== thisGen) return; // Skip stale reload
      set({ tasks });
    } catch (err) {
      if (moveGeneration !== thisGen) return; // Don't clobber newer state on error
      await get().loadBoard();
      useToastStore.getState().addToast({
        message: `Failed to reorder task: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
    }
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

  updateAttachmentCount: (taskId, delta) => {
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId
          ? { ...task, attachment_count: Math.max(0, task.attachment_count + delta) }
          : task
      ),
    }));
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
    try {
      await window.electronAPI.swimlanes.reorder(ids);
    } catch (err) {
      await get().loadBoard();
      useToastStore.getState().addToast({
        message: `Failed to reorder columns: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
    }
  },

  setConfigWarnings: (warnings) => {
    set({ configWarnings: warnings });
  },

  dismissConfigWarnings: () => {
    set({ configWarnings: [] });
  },

  setPendingConfigChange: (projectId) => {
    set({ pendingConfigChange: projectId });
  },

  applyConfigChange: async () => {
    const projectId = get().pendingConfigChange;
    if (!projectId) return;
    set({ pendingConfigChange: null });

    // Switch project if needed
    const activeProjectId = useProjectStore.getState().currentProject?.id;
    if (projectId !== activeProjectId) {
      await useProjectStore.getState().openProject(projectId);
    }

    const warnings = await window.electronAPI.boardConfig.apply(projectId);
    if (warnings.length > 0) {
      set({ configWarnings: warnings });
      for (const warning of warnings) {
        useToastStore.getState().addToast({ message: warning, variant: 'warning' });
      }
    } else {
      set({ configWarnings: [] });
    }
    await get().loadBoard();
  },

  dismissConfigChange: () => {
    set({ pendingConfigChange: null });
  },
}));
