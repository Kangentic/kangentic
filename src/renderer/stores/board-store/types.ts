import type { Task, TaskMoveInput } from '../../../shared/types';
import type { TaskSlice } from './task-slice';
import type { SwimlaneSlice } from './swimlane-slice';
import type { ArchivedTasksSlice } from './archived-tasks-slice';
import type { TaskCompletionSlice } from './task-completion-slice';
import type { BoardSearchSlice } from './board-search-slice';
import type { BoardConfigSlice } from './board-config-slice';
import type { BoardHydrationSlice } from './board-hydration-slice';
import type { TaskMoveConfirmSlice } from './task-move-confirm-slice';
import type { DoneDropConfirmSlice } from './done-drop-confirm-slice';
import type { ActiveViewSlice } from './active-view-slice';

/**
 * Rect captured from the task card at drag start so the FlyingCard
 * animation knows where to fly from when dropped on Done.
 */
export interface CompletingTask {
  taskId: string;
  targetSwimlaneId: string;
  targetPosition: number;
  originSwimlaneId: string;
  task: Task;
  startRect: { left: number; top: number; width: number; height: number };
}

/**
 * Done-drop confirmation payload. Two shapes:
 *   - `animated`: the usual drop flow, with a fly-into-Done animation.
 *   - `direct`: fallback when the drag origin rect was lost mid-drag
 *     (HMR / DOM destruction). Skips the animation but still routes
 *     through the confirm dialog so the destructive worktree delete
 *     isn't silent.
 * `task` is kept on both shapes so the dialog can show the task title.
 */
export type PendingDoneConfirm =
  | { kind: 'animated'; task: Task; completing: CompletingTask }
  | { kind: 'direct'; task: Task; input: TaskMoveInput };

/**
 * Composite board store type. Every slice file declares its own
 * interface and its StateCreator uses `BoardStore` to read sibling
 * state (e.g. `get().loadBoard()` from task-slice references the
 * board-hydration slice's method).
 */
export type BoardStore = TaskSlice & SwimlaneSlice & ArchivedTasksSlice & TaskCompletionSlice
  & BoardSearchSlice & BoardConfigSlice & BoardHydrationSlice & TaskMoveConfirmSlice
  & DoneDropConfirmSlice & ActiveViewSlice;
