import { type StateCreator } from 'zustand';
import type { TaskMoveInput } from '../../../shared/types';
import type { BoardStore } from './types';

export interface TaskMoveConfirmSlice {
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

export const createTaskMoveConfirmSlice: StateCreator<BoardStore, [], [], TaskMoveConfirmSlice> = (set, get) => ({
  pendingMoveConfirm: null,
  confirmPendingMove: async () => {
    const pending = get().pendingMoveConfirm;
    if (!pending) return;
    // Guard against stale confirmation: the card was optimistically moved to
    // the target column on drop. If it's no longer there (e.g. the user dragged
    // it elsewhere while the dialog was open), the confirmation is stale.
    const currentTask = get().tasks.find((task) => task.id === pending.input.taskId);
    if (!currentTask || currentTask.swimlane_id !== pending.input.targetSwimlaneId) {
      set({ pendingMoveConfirm: null });
      await get().loadBoard();
      return;
    }
    set({ pendingMoveConfirm: null });
    await get().moveTask(pending.input, true);
  },
  cancelPendingMove: () => {
    set({ pendingMoveConfirm: null });
    // Revert the optimistic update - the move was never sent to the backend,
    // so loadBoard() restores the card to its original column from the DB.
    get().loadBoard();
  },
});
