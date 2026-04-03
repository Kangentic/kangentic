import { create, StateCreator } from 'zustand';
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

// ---------------------------------------------------------------------------
// Slice interfaces
// ---------------------------------------------------------------------------

interface TaskSlice {
  tasks: Task[];
  createTask: (input: TaskCreateInput) => Promise<Task>;
  updateTask: (input: TaskUpdateInput) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  moveTask: (input: TaskMoveInput, skipConfirmation?: boolean) => Promise<void>;
  getTasksBySwimlane: (swimlaneId: string) => Task[];
  reorderTaskInColumn: (taskId: string, swimlaneId: string, activeId: string, overId: string) => Promise<void>;
  updateAttachmentCount: (taskId: string, delta: number) => void;
}

interface SwimlaneSlice {
  swimlanes: Swimlane[];
  createSwimlane: (input: SwimlaneCreateInput) => Promise<Swimlane>;
  updateSwimlane: (input: SwimlaneUpdateInput) => Promise<Swimlane>;
  deleteSwimlane: (id: string) => Promise<void>;
  reorderSwimlanes: (ids: string[]) => Promise<void>;
}

interface ArchiveSlice {
  archivedTasks: Task[];
  loadArchivedTasks: () => Promise<void>;
  archiveTask: (id: string) => void;
  unarchiveTask: (input: TaskUnarchiveInput) => Promise<void>;
  deleteArchivedTask: (id: string) => Promise<void>;
  bulkDeleteArchivedTasks: (ids: string[]) => Promise<void>;
  bulkUnarchiveTasks: (ids: string[], targetSwimlaneId: string) => Promise<void>;
}

interface CompletionSlice {
  completingTask: CompletingTask | null;
  recentlyArchivedId: string | null;
  setCompletingTask: (task: CompletingTask | null) => void;
  finalizeCompletion: () => Promise<void>;
  clearRecentlyArchived: () => void;
}

interface SearchSlice {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

interface BoardConfigSlice {
  configWarnings: string[];
  pendingConfigChange: string | null;
  setConfigWarnings: (warnings: string[]) => void;
  dismissConfigWarnings: () => void;
  setPendingConfigChange: (projectId: string | null) => void;
  applyConfigChange: () => Promise<void>;
  dismissConfigChange: () => void;
}

interface BoardLifecycleSlice {
  loading: boolean;
  shortcuts: (ShortcutConfig & { source: 'team' | 'local' })[];
  loadBoard: () => Promise<void>;
  loadShortcuts: () => Promise<void>;
}

interface MoveConfirmSlice {
  pendingMoveConfirm: {
    input: TaskMoveInput;
    uncommittedFileCount: number;
    unpushedCommitCount: number;
    taskTitle: string;
    hasWorktree: boolean;
  } | null;
  confirmPendingMove: () => Promise<void>;
  cancelPendingMove: () => void;
}

interface ViewSlice {
  activeView: 'board' | 'backlog';
  setActiveView: (view: 'board' | 'backlog') => void;
}

type BoardStore = TaskSlice & SwimlaneSlice & ArchiveSlice & CompletionSlice
  & SearchSlice & BoardConfigSlice & BoardLifecycleSlice & MoveConfirmSlice & ViewSlice;

// ---------------------------------------------------------------------------
// Shared module-level state
// ---------------------------------------------------------------------------

/** Generation counter for stale reload protection.
 *  Each moveTask/reorderTaskInColumn increments before async work.
 *  After IPC completes, the reload is only applied if no newer move has started.
 *  Persisted across HMR via import.meta.hot.data to prevent stale-check
 *  from incorrectly skipping reloads when the counter resets to 0. */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let moveGeneration: number = import.meta.hot?.data?.moveGeneration ?? 0;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.moveGeneration = moveGeneration;
  });
}

// ---------------------------------------------------------------------------
// Slice creators
// ---------------------------------------------------------------------------

