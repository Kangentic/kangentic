import { type StateCreator } from 'zustand';
import { arrayMove } from '@dnd-kit/sortable';
import type { Task, TaskCreateInput, TaskUpdateInput, TaskMoveInput, TaskSetRuntimeOverrideResult } from '../../../shared/types';
import { useConfigStore } from '../config-store';
import { useSessionStore } from '../session-store';
import { withoutSessionsForTasks } from '../session-store/session-index';
import { useToastStore } from '../toast-store';
import { useProjectStore } from '../project-store';
import { invalidateProject } from '../project-cache';
import { describeIpcError } from '../../lib/ipc-error';
import { applyStructuralSharing } from './structural-sharing';
import { applyTaskListPayload } from './lane-pins';
import { fetchArchivedReconcile } from './archived-tasks-slice';
import type { BoardStore } from './types';

/** Outcome of a moveTask call. `ok: false` means the IPC genuinely failed
 *  (moveTask already toasted + rolled back); the completion gate uses this to
 *  suppress its success toast. A superseded/deferred move resolves `ok: true`. */
export interface MoveTaskResult {
  ok: boolean;
}

export interface TaskSlice {
  tasks: Task[];
  createTask: (input: TaskCreateInput) => Promise<Task>;
  updateTask: (input: TaskUpdateInput) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  moveTask: (input: TaskMoveInput, skipConfirmation?: boolean, projectId?: string | null) => Promise<MoveTaskResult>;
  getTasksBySwimlane: (swimlaneId: string) => Task[];
  reorderTaskInColumn: (taskId: string, swimlaneId: string, activeId: string, overId: string) => Promise<void>;
  updateAttachmentCount: (taskId: string, delta: number) => void;
  /**
   * Apply a per-task model and/or effort override. Optimistically updates the
   * task row so the ContextBar pill changes immediately; rolls back on IPC
   * error. Either field can be omitted to leave it unchanged; pass `null` to
   * explicitly clear the override (so the task falls back to its swimlane).
   */
  setTaskRuntimeOverride: (taskId: string, patch: { model?: string | null; effort?: string | null }) => Promise<TaskSetRuntimeOverrideResult>;
}

/**
 * Per-task generation counters for stale reload protection.
 * Each moveTask/reorderTaskInColumn increments its OWN task's counter before
 * async work. After IPC completes, the reload is only applied if no newer move
 * of THE SAME TASK has started.
 *
 * This was a single module-scope number shared by every task, which broke
 * exactly the case it was meant to protect: dragging two tasks in quick
 * succession made the first move's reload "superseded" by the second, so the
 * board's only reconcile was the second move's, and nothing repaired the first
 * if a stale reload had clobbered it. Worse, the counter is claimed AFTER the
 * `checkPendingChanges` probe below, so with a global counter the generations
 * were assigned in probe-completion order rather than drop order and the
 * earlier-dropped card could end up owning the reload.
 *
 * Keyed per task, a cancelled confirmation only ever burns its own task's
 * generation, so the claim can stay where it is.
 *
 * Persisted across HMR via import.meta.hot.data (Pattern A) so the counters
 * don't reset to 0 under a new module instance and mis-apply a stale reload.
 */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const moveGenerations: Map<string, number> = import.meta.hot?.data?.moveGenerations ?? new Map<string, number>();

/** Claim the next generation for a task and return it. */
function claimMoveGeneration(taskId: string): number {
  const next = (moveGenerations.get(taskId) ?? 0) + 1;
  moveGenerations.set(taskId, next);
  return next;
}

/** True when a newer move of this same task has started since `generation`. */
function isSupersededMove(taskId: string, generation: number): boolean {
  return moveGenerations.get(taskId) !== generation;
}

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.moveGenerations = moveGenerations;
  });
}

