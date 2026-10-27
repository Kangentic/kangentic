import { type StateCreator } from 'zustand';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { useToastStore } from '../toast-store';
import { useProjectStore } from '../project-store';
import { describeIpcError, asSentence } from '../../lib/ipc-error';
import { openTaskFromNotification } from '../../utils/open-task-from-notification';
import type { BoardStore, CompletingTask } from './types';
import { type CompletionGate, createGate, canPersist } from './completion-gate';

export interface TaskCompletionSlice {
  completingTask: CompletingTask | null;
  recentlyArchivedId: string | null;
  /** Task IDs currently being completed via a Done drop (from setCompletingTask
   *  until after moveTask's IPC+reload resolves). Superset of `completingTask`:
   *  the singular field drives the FlyingCard animation for the active drop,
   *  while this Set is read by KanbanBoard's `tasksPerLane` chokepoint to keep
   *  the task out of EVERY lane during the ~700ms fly. The backend still holds
   *  the task at its source lane until moveTask archives it at the end, so a
   *  racing loadBoard() would otherwise re-inject it at its source column for a
   *  frame. Filter only at that single chokepoint, never per-lane. See
   *  .claude/rules/board-completing-task-chokepoint.md. */
  completingTaskIds: Set<string>;
  /** Per-task completion gates. The FlyingCard mounts and starts flying the
   *  instant a Done drop is detected, but persistence (moveTask) waits until the
   *  fly finishes AND the move is approved (probe clean / dialog confirmed). The
   *  gate joins those two signals so the move runs exactly once. See
   *  ./completion-gate.ts and .claude/rules/board-completing-task-chokepoint.md.
   *  NOTE: a probe that never resolves leaves a gate unapproved forever (task
   *  hidden, nothing persists) - the same exposure as the old pre-fly await
   *  hang. No timeout is added here on purpose. */
  completionGates: Map<string, CompletionGate>;
  /** Mount the FlyingCard for a Done drop. `opts.gated` true defers persistence
   *  until `approveCompletion` (worktree drops, where a probe + maybe a dialog
   *  must clear first); omit/false pre-approves it (no worktree, or a direct
   *  caller). */
  setCompletingTask: (task: CompletingTask | null, opts?: { gated?: boolean }) => void;
  /** Signal that a completion's fly finished (transitionend / fallback timer /
   *  no drop zone / superseded). Persists if the gate is also approved. */
  markCompletionAnimationDone: (taskId: string) => void;
  /** Approve a gated completion (probe came back clean, or the user confirmed
   *  the pending-changes dialog). Persists if the fly is also finished. */
  approveCompletion: (taskId: string) => void;
  /** Abandon a gated completion (the user declined the dialog). Restores the
   *  task to its source lane and unmounts the FlyingCard. */
  cancelCompletion: (taskId: string) => void;
  /** Force-finish the active completion now (compat path: drives the move
   *  immediately regardless of the gate). */
  finalizeCompletion: () => Promise<void>;
  clearRecentlyArchived: () => void;
  addCompletingTaskId: (taskId: string) => void;
  removeCompletingTaskId: (taskId: string) => void;
}

