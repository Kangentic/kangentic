import { type StateCreator } from 'zustand';
import { arrayMove } from '@dnd-kit/sortable';
import type { Task, TaskCreateInput, TaskUpdateInput, TaskMoveInput } from '../../../shared/types';
import { useConfigStore } from '../config-store';
import { useSessionStore } from '../session-store';
import { useToastStore } from '../toast-store';
import { useProjectStore } from '../project-store';
import type { BoardStore } from './types';

export interface TaskSlice {
  tasks: Task[];
  createTask: (input: TaskCreateInput) => Promise<Task>;
  updateTask: (input: TaskUpdateInput) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  moveTask: (input: TaskMoveInput, skipConfirmation?: boolean) => Promise<void>;
  getTasksBySwimlane: (swimlaneId: string) => Task[];
  reorderTaskInColumn: (taskId: string, swimlaneId: string, activeId: string, overId: string) => Promise<void>;
  updateAttachmentCount: (taskId: string, delta: number) => void;
}

/**
 * Generation counter for stale reload protection.
 * Each moveTask/reorderTaskInColumn increments before async work.
 * After IPC completes, the reload is only applied if no newer move has
 * started. Persisted across HMR via import.meta.hot.data so the counter
 * doesn't reset to 0 under a new module instance and mis-apply a stale
 * reload.
 */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let moveGeneration: number = import.meta.hot?.data?.moveGeneration ?? 0;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.moveGeneration = moveGeneration;
  });
}

export const createTaskSlice: StateCreator<BoardStore, [], [], TaskSlice> = (set, get) => ({
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

    // Moves into a Done-role lane archive the task on the backend. Extend the
    // completingTaskIds guard (originally scoped to the animated FlyingCard
    // path in setCompletingTask) to this direct path as well, so every
    // moveTask-to-Done is covered by DoneSwimlane's filter. Also remove the
    // task from state.tasks so it doesn't flash as an active card in the Done
    // column while the IPC is in flight.
    const targetLane = get().swimlanes.find((lane) => lane.id === input.targetSwimlaneId);
    const isCrossColumnToDone = targetLane?.role === 'done' && prevTask?.swimlane_id !== input.targetSwimlaneId;
    if (isCrossColumnToDone) {
      get().addCompletingTaskId(input.taskId);
    }

    // Optimistic update: move card to target column immediately so it
    // doesn't snap back to the origin while a confirmation dialog is open.
    // For Done moves, remove from the active tasks array entirely so no
    // swimlane renders it during the IPC window.
    set((s) => {
      const taskIndex = s.tasks.findIndex((t) => t.id === input.taskId);
      if (taskIndex < 0) return s;

      if (isCrossColumnToDone) {
        return { tasks: s.tasks.filter((t) => t.id !== input.taskId) };
      }

      const task = { ...s.tasks[taskIndex] };
      task.swimlane_id = input.targetSwimlaneId;
      task.position = input.targetPosition;
      const tasks = [...s.tasks];
      tasks[taskIndex] = task;
      return { tasks };
    });

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

    // If the task is changing columns and the target has an auto_command, set
    // pendingCommandLabel so the overlay shows the command name instead of
    // generic "Resuming agent...". Skip within-column reorders.
    const isColumnChange = prevTask?.swimlane_id !== input.targetSwimlaneId;
    if (isColumnChange && targetLane?.auto_spawn && targetLane.auto_command?.trim()) {
      useSessionStore.getState().setPendingCommandLabel(input.taskId, targetLane.auto_command.trim());
    }

    // Optimistically show spawn progress for auto-spawn columns, but only
    // when the task doesn't already have a running session. Same-agent moves
    // with auto_command inject directly without restarting the session.
    if (isColumnChange && targetLane?.auto_spawn && !prevSessionId) {
      useSessionStore.getState().setSpawnProgress(input.taskId, 'Initializing...');
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
        // Explicitly clear spawn progress - the session-changed IPC push event
        // may not have been processed yet (races with the TASK_MOVE response).
        useSessionStore.getState().setSpawnProgress(input.taskId, null);
        const isResume = prevSessionId !== null;
        useToastStore.getState().addToast({
          message: isResume
            ? `Agent resumed for "${movedTask.title}"`
            : `Agent started for "${movedTask.title}"`,
          variant: 'success',
        });
      } else if (isColumnChange && targetLane?.auto_spawn) {
        // No new session was spawned (e.g. user-paused task moved to auto_spawn column,
        // or auto_spawn column without auto_command). Clear the optimistic progress
        // indicators to prevent stuck "Initializing..." state on the card.
        useSessionStore.getState().clearPendingCommandLabel(input.taskId);
        useSessionStore.getState().setSpawnProgress(input.taskId, null);
      }
    } catch (err) {
      if (moveGeneration !== thisGen) return; // Don't clobber newer state on error
      // Clear any optimistic progress indicators set before the IPC call
      useSessionStore.getState().clearPendingCommandLabel(input.taskId);
      useSessionStore.getState().setSpawnProgress(input.taskId, null);
      await get().loadBoard();
      useToastStore.getState().addToast({
        message: `Failed to move task: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
    } finally {
      // Release the completingTaskIds guard regardless of success/failure so
      // DoneSwimlane's filter lets future reloads re-render the task if
      // anything above bailed early.
      if (isCrossColumnToDone) {
        get().removeCompletingTaskId(input.taskId);
      }
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
          : task,
      ),
    }));
  },
});
