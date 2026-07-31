/**
 * Unit tests for the lane-pin-slice Zustand slice actions
 * (`src/renderer/stores/board-store/lane-pin-slice.ts`).
 *
 * `tests/unit/board-lane-pin-lifecycle.test.ts` covers the PURE functions in
 * `lane-pins.ts` (`reconcileLanePins` / `applyTaskListPayload`); this file
 * covers the slice ACTIONS themselves - `pinTaskLane`, `dropTaskLanePin`, and
 * `clearLanePins` - which that file does not touch.
 *
 * The behavior under test: `dropTaskLanePin(taskId, expectedLaneId)` is a
 * no-op unless the currently-held pin's `laneId` matches `expectedLaneId`.
 * This ownership check stops a FAILING or superseded move from tearing down
 * a NEWER move's pin for the same task - `moveTask` pins during its
 * optimistic `set()` but does not claim its move generation until after the
 * `checkPendingChanges` probe, so two moves for the same task can briefly
 * overlap without either seeing the other.
 *
 * The slice is a Zustand `StateCreator` - a plain function of (set, get,
 * api). Driven directly via a minimal in-memory harness (the same pattern
 * used by `board-manager-slice.test.ts` / `archived-tasks-slice.test.ts`).
 * `lane-pin-slice.ts` imports only zustand types and `lane-pins.ts` (no
 * `window.electronAPI`, no other stores), so no mocking is required.
 */

import { describe, it, expect } from 'vitest';
import { createLanePinSlice } from '../../src/renderer/stores/board-store/lane-pin-slice';
import type { LanePinSlice } from '../../src/renderer/stores/board-store/lane-pin-slice';
import { EMPTY_LANE_PINS } from '../../src/renderer/stores/board-store/lane-pins';

const STAMP_1 = '2026-07-31T10:00:00.000Z';
const STAMP_2 = '2026-07-31T10:00:05.000Z';

function buildHarness(): { getState: () => LanePinSlice } {
  let state: LanePinSlice;

  const set = (
    updater: Partial<LanePinSlice> | ((previous: LanePinSlice) => Partial<LanePinSlice>),
  ) => {
    const patch = typeof updater === 'function' ? updater(state) : updater;
    state = { ...state, ...patch };
  };

  // StateCreator signature: (set, get, api). Only set/get are exercised by
  // this slice, so the api position is stubbed.
  const slice = createLanePinSlice(set as never, () => state as never, {} as never);
  state = { ...slice };

  return { getState: () => state };
}

describe('lane-pin-slice initial state', () => {
  it('starts with the shared EMPTY_LANE_PINS identity', () => {
    const { getState } = buildHarness();
    expect(getState().lanePins).toBe(EMPTY_LANE_PINS);
  });
});

describe('dropTaskLanePin - ownership check', () => {
  it('a STALE expected lane leaves a NEWER pin for the same task intact', () => {
    const { getState } = buildHarness();
    // A move pins the task to lane-b...
    getState().pinTaskLane('task-t', { laneId: 'lane-b', fromLaneId: 'lane-a', fromUpdatedAt: STAMP_1 });
    // ...then a second, newer move re-pins the same task to lane-c before the
    // first move's own drop runs (e.g. the first move failed or was
    // superseded, and its cleanup is only now catching up).
    getState().pinTaskLane('task-t', { laneId: 'lane-c', fromLaneId: 'lane-b', fromUpdatedAt: STAMP_2 });

    // The stale (first) move tries to release the pin it set - lane-b - which
    // is no longer the pin actually held.
    getState().dropTaskLanePin('task-t', 'lane-b');

    // Reverting to an unconditional delete strands the card mid-move: the
    // newer pin (lane-c) would be torn down by a move that has nothing to do
    // with it.
    expect(getState().lanePins.get('task-t')).toEqual({ laneId: 'lane-c', fromLaneId: 'lane-b', fromUpdatedAt: STAMP_2 });
  });

  it('a MATCHING expected lane does drop the pin', () => {
    const { getState } = buildHarness();
    getState().pinTaskLane('task-t', { laneId: 'lane-c', fromLaneId: 'lane-b', fromUpdatedAt: STAMP_1 });

    getState().dropTaskLanePin('task-t', 'lane-c');

    expect(getState().lanePins.has('task-t')).toBe(false);
  });

  it('for a task with NO pin is a no-op that returns the SAME state reference', () => {
    const { getState } = buildHarness();
    // A real (non-empty, non-singleton) Map, so the assertion cannot pass by
    // the EMPTY_LANE_PINS coincidence alone.
    getState().pinTaskLane('other-task', { laneId: 'lane-c', fromLaneId: 'lane-b', fromUpdatedAt: STAMP_1 });
    const before = getState().lanePins;

    getState().dropTaskLanePin('missing-task', 'lane-c');

    expect(getState().lanePins).toBe(before);
  });
});

describe('dropTaskLanePin - EMPTY_LANE_PINS identity', () => {
  it('dropping the LAST pin restores the shared EMPTY_LANE_PINS identity', () => {
    const { getState } = buildHarness();
    getState().pinTaskLane('task-t', { laneId: 'lane-c', fromLaneId: 'lane-b', fromUpdatedAt: STAMP_1 });

    getState().dropTaskLanePin('task-t', 'lane-c');

    // `lanePins` is a memo dependency of KanbanBoard's `tasksPerLane` - a
    // fresh (but content-equal) empty Map would invalidate the whole board's
    // lane bucketing on every store write, so the reference must be the
    // shared singleton, not just an empty Map.
    expect(getState().lanePins).toBe(EMPTY_LANE_PINS);
  });
});

describe('clearLanePins', () => {
  // No production caller today (flagged separately in review); tested so it
  // is not silently broken if it gets wired up.
  it('empties the map and restores the shared EMPTY_LANE_PINS identity', () => {
    const { getState } = buildHarness();
    getState().pinTaskLane('task-a', { laneId: 'lane-b', fromLaneId: 'lane-a', fromUpdatedAt: STAMP_1 });
    getState().pinTaskLane('task-b', { laneId: 'lane-c', fromLaneId: 'lane-a', fromUpdatedAt: STAMP_1 });

    getState().clearLanePins();

    expect(getState().lanePins.size).toBe(0);
    expect(getState().lanePins).toBe(EMPTY_LANE_PINS);
  });
});
