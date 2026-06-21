import { create } from 'zustand';
import type { BoardStore } from './board-store/types';
import { createTaskSlice } from './board-store/task-slice';
import { createSwimlaneSlice } from './board-store/swimlane-slice';
import { createArchivedTasksSlice } from './board-store/archived-tasks-slice';
import { createTaskCompletionSlice } from './board-store/task-completion-slice';
import { createBoardConfigSlice } from './board-store/board-config-slice';
import { createBoardHydrationSlice } from './board-store/board-hydration-slice';
import { createTaskMoveConfirmSlice } from './board-store/task-move-confirm-slice';
import { createDoneDropConfirmSlice } from './board-store/done-drop-confirm-slice';
import { createActiveViewSlice } from './board-store/active-view-slice';
import { createBoardManagerSlice } from './board-store/board-manager-slice';
import { createBoardFilterSlice } from './board-store/board-filter-slice';

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
 * `loadBoard()` and `loadShortcuts()` after hot reload to reconcile with
 * main-process truth. The hmr-resync.test.ts unit test enforces that every
 * `load*` / `sync*` method on this store is referenced in that handler - do
 * not rename or remove without updating both.
 *
 * HMR instance pinning (Pattern E, see .claude/rules/hmr-patterns.md): this
 * module's only runtime export is the non-component `useBoardStore`, so it is
 * not a React Fast Refresh boundary. A Fast Refresh that re-evaluates this
 * module (a slice edit, or an edit to a store it imports) would otherwise
 * construct a SECOND store instance while the mounted board stays subscribed to
 * the first, stranding agent/MCP-created tasks until a full reload. Pinning the
 * instance in `import.meta.hot.data` guarantees a single store across HMR cycles.
 */
export function createBoardStore() {
  return create<BoardStore>((...args) => ({
    ...createTaskSlice(...args),
    ...createSwimlaneSlice(...args),
    ...createArchivedTasksSlice(...args),
    ...createTaskCompletionSlice(...args),
    ...createBoardConfigSlice(...args),
    ...createBoardHydrationSlice(...args),
    ...createTaskMoveConfirmSlice(...args),
    ...createDoneDropConfirmSlice(...args),
    ...createActiveViewSlice(...args),
    ...createBoardManagerSlice(...args),
    ...createBoardFilterSlice(...args),
  }));
}

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedBoardStore: ReturnType<typeof createBoardStore> | undefined = import.meta.hot?.data?.boardStore;

export const useBoardStore = preservedBoardStore ?? createBoardStore();

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.boardStore = useBoardStore;
  // Editing this module's OWN code would leave the pinned instance running stale
  // slice closures; force a clean full reload instead. Rare; prod is unaffected
  // (import.meta.hot is undefined there, so this whole block is dropped).
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