export const createTaskCompletionSlice: StateCreator<BoardStore, [], [], TaskCompletionSlice> = (set, get) => {
  // Run the actual move for a completion, once. Reads the gate's stashed
  // `completing` payload (NOT get().completingTask, which may already point at a
  // newer drop). The persistStarted check-then-set is atomic in single-threaded
  // JS (no await between them), so concurrent triggers cannot double-persist.
  const persistCompletion = async (taskId: string) => {
    const gate = get().completionGates.get(taskId);
    if (!gate || gate.persistStarted) return;
    set((s) => {
      const current = s.completionGates.get(taskId);
      if (!current) return s;
      const nextGates = new Map(s.completionGates);
      nextGates.set(taskId, { ...current, persistStarted: true });
      return { completionGates: nextGates };
    });

    const { targetSwimlaneId, targetPosition, task, projectId } = gate.completing;
    const taskTitle = task.title;

    // Clear the singular completingTask only if it still points at THIS drop;
    // a later drop may have already replaced it (supersede).
    set((s) => (s.completingTask?.taskId === taskId ? { completingTask: null } : {}));

    try {
      // Pass the projectId captured at drop time so the move (and its archive)
      // target the project the card was dropped in, even if the user switched
      // projects during the FlyingCard flight.
      const result = await get().moveTask({ taskId, targetSwimlaneId, targetPosition }, false, projectId);
      if (result.ok) {
        // recentlyArchivedId is board-store-global. Only flag it when still
        // viewing the source project, so a cross-project completion doesn't
        // mis-highlight a foreign board.
        if (useProjectStore.getState().currentProject?.id === projectId) {
          set({ recentlyArchivedId: taskId });
        }
        useToastStore.getState().addToast({
          title: i18n._(msg`Task completed`),
          message: i18n._(msg`"${{ taskTitle }}" is archived.`),
          variant: 'success',
          onOpen: projectId !== null ? () => openTaskFromNotification(projectId, taskId) : undefined,
        });
      }
      // result.ok === false: moveTask already surfaced the error toast and did a
      // cross-project-safe rollback (reload or warm-cache invalidation). Firing a
      // success toast here was the original false-success bug; we no longer do.
    } catch (err) {
      // Safety net: moveTask returns { ok: false } rather than throwing for IPC
      // failures, but guard an unexpected throw so the gate still cleans up below.
      useToastStore.getState().addToast({
        title: i18n._(msg`Couldn't complete task`),
        message: asSentence(describeIpcError(err)),
        variant: 'error',
      });
    } finally {
      get().removeCompletingTaskId(taskId);
      set((s) => {
        if (!s.completionGates.has(taskId)) return s;
        const nextGates = new Map(s.completionGates);
        nextGates.delete(taskId);
        return { completionGates: nextGates };
      });
    }
  };

  // Persist iff both signals have landed. Both markCompletionAnimationDone and
  // approveCompletion funnel here, so whichever arrives last triggers the move.
  const maybePersistCompletion = (taskId: string) => {
    const gate = get().completionGates.get(taskId);
    if (gate && canPersist(gate)) void persistCompletion(taskId);
  };

  return {
    completingTask: null,
    recentlyArchivedId: null,
    completingTaskIds: new Set<string>(),
    completionGates: new Map<string, CompletionGate>(),

    setCompletingTask: (task, opts) => {
      // Supersede: if a prior completion is still flying, end its fly (its
      // FlyingCard unmounts when completingTask is replaced via the re-key) but
      // let it persist on its OWN approval - never force-persist an unapproved
      // worktree drop. markCompletionAnimationDone persists it now if it was
      // already approved (ungated), or leaves it pending until its probe clears.
      const previous = get().completingTask;
      if (previous && (!task || previous.taskId !== task.taskId)) {
        get().markCompletionAnimationDone(previous.taskId);
      }
      // Remove the task from the tasks array so no column renders it during
      // flight, add to completingTaskIds so the tasksPerLane chokepoint keeps it
      // out of every lane even if a racing loadBoard() re-injects it, and open a
      // gate that holds back persistence until the fly + approval both land.
      set((s) => {
        if (!task) {
          return { completingTask: null };
        }
        const nextIds = new Set(s.completingTaskIds);
        nextIds.add(task.taskId);
        const nextGates = new Map(s.completionGates);
        nextGates.set(task.taskId, createGate(task, !!opts?.gated));
        return {
          completingTask: task,
          tasks: s.tasks.filter((t) => t.id !== task.taskId),
          completingTaskIds: nextIds,
          completionGates: nextGates,
        };
      });
    },

    markCompletionAnimationDone: (taskId) => {
      set((s) => {
        const gate = s.completionGates.get(taskId);
        if (!gate || gate.animationDone) return s;
        const nextGates = new Map(s.completionGates);
        nextGates.set(taskId, { ...gate, animationDone: true });
        return { completionGates: nextGates };
      });
      maybePersistCompletion(taskId);
    },

    approveCompletion: (taskId) => {
      set((s) => {
        const gate = s.completionGates.get(taskId);
        if (!gate || gate.approved) return s;
        const nextGates = new Map(s.completionGates);
        nextGates.set(taskId, { ...gate, approved: true });
        return { completionGates: nextGates };
      });
      maybePersistCompletion(taskId);
    },

    cancelCompletion: (taskId) => {
      // Full restore in one atomic set so the card is never absent from both the
      // tasks array and the FlyingCard for a frame. Re-insert the stashed task
      // only if a mid-flight loadBoard() has not already re-injected it.
      set((s) => {
        const gate = s.completionGates.get(taskId);
        const nextIds = s.completingTaskIds.has(taskId) ? new Set(s.completingTaskIds) : s.completingTaskIds;
        if (nextIds !== s.completingTaskIds) nextIds.delete(taskId);
        const nextGates = gate ? new Map(s.completionGates) : s.completionGates;
        if (gate) nextGates.delete(taskId);
        const tasks = gate && !s.tasks.some((t) => t.id === taskId)
          ? [...s.tasks, gate.completing.task]
          : s.tasks;
        return {
          completingTask: s.completingTask?.taskId === taskId ? null : s.completingTask,
          completingTaskIds: nextIds,
          completionGates: nextGates,
          tasks,
        };
      });
      // Reconcile positions from the DB (which never changed) in the background;
      // the optimistic re-insert above appends the task to restore visibility.
      void get().loadBoard();
    },

    finalizeCompletion: async () => {
      const completing = get().completingTask;
      if (!completing) return;
      const taskId = completing.taskId;
      // Force the gate fully open, synthesizing one if it is somehow missing,
      // then drive the move. Used by callers that want immediate completion.
      set((s) => {
        const existing = s.completionGates.get(taskId);
        const nextGates = new Map(s.completionGates);
        const base = existing ?? createGate(completing, false);
        nextGates.set(taskId, { ...base, animationDone: true, approved: true });
        return { completionGates: nextGates };
      });
      await persistCompletion(taskId);
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
  };
};
