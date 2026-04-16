import { type StateCreator } from 'zustand';
import type { Task, TaskMoveInput } from '../../../shared/types';
import type { BoardStore, CompletingTask, PendingDoneConfirm } from './types';

export interface DoneDropConfirmSlice {
  pendingDoneConfirm: PendingDoneConfirm | null;
  requestDoneConfirmAnimated: (completing: CompletingTask) => void;
  requestDoneConfirmDirect: (task: Task, input: TaskMoveInput) => void;
  confirmPendingDone: () => Promise<void>;
  cancelPendingDone: () => void;
}

export const createDoneDropConfirmSlice: StateCreator<BoardStore, [], [], DoneDropConfirmSlice> = (set, get) => ({
  pendingDoneConfirm: null,
  requestDoneConfirmAnimated: (completing) => {
    set({ pendingDoneConfirm: { kind: 'animated', task: completing.task, completing } });
  },
  requestDoneConfirmDirect: (task, input) => {
    set({ pendingDoneConfirm: { kind: 'direct', task, input } });
  },
  confirmPendingDone: async () => {
    const pending = get().pendingDoneConfirm;
    if (!pending) return;
    set({ pendingDoneConfirm: null });
    if (pending.kind === 'animated') {
      // Hand off to the existing fly-into-Done animation, which calls
      // moveTask via finalizeCompletion on transition end.
      get().setCompletingTask(pending.completing);
    } else {
      // Drop-fallback path: skip the animation and move directly.
      await get().moveTask(pending.input);
    }
  },
  cancelPendingDone: () => {
    // Full no-op: the drag ended without ever committing the move, so the
    // task is still in its original column in both the store and the DB.
    set({ pendingDoneConfirm: null });
  },
});