export const createTaskSlice: StateCreator<BoardStore, [], [], TaskSlice> = (set, get) => ({
  tasks: [],

  createTask: async (input) => {
    const task = await window.electronAPI.tasks.create(input, useProjectStore.getState().currentProject?.id ?? null);
    set((s) => ({ tasks: [...s.tasks, task] }));

    // Mark first-run onboarding complete after the user's first task creation
    const { config, updateConfig } = useConfigStore.getState();
    if (!config.hasCompletedFirstRun) {
      updateConfig({ hasCompletedFirstRun: true });
    }

    return task;
  },

  updateTask: async (input) => {
    const task = await window.electronAPI.tasks.update(input, useProjectStore.getState().currentProject?.id ?? null);
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === task.id ? task : t)),
      archivedTasks: s.archivedTasks.map((t) => (t.id === task.id ? task : t)),
    }));
    return task;
  },

  setTaskRuntimeOverride: async (taskId, patch) => {
    // Snapshot for rollback. We only rollback when the IPC layer itself
    // throws (network/serialization error - extremely rare on the local
    // bridge) OR the handler returned `ok: false` BEFORE persisting (task
    // not found, no project open, unknown agent on a live session). Once the
    // handler crosses its DB write, `ok: false` means "saved but not yet
    // live" - the renderer must keep the optimistic UI so the visible state
    // matches the DB. The handler's reason strings starting with
    // 'suspend failed', 'respawn failed', or 'respawn aborted' indicate the
    // post-persist failure modes; these surface a toast but no rollback.
    const previous = get().tasks.find((t) => t.id === taskId);

    // Optimistic: update the pill immediately.
    set((s) => ({
      tasks: s.tasks.map((t) => {
        if (t.id !== taskId) return t;
        return {
          ...t,
          ...(patch.model !== undefined ? { model_override: patch.model } : {}),
          ...(patch.effort !== undefined ? { effort_override: patch.effort } : {}),
        };
      }),
    }));

    let result: TaskSetRuntimeOverrideResult;
    try {
      result = await window.electronAPI.tasks.setRuntimeOverride({ taskId, ...patch }, useProjectStore.getState().currentProject?.id ?? null);
    } catch (err) {
      // IPC bridge itself threw - the handler never ran, no DB write
      // happened, rollback is correct.
      if (previous) {
        set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? previous : t)) }));
      }
      useToastStore.getState().addToast({
        message: `Failed to apply override: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
      throw err;
    }

    if (!result.ok) {
      // Distinguish pre-persist failures (rollback) from post-persist
      // failures (keep UI aligned with DB; just toast). The handler's
      // post-persist reasons all start with one of these prefixes - any
      // other reason is a pre-persist validation failure.
      const isPostPersistFailure = result.reason.startsWith('suspend failed')
        || result.reason.startsWith('respawn failed')
        || result.reason === 'respawn aborted';

      if (!isPostPersistFailure && previous) {
        set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? previous : t)) }));
      }
      useToastStore.getState().addToast({
        message: isPostPersistFailure
          ? `Saved, but couldn't apply to the live session: ${result.reason}. Resume the task to retry.`
          : `Could not apply model/effort: ${result.reason}`,
        variant: 'error',
      });
    } else if (result.mode === 'restart') {
      // The handler suspended the old PTY and spawned a new one with a new
      // session_id. The board store still has the OLD session_id on the
      // task row, so any selector that looks up the task by session_id
      // (ContextBar, TerminalPanel) won't find it until we re-fetch. Reload
      // serializes against any concurrent moveTask via the structural-sharing
      // merge in board-hydration-slice.
      await get().loadBoard();
    }

    return result;
  },

  deleteTask: async (id) => {
    // Snapshot both arrays for rollback. Active tasks normally live in
    // `tasks`, but we filter both defensively to match the prior behavior.
    const previousTasks = get().tasks;
    const previousArchivedTasks = get().archivedTasks;
    const previousArchivedTotalCount = get().archivedTotalCount;

    // Optimistic: remove the card from view immediately. Decrement the archived
    // count only when this id was actually an archived row.
    set((s) => {
      const wasArchived = s.archivedTasks.some((t) => t.id === id);
      return {
        tasks: s.tasks.filter((t) => t.id !== id),
        archivedTasks: s.archivedTasks.filter((t) => t.id !== id),
        archivedTotalCount: wasArchived ? Math.max(0, s.archivedTotalCount - 1) : s.archivedTotalCount,
      };
    });

    // Callers (TaskCard.handleContextDelete / useTaskActions.handleDelete)
    // already awaited killSession before invoking this, so the PTY is dead.
    // Drop the in-memory record alongside the task. Sessions are NOT restored
    // on rollback - the PTY is gone either way; user can re-spawn if the task
    // pops back.
    useSessionStore.setState((s) => withoutSessionsForTasks(s.sessions, id));

    try {
      await window.electronAPI.tasks.delete(id, useProjectStore.getState().currentProject?.id ?? null);
    } catch (err) {
      // Restore both arrays so the card reappears in its original slot.
      // No loadBoard() reconcile (unlike unarchiveTask): backend withTaskLock
      // already serializes per-task ops, and same-task is the only meaningful
      // race surface for a hard delete. Matches deleteArchivedTask.
      set({ tasks: previousTasks, archivedTasks: previousArchivedTasks, archivedTotalCount: previousArchivedTotalCount });
      useToastStore.getState().addToast({
        message: `Failed to delete task: ${err instanceof Error ? err.message : 'Unknown error'}`,
        variant: 'error',
      });
      // Re-throw so callers skip their own success toast on failure.
      throw err;
    }
  },

  moveTask: async (input, skipConfirmation?: boolean, projectId?: string | null) => {
    // Capture the project this move targets at interaction time. The gated Done
    // path passes the projectId stamped on the FlyingCard at drop (the move runs
    // ~700ms later, possibly after a project switch); direct synchronous callers
    // omit it and we read the live current project. `!== undefined` lets a caller
    // pass an explicit null (no project) without falling back to live.
    const sourceProjectId = projectId !== undefined
      ? projectId
      : (useProjectStore.getState().currentProject?.id ?? null);
    // True when the user has switched away from the project this move targets.
    // Used so a reload/rollback never runs against the wrong project's board;
    // instead we invalidate the source project's warm-cache snapshot so the next
    // switch back to it does a fresh cold load.
    const switchedAway = () =>
      sourceProjectId !== null
      && sourceProjectId !== (useProjectStore.getState().currentProject?.id ?? null);

    // Capture the task's current session before the move
    const prevTask = get().tasks.find((t) => t.id === input.taskId);
    const prevSessionId = prevTask?.session_id ?? null;

    // Moves into a Done-role lane archive the task on the backend. Extend the
    // completingTaskIds guard (originally scoped to the animated FlyingCard
    // path in setCompletingTask) to this direct path as well, so every
    // moveTask-to-Done is covered by KanbanBoard's tasksPerLane chokepoint. Also
    // remove the task from state.tasks so it doesn't flash as an active card
    // while the IPC is in flight.
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

      const previous = s.tasks[taskIndex];
      const task = { ...previous };
      task.swimlane_id = input.targetSwimlaneId;
      task.position = input.targetPosition;
      const tasks = [...s.tasks];
      tasks[taskIndex] = task;

      // Same-column reorder: no lane changes, so a lane pin would be a no-op.
      if (previous.swimlane_id === input.targetSwimlaneId) return { tasks };

      // Pin the destination in the SAME set() as the optimistic lane write -
      // they are one fact and must commit together. Pinning later (e.g. next to
      // `claimMoveGeneration`) would leave a gap across the `checkPendingChanges`
      // await below, and a reload flushed by `endBoardDrag()` lands in exactly
      // that gap. Dropped by `reconcileLanePins` on the first payload that shows
      // the move landed. Done moves are excluded above: `completingTaskIds`
      // already removes them from every lane for the whole flight.
      const lanePins = new Map(s.lanePins);
      lanePins.set(input.taskId, {
        laneId: input.targetSwimlaneId,
        fromLaneId: previous.swimlane_id,
        fromUpdatedAt: previous.updated_at,
      });
      return { tasks, lanePins };
    });

    // Pre-check: confirm before destructive move to To Do.
    // Runs before claiming this task's generation so cancelled confirmations
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
              // Enqueued, not assigned: a second move needing confirmation used
              // to overwrite this one, and THIS move has already returned ok
              // without calling the IPC - so the overwritten card kept an
              // optimistic placement that no write backed.
              get().enqueueMoveConfirm({
                input,
                uncommittedFileCount: result.uncommittedFileCount,
                unpushedCommitCount: result.unpushedCommitCount,
                taskTitle: prevTask.title,
                hasWorktree: !!prevTask.worktree_path,
              });
              // Deferred to the confirm dialog; not a failure. confirmPendingMove
              // re-invokes moveTask with the captured projectId.
              return { ok: true };
            }
          } catch {
            // Git check failed - show confirmation as safe default
            get().enqueueMoveConfirm({
              input,
              uncommittedFileCount: 0,
              unpushedCommitCount: 0,
              taskTitle: prevTask.title,
              hasWorktree: !!prevTask.worktree_path,
            });
            // Deferred to the confirm dialog; not a failure.
            return { ok: true };
          }
        }
      }
    }

    const thisGen = claimMoveGeneration(input.taskId);

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
    // (the backend will destroy the session during TASK_MOVE via cleanupTaskSession).
    // Also clear spawn progress and pending command labels so a stale
    // "Initializing..." / "Starting agent..." indicator from an in-flight
    // spawn disappears the instant the card lands in To Do, without
    // waiting for the backend's clearSpawnProgress push to arrive.
    if (isColumnChange && targetLane?.role === 'todo') {
      useSessionStore.setState((state) => {
        const { [input.taskId]: _removedProgress, ...nextSpawnProgress } = state.spawnProgress;
        const { [input.taskId]: _removedLabel, ...nextPendingCommandLabel } = state.pendingCommandLabel;
        return {
          ...withoutSessionsForTasks(state.sessions, input.taskId),
          spawnProgress: nextSpawnProgress,
          pendingCommandLabel: nextPendingCommandLabel,
        };
      });
    }

    try {
      await window.electronAPI.tasks.move(input, sourceProjectId);
      if (isSupersededMove(input.taskId, thisGen)) return { ok: true }; // Superseded; the newer move of this task owns the reload

      // The user switched to another project while this move was in flight. The
      // move itself succeeded (it ran against sourceProjectId), but a reload here
      // would read the now-current (wrong) project. Skip it and invalidate the
      // source project's warm-cache snapshot so the next switch back to it does a
      // fresh cold load instead of restoring a stale (optimistically-removed) one.
      if (switchedAway()) {
        invalidateProject(sourceProjectId!);
        return { ok: true };
      }

      // Reload tasks and archived tasks (sessions arrive via push-based
      // session-changed events). A move to Done archives the task; the archived
      // side reconciles via the preview unless a viewer holds the full list.
      const [nextTasks, archivedReconcile] = await Promise.all([
        window.electronAPI.tasks.list(),
        fetchArchivedReconcile(get().archivedFullyLoaded),
      ]);
      if (isSupersededMove(input.taskId, thisGen)) return { ok: true }; // Skip stale reload
      // A switch can also land during the list round-trip above.
      if (switchedAway()) {
        invalidateProject(sourceProjectId!);
        return { ok: true };
      }

      // Preserve references for unchanged tasks so sibling TaskCards (the
      // majority, since only the moved task changed swimlane/position) skip
      // their memo and don't re-render on every drag drop.
      set((state) => ({
        ...applyTaskListPayload(state, nextTasks),
        archivedTasks: applyStructuralSharing(state.archivedTasks, archivedReconcile.tasks),
        archivedTotalCount: archivedReconcile.totalCount,
      }));

      // Detect if the moved task now has a new/different session
      const movedTask = nextTasks.find((t) => t.id === input.taskId);
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
      return { ok: true };
    } catch (err) {
      if (isSupersededMove(input.taskId, thisGen)) return { ok: true }; // Superseded; not this move's failure
      // The write never landed, so no payload will ever differ from the pinned
      // snapshot and the content-based drop can never fire. Release the pin
      // BEFORE the rollback reload below, or the card is held at the failed
      // target forever while the DB says otherwise. This is the single most
      // important explicit drop. The ownership check makes a superseded
      // failure leave a newer move's pin alone.
      get().dropTaskLanePin(input.taskId, input.targetSwimlaneId);
      // Clear any optimistic progress indicators set before the IPC call
      useSessionStore.getState().clearPendingCommandLabel(input.taskId);
      useSessionStore.getState().setSpawnProgress(input.taskId, null);
      // Cross-project-safe rollback: reload only if still on the source project;
      // otherwise loadBoard would reload the wrong (now-current) project. Mark the
      // source project stale instead so re-entry reloads it fresh.
      if (switchedAway()) {
        invalidateProject(sourceProjectId!);
      } else {
        await get().loadBoard();
      }
      useToastStore.getState().addToast({
        message: `Failed to move task: ${describeIpcError(err)}`,
        variant: 'error',
      });
      return { ok: false };
    } finally {
      // Release the completingTaskIds guard regardless of success/failure so
      // tasksPerLane lets future reloads re-render the task if anything above
      // bailed early.
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
    // Same-tick synchronous reorder; capture the current project so the move
    // routes correctly even though the race window is tiny.
    const reorderProjectId = useProjectStore.getState().currentProject?.id ?? null;
    const thisGen = claimMoveGeneration(taskId);

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
      }, reorderProjectId);
      if (isSupersededMove(taskId, thisGen)) return; // Skip stale reload

      // Lightweight reload - only tasks (no session changes for same-column reorder)
      const nextTasks = await window.electronAPI.tasks.list();
      if (isSupersededMove(taskId, thisGen)) return; // Skip stale reload
      // Preserve refs for every untouched task; only the reordered ones
      // actually changed `position`.
      set((state) => applyTaskListPayload(state, nextTasks));
    } catch (err) {
      if (isSupersededMove(taskId, thisGen)) return; // Don't clobber newer state on error
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