const createTaskSlice: StateCreator<BoardStore, [], [], TaskSlice> = (set, get) => ({
  tasks: [],

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
      sessions: s.sessions.filter((session) => session.taskId !== id),
    }));
  },

  moveTask: async (input, skipConfirmation?: boolean) => {
    // Capture the task's current session before the move
    const prevTask = get().tasks.find((t) => t.id === input.taskId);
    const prevSessionId = prevTask?.session_id ?? null;

    // --- Pre-check: confirm before destructive move to To Do ---
    // Runs before incrementing moveGeneration so cancelled confirmations
    // don't burn generation numbers or interfere with stale-reload guards.
    if (!skipConfirmation) {
      const isColumnChange = prevTask?.swimlane_id !== input.targetSwimlaneId;
      const targetLane = get().swimlanes.find((s) => s.id === input.targetSwimlaneId);
      if (isColumnChange && targetLane?.role === 'todo' && prevTask && (prevTask.worktree_path || prevTask.branch_name)) {
        const checkPath = prevTask.worktree_path || useProjectStore.getState().currentProject?.path;
        if (checkPath) {
          try {
            const result = await window.electronAPI.git.checkPendingChanges({ checkPath });
            if (result.hasPendingChanges) {
              set({
                pendingMoveConfirm: {
                  input,
                  uncommittedFileCount: result.uncommittedFileCount,
                  unpushedCommitCount: result.unpushedCommitCount,
                  taskTitle: prevTask.title,
                  hasWorktree: !!prevTask.worktree_path,
                },
              });
              return;
            }
          } catch {
            // Git check failed - show confirmation as safe default
            set({
              pendingMoveConfirm: {
                input,
                uncommittedFileCount: 0,
                unpushedCommitCount: 0,
                taskTitle: prevTask.title,
                hasWorktree: !!prevTask.worktree_path,
              },
            });
            return;
          }
        }
      }
    }

    const thisGen = ++moveGeneration;

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
    if (isColumnChange && targetLane?.role === 'todo') {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.filter((session) => session.taskId !== input.taskId),
      }));
    }

    try {
      await window.electronAPI.tasks.move(input);
      if (moveGeneration !== thisGen) return; // Skip stale reload

      // Reload tasks and archived tasks (sessions arrive via push-based session-changed events)
      const [tasks, archivedTasks] = await Promise.all([
        window.electronAPI.tasks.list(),
        window.electronAPI.tasks.listArchived(),
      ]);
      if (moveGeneration !== thisGen) return; // Skip stale reload

      set({ tasks, archivedTasks });

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
      } else if (targetAutoCommand) {
        // No new session was spawned (e.g. user-paused task moved to auto_command column).
        // Clear the optimistic pendingCommandLabel to prevent stale shimmer overlay.
        useSessionStore.getState().clearPendingCommandLabel(input.taskId);
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

  updateAttachmentCount: (taskId, delta) => {
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId
          ? { ...task, attachment_count: Math.max(0, task.attachment_count + delta) }
          : task
      ),
    }));
  },
});

const createSwimlaneSlice: StateCreator<BoardStore, [], [], SwimlaneSlice> = (set, get) => ({
  swimlanes: [],

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
});

const createArchiveSlice: StateCreator<BoardStore, [], [], ArchiveSlice> = (set, get) => ({
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

const createCompletionSlice: StateCreator<BoardStore, [], [], CompletionSlice> = (set, get) => ({
  completingTask: null,
  recentlyArchivedId: null,

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
});

const createSearchSlice: StateCreator<BoardStore, [], [], SearchSlice> = (set) => ({
  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),
});

const createBoardConfigSlice: StateCreator<BoardStore, [], [], BoardConfigSlice> = (set, get) => ({
  configWarnings: [],
  pendingConfigChange: null,

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
});

const createBoardLifecycleSlice: StateCreator<BoardStore, [], [], BoardLifecycleSlice> = (set, get) => ({
  loading: false,
  shortcuts: [],

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
});

// ---------------------------------------------------------------------------
// Store composition
// ---------------------------------------------------------------------------

const createMoveConfirmSlice: StateCreator<BoardStore, [], [], MoveConfirmSlice> = (set, get) => ({
  pendingMoveConfirm: null,
  confirmPendingMove: async () => {
    const pending = get().pendingMoveConfirm;
    if (!pending) return;
    set({ pendingMoveConfirm: null });
    await get().moveTask(pending.input, true);
  },
  cancelPendingMove: () => {
    set({ pendingMoveConfirm: null });
  },
});

const createViewSlice: StateCreator<BoardStore, [], [], ViewSlice> = (set) => ({
  activeView: 'board',
  setActiveView: (view) => set({ activeView: view }),
});

export const useBoardStore = create<BoardStore>((...args) => ({
  ...createTaskSlice(...args),
  ...createSwimlaneSlice(...args),
  ...createArchiveSlice(...args),
  ...createCompletionSlice(...args),
  ...createSearchSlice(...args),
  ...createBoardConfigSlice(...args),
  ...createBoardLifecycleSlice(...args),
  ...createMoveConfirmSlice(...args),
  ...createViewSlice(...args),
}));
