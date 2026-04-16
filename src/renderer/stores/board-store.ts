import { create } from 'zustand';
import type { BoardStore } from './board-store/types';
import { createTaskSlice } from './board-store/task-slice';
import { createSwimlaneSlice } from './board-store/swimlane-slice';
import { createArchivedTasksSlice } from './board-store/archived-tasks-slice';
import { createTaskCompletionSlice } from './board-store/task-completion-slice';
import { createBoardSearchSlice } from './board-store/board-search-slice';
import { createBoardConfigSlice } from './board-store/board-config-slice';
import { createBoardHydrationSlice } from './board-store/board-hydration-slice';
import { createTaskMoveConfirmSlice } from './board-store/task-move-confirm-slice';
import { createDoneDropConfirmSlice } from './board-store/done-drop-confirm-slice';
import { createActiveViewSlice } from './board-store/active-view-slice';

/**
 * Board store composition. Slice interfaces and implementations live
 * under ./board-store/; this file wires them into a single Zustand
 * store instance.
 *
 * Single-instance invariant: all slices share one `set` / `get` pair
 * so cross-slice calls (e.g. task-slice's moveTask calling
 * `get().loadBoard()`) work transparently. Splitting into multiple
 * stores would break subscription semantics and the HMR re-sync
 * pattern in App.tsx.
 *
 * HMR re-sync: the `vite:afterUpdate` handler in App.tsx calls
 * `loadBoard()` and `loadShortcuts()` after hot reload. The
 * hmr-resync.test.ts unit test enforces that every `load*` / `sync*`
 * method on this store is referenced in that handler - do not rename
 * or remove without updating both.
 */
export const useBoardStore = create<BoardStore>((...args) => ({
  ...createTaskSlice(...args),
  ...createSwimlaneSlice(...args),
  ...createArchivedTasksSlice(...args),
  ...createTaskCompletionSlice(...args),
  ...createBoardSearchSlice(...args),
  ...createBoardConfigSlice(...args),
  ...createBoardHydrationSlice(...args),
  ...createTaskMoveConfirmSlice(...args),
  ...createDoneDropConfirmSlice(...args),
  ...createActiveViewSlice(...args),
}));
