import { type StateCreator } from 'zustand';
import type { TaskMoveInput } from '../../../shared/types';
import { useProjectStore } from '../project-store';
import type { BoardStore } from './types';

export interface PendingMoveConfirm {
  input: TaskMoveInput;
  uncommittedFileCount: number;
  unpushedCommitCount: number;
  taskTitle: string;
  hasWorktree: boolean;
}

export interface TaskMoveConfirmSlice {
  /**
   * FIFO queue of moves awaiting confirmation; the head is the one on screen.
   *
   * This was a single nullable slot, which silently dropped a move: two rapid
   * drags that both need confirmation meant the second `set` overwrote the
   * first, and that first move had already returned `{ ok: true }` from
   * `moveTask` WITHOUT calling the IPC. Its optimistic placement then sat in
   * the store with no backing write, so the next reload snapped it back
   * permanently - not the momentary flicker of the stale-reload bug, but a
   * lasting wrong state with no error surfaced anywhere.
   */
  pendingMoveConfirms: PendingMoveConfirm[];
  /** The confirmation currently on screen, or null. */
  pendingMoveConfirm: PendingMoveConfirm | null;
  enqueueMoveConfirm: (pending: PendingMoveConfirm) => void;
  confirmPendingMove: () => Promise<void>;
  cancelPendingMove: () => void;
}

/** Drop the head and promote the next queued confirmation (if any). */
function shiftQueue(queue: PendingMoveConfirm[]): Partial<BoardStore> {
  const remaining = queue.slice(1);
  return { pendingMoveConfirms: remaining, pendingMoveConfirm: remaining[0] ?? null };
}

export const createTaskMoveConfirmSlice: StateCreator<BoardStore, [], [], TaskMoveConfirmSlice> = (set, get) => ({
  pendingMoveConfirms: [],
  pendingMoveConfirm: null,

  enqueueMoveConfirm: (pending) => {
    set((state) => {
      // De-dupe by task: a second confirmation for the same task supersedes the
      // queued one rather than asking twice.
      //
      // Replaced IN PLACE rather than filtered-and-appended. Superseding the
      // entry currently on screen (index 0) by removing it would promote a
      // DIFFERENT task's confirmation into the already-open dialog with no user
      // action, so the next click would answer a question that was never shown.
      // Appending also re-ordered the superseding entry behind older queued
      // ones, which is not what "supersedes" means.
      const queue = [...state.pendingMoveConfirms];
      const existingIndex = queue.findIndex((queued) => queued.input.taskId === pending.input.taskId);
      if (existingIndex >= 0) queue[existingIndex] = pending;
      else queue.push(pending);
      return { pendingMoveConfirms: queue, pendingMoveConfirm: queue[0] };
    });
  },

  confirmPendingMove: async () => {
    const pending = get().pendingMoveConfirm;
    if (!pending) return;
    // Guard against stale confirmation: the card was optimistically moved to
    // the target column on drop. If it's no longer there (e.g. the user dragged
    // it elsewhere while the dialog was open), the confirmation is stale.
    //
    // Read the lane pin first. A reload landing while the dialog was open can
    // clobber `swimlane_id` back to the origin even though the card is still
    // rendering at the target (that is exactly what the pin is for), and a
    // plain `swimlane_id` check would then read that as "the user moved it" and
    // silently no-op the move the user just confirmed.
    const currentTask = get().tasks.find((task) => task.id === pending.input.taskId);
    const effectiveLane = get().lanePins.get(pending.input.taskId)?.laneId ?? currentTask?.swimlane_id;
    if (!currentTask || effectiveLane !== pending.input.targetSwimlaneId) {
      // Nothing was ever written for this move, so no payload can ever differ
      // from the pinned snapshot and the content-based drop would never fire.
      get().dropTaskLanePin(pending.input.taskId, pending.input.targetSwimlaneId);
      set((state) => shiftQueue(state.pendingMoveConfirms));
      await get().loadBoard();
      return;
    }
    set((state) => shiftQueue(state.pendingMoveConfirms));
    // Modal dialog against the current project; live capture is interaction-time-correct.
    // Re-enters moveTask, which re-pins the same lane idempotently.
    await get().moveTask(pending.input, true, useProjectStore.getState().currentProject?.id ?? null);
  },

  cancelPendingMove: () => {
    const pending = get().pendingMoveConfirm;
    set((state) => shiftQueue(state.pendingMoveConfirms));
    // Revert the optimistic update - the move was never sent to the backend,
    // so loadBoard() restores the card to its original column from the DB.
    // Release the pin first, or it would hold the card at the declined target
    // forever: with no write, the server keeps reporting the pre-move snapshot
    // and the content-based drop can never fire.
    if (pending) get().dropTaskLanePin(pending.input.taskId, pending.input.targetSwimlaneId);
    get().loadBoard();
  },
});
