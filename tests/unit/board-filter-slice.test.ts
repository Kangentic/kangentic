/**
 * Unit tests for the board-filter-slice Zustand slice, focused on the
 * `requestNewTask` / `dismissNewTask` nonce ordering.
 *
 * The pair guards a real race: the onboarding walkthrough's "Next step" closes
 * every open surface (dismissNewTask, via closeStepSurfaces) and then, for the
 * "Create a task" step, immediately opens the New Task dialog (requestNewTask)
 * - both calls synchronous, in the same tick. `KanbanBoard.tsx` derives
 * `newTaskOpen` from a single comparison, `newTaskRequestNonce >
 * newTaskDismissNonce`. A naive `+1` on each counter (instead of
 * `Math.max(request, dismiss) + 1`) ties both nonces at 1 after
 * dismiss-then-request from a fresh (0, 0) state, and the strict `>` reads a
 * tie as closed: the dialog silently fails to open.
 *
 * `tests/ui/onboarding-walkthrough.spec.ts`'s "creating a task ticks step 3
 * without any manual check-off" already exercises this end-to-end (it fills
 * the New Task dialog's title input after clicking the taskCreated row, which
 * goes through the exact same dismiss-then-request call) and goes red under
 * the same `+1` mutation. This file pins the same invariant directly against
 * the slice, in milliseconds instead of seconds, isolating the nonce math from
 * dialog mount timing.
 *
 * Only the dismiss-then-request ordering discriminates against a naive `+1`:
 * the reverse order (request-then-dismiss) and any tie both resolve to
 * "closed" under the strict `>` comparison whether the counters use `+1` or
 * `Math.max(...) + 1`, so a symmetric test in that direction would pass
 * against a broken implementation and is deliberately not included here.
 *
 * Scaffold mirrors `tests/unit/board-manager-slice.test.ts`'s `buildSlice()`
 * pattern: the StateCreator is invoked directly with a plain-object `set`,
 * with the `get` and store positions typed away since these tests only need
 * `set`.
 */
import { describe, it, expect } from 'vitest';
import { createBoardFilterSlice } from '../../src/renderer/stores/board-store/board-filter-slice';
import type { BoardFilterSlice } from '../../src/renderer/stores/board-store/board-filter-slice';

function buildSlice(): { getState: () => BoardFilterSlice } {
  let state: BoardFilterSlice = {} as BoardFilterSlice;

  const set = (updater: Partial<BoardFilterSlice> | ((previous: BoardFilterSlice) => Partial<BoardFilterSlice>)) => {
    const patch = typeof updater === 'function' ? updater(state) : updater;
    state = { ...state, ...patch };
  };

  const slice = createBoardFilterSlice(set as Parameters<typeof createBoardFilterSlice>[0], () => state as never, {} as never);
  state = { ...slice };

  return { getState: () => state };
}

describe('board-filter-slice initial state', () => {
  it('starts both New Task nonces at 0', () => {
    // KanbanBoard's mount guard (`newTaskRequestNonce === 0 && newTaskDismissNonce === 0`)
    // treats this exact starting pair as "nothing requested yet, do not touch newTaskOpen" -
    // the invariant below only matters once either counter has moved off of it.
    const { getState } = buildSlice();
    expect(getState().newTaskRequestNonce).toBe(0);
    expect(getState().newTaskDismissNonce).toBe(0);
  });
});

describe('requestNewTask / dismissNewTask nonce ordering', () => {
  it('a bare requestNewTask() puts the request nonce ahead of the dismiss nonce', () => {
    const { getState } = buildSlice();
    getState().requestNewTask();
    expect(getState().newTaskRequestNonce).toBeGreaterThan(getState().newTaskDismissNonce);
  });

  it('a bare dismissNewTask() puts the dismiss nonce ahead of the request nonce', () => {
    const { getState } = buildSlice();
    getState().dismissNewTask();
    expect(getState().newTaskDismissNonce).toBeGreaterThan(getState().newTaskRequestNonce);
  });

  it('dismissing then requesting in the same tick resolves as OPEN, not a tie', () => {
    // The discriminating scenario: from a fresh slice, dismissNewTask() then
    // requestNewTask() (the walkthrough's closeStepSurfaces -> activate order for
    // the "Create a task" step). A naive `+1` on each counter ties both at 1 here,
    // which KanbanBoard's strict `newTaskRequestNonce > newTaskDismissNonce` reads
    // as closed - the bug this test exists to catch.
    const { getState } = buildSlice();

    getState().dismissNewTask();
    getState().requestNewTask();

    expect(getState().newTaskRequestNonce).toBeGreaterThan(getState().newTaskDismissNonce);
  });
});
