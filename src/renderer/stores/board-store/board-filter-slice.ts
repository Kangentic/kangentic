import { type StateCreator } from 'zustand';
import type { BoardStore } from './types';

/**
 * Board-scoped quick filter + search state. Read by two siblings under
 * `AppLayout`: `ViewToggle` (the toolbar controls) and `KanbanBoard.tasksPerLane`
 * (the single lane-bucketing chokepoint that applies the filter). Living in the
 * store lets each subscribe to exactly what it needs instead of prop-drilling
 * through `AppLayout` and re-rendering the layout on every keystroke.
 *
 * Only the filter VALUES and the Ctrl+F focus signal live here. The popover
 * open-state, button/popover refs, and click-outside logic are ephemeral view
 * concerns with live DOM refs and stay in the shared `ToolbarSearchFilter`
 * component. This is the board's own filter, independent of the backlog's
 * (which keeps its own equivalent state in the backlog store).
 *
 * This is local UI truth (no IPC), so it has no `load*` / `sync*` method and is
 * intentionally absent from the App.tsx `vite:afterUpdate` re-sync block;
 * reset-on-HMR is benign and matches the prior local-state behavior.
 */
export interface BoardFilterSlice {
  priorityFilters: Set<number>;
  labelFilters: Set<string>;
  boardSearchQuery: string;
  /** Increments to request focus of the board search input (plain Ctrl+F). */
  boardSearchFocusNonce: number;
  /** Increments to request opening the New Task dialog (the task.create hotkey). */
  newTaskRequestNonce: number;
  /** Increments to request closing that dialog again. The mirror of the open nonce, for
   *  callers that opened it and now need it gone (the onboarding walkthrough's "Next step",
   *  which has to clear the surface before it can bring the checklist back). */
  newTaskDismissNonce: number;
  togglePriorityFilter: (value: number) => void;
  toggleLabelFilter: (label: string) => void;
  clearBoardFilters: () => void;
  setBoardSearchQuery: (query: string) => void;
  requestBoardSearchFocus: () => void;
  requestNewTask: () => void;
  dismissNewTask: () => void;
}

export const createBoardFilterSlice: StateCreator<BoardStore, [], [], BoardFilterSlice> = (set) => ({
  priorityFilters: new Set<number>(),
  labelFilters: new Set<string>(),
  boardSearchQuery: '',
  boardSearchFocusNonce: 0,
  newTaskRequestNonce: 0,
  newTaskDismissNonce: 0,

  togglePriorityFilter: (value) => set((state) => {
    const next = new Set(state.priorityFilters);
    if (next.has(value)) { next.delete(value); } else { next.add(value); }
    return { priorityFilters: next };
  }),

  toggleLabelFilter: (label) => set((state) => {
    const next = new Set(state.labelFilters);
    if (next.has(label)) { next.delete(label); } else { next.add(label); }
    return { labelFilters: next };
  }),

  // Clears the priority/label sets only, mirroring FilterPopover's "Clear all
  // filters". The search box has its own clear affordance.
  clearBoardFilters: () => set({ priorityFilters: new Set<number>(), labelFilters: new Set<string>() }),

  setBoardSearchQuery: (query) => set({ boardSearchQuery: query }),

  requestBoardSearchFocus: () => set((state) => ({ boardSearchFocusNonce: state.boardSearchFocusNonce + 1 })),

  // Each bump lands strictly PAST the other counter, so whichever was called last always
  // holds the higher number. A plain +1 on each let them tie when both fired in the same tick
  // ("close every surface, then open this one", which is how the onboarding walkthrough
  // advances into the create-a-task step) and the tie read as closed.
  requestNewTask: () => set((state) => ({
    newTaskRequestNonce: Math.max(state.newTaskRequestNonce, state.newTaskDismissNonce) + 1,
  })),

  dismissNewTask: () => set((state) => ({
    newTaskDismissNonce: Math.max(state.newTaskRequestNonce, state.newTaskDismissNonce) + 1,
  })),
});
