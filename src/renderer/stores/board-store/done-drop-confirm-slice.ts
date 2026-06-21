import { type StateCreator } from 'zustand';
import type { GitPendingChangesResult, Task, TaskMoveInput } from '../../../shared/types';
import { useProjectStore } from '../project-store';
import type { BoardStore, CompletingTask, PendingDoneConfirm } from './types';

export type PendingChangesInfo = Pick<GitPendingChangesResult, 'hasPendingChanges' | 'uncommittedFileCount' | 'unpushedCommitCount' | 'currentBranch'> & {
  /** Captured at drop time so the dialog can state whether the branch is kept or force-deleted. */
  autoCleanup: boolean;
};

export interface DoneDropConfirmSlice {
  pendingDoneConfirm: PendingDoneConfirm | null;
  /** Confirmations that arrived while one was already open. Two worktree drops
   *  in quick succession can both come back dirty; the second waits here so its
   *  gate is not orphaned (which would wedge the task hidden). FIFO. */
  pendingDoneConfirmQueue: PendingDoneConfirm[];
  requestDoneConfirmAnimated: (completing: CompletingTask, pendingChanges: PendingChangesInfo) => void;
  requestDoneConfirmDirect: (task: Task, input: TaskMoveInput, pendingChanges: PendingChangesInfo) => void;
  confirmPendingDone: () => Promise<void>;
  cancelPendingDone: () => void;
}

export const createDoneDropConfirmSlice: StateCreator<BoardStore, [], [], DoneDropConfirmSlice> = (set, get) => {
  // Show `next` if the slot is free, otherwise queue it.
  const enqueueConfirm = (next: PendingDoneConfirm) => {
    set((s) =>
      s.pendingDoneConfirm
        ? { pendingDoneConfirmQueue: [...s.pendingDoneConfirmQueue, next] }
        : { pendingDoneConfirm: next },
    );
  };

  // Clear the current slot and promote the next queued confirmation, if any.
  const advanceQueue = () => {
    set((s) => {
      const [next, ...rest] = s.pendingDoneConfirmQueue;
      return { pendingDoneConfirm: next ?? null, pendingDoneConfirmQueue: rest };
    });
  };

  return {
    pendingDoneConfirm: null,
    pendingDoneConfirmQueue: [],

    requestDoneConfirmAnimated: (completing, pendingChanges) => {
      enqueueConfirm({
        kind: 'animated',
        task: completing.task,
        completing,
        hasPendingChanges: pendingChanges.hasPendingChanges,
        uncommittedFileCount: pendingChanges.uncommittedFileCount,
        unpushedCommitCount: pendingChanges.unpushedCommitCount,
        currentBranch: pendingChanges.currentBranch,
        autoCleanup: pendingChanges.autoCleanup,
      });
    },

    requestDoneConfirmDirect: (task, input, pendingChanges) => {
      enqueueConfirm({
        kind: 'direct',
        task,
        input,
        hasPendingChanges: pendingChanges.hasPendingChanges,
        uncommittedFileCount: pendingChanges.uncommittedFileCount,
        unpushedCommitCount: pendingChanges.unpushedCommitCount,
        currentBranch: pendingChanges.currentBranch,
        autoCleanup: pendingChanges.autoCleanup,
      });
    },

    confirmPendingDone: async () => {
      const pending = get().pendingDoneConfirm;
      if (!pending) return;
      advanceQueue();
      if (pending.kind === 'animated') {
        // The FlyingCard is already mounted and flying (gated). Approving the
        // gate lets it persist once the fly finishes. If the gate is gone (it
        // was removed by an intervening supersede or cancel while this dialog
        // was still pending), fall back to mounting a fresh ungated completion
        // so confirm is never a silent no-op.
        if (get().completionGates.has(pending.completing.taskId)) {
          get().approveCompletion(pending.completing.taskId);
        } else {
          get().setCompletingTask(pending.completing);
        }
      } else {
        // Drop-fallback path: no animation, move directly. The confirm dialog is
        // modal against the current project, so capturing the live current
        // project here is interaction-time-correct.
        await get().moveTask(pending.input, false, useProjectStore.getState().currentProject?.id ?? null);
      }
    },

    cancelPendingDone: () => {
      const pending = get().pendingDoneConfirm;
      if (!pending) return;
      advanceQueue();
      if (pending.kind === 'animated') {
        // The FlyingCard was mounted on drop and the task removed from the tasks
        // array, so cancel must fully restore: unmount the card, re-insert the
        // task into its source lane, and release the chokepoint guard.
        get().cancelCompletion(pending.task.id);
      } else {
        // Direct path never removed the task from `tasks`; just release the
        // guard added on drop so it renders again.
        get().removeCompletingTaskId(pending.task.id);
      }
    },
  };
};
