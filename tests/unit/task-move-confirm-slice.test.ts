/**
 * Unit tests for the task-move-confirm-slice Zustand slice
 * (`src/renderer/stores/board-store/task-move-confirm-slice.ts`).
 *
 * `moveTask` awaits a `git.checkPendingChanges` probe BEFORE any confirmation
 * dialog is shown, so two moves started inside that probe window can both
 * resolve needing confirmation. The pending confirmation used to be a single
 * nullable slot, so the second `enqueueMoveConfirm` overwrote the first - and
 * that first move had ALREADY returned `{ ok: true }` WITHOUT calling the IPC,
 * leaving an optimistic placement with no backing write and no error surfaced
 * anywhere. It is now a FIFO queue (`pendingMoveConfirms`) whose head is
 * mirrored on `pendingMoveConfirm`. This file pins that queue's behavior:
 * multiple in-flight confirmations survive, `confirmPendingMove` /
 * `cancelPendingMove` promote the next entry rather than dropping it, and a
 * repeat confirmation for an already-queued task supersedes it IN PLACE
 * instead of re-ordering it behind newer entries.
 *
 * The slice is a Zustand `StateCreator` - a plain function of (set, get,
 * api). Driven directly via a minimal in-memory harness (the same pattern
 * used by `archived-tasks-slice.test.ts` / `board-manager-slice.test.ts`), so
 * no real board store, Electron, or DOM is required. `moveTask` / `loadBoard`
 * / `dropTaskLanePin` are sibling-slice methods the real store would supply;
 * here they are stubbed directly on the harness state and asserted on via
 * their call args, per the task-builder brief. `useProjectStore` is mocked
 * (the slice imports it directly to stamp `moveTask`'s `projectId`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, TaskMoveInput } from '../../src/shared/types';
import type { LanePin } from '../../src/renderer/stores/board-store/lane-pins';

// ---------------------------------------------------------------------------
// Hoisted store mock - vi.mock factories run before this file's other
// top-level statements, so mutable mock state must be created via vi.hoisted.
// ---------------------------------------------------------------------------

const storeMocks = vi.hoisted(() => ({
  useProjectStore: { getState: vi.fn() },
}));

vi.mock('../../src/renderer/stores/project-store', () => ({ useProjectStore: storeMocks.useProjectStore }));

const { useProjectStore } = storeMocks;

import { createTaskMoveConfirmSlice } from '../../src/renderer/stores/board-store/task-move-confirm-slice';
import type { TaskMoveConfirmSlice, PendingMoveConfirm } from '../../src/renderer/stores/board-store/task-move-confirm-slice';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    display_id: 1,
    title: 'A task',
    description: '',
    swimlane_id: 'lane-executing',
    position: 0,
    agent: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    head_sha: null,
    external_id: null,
    external_source: null,
    external_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    model_override: null,
    effort_override: null,
    agent_override: null,
    attachment_count: 0,
    detail_view_state: null,
    archived_at: null,
    created_at: '2026-07-31T10:00:00.000Z',
    updated_at: '2026-07-31T10:00:00.000Z',
    ...overrides,
  };
}

function makePending(taskId: string, overrides: Partial<PendingMoveConfirm> = {}): PendingMoveConfirm {
  const input: TaskMoveInput = { taskId, targetSwimlaneId: 'lane-todo', targetPosition: 0 };
  return {
    input,
    uncommittedFileCount: 1,
    unpushedCommitCount: 0,
    taskTitle: `Task ${taskId}`,
    hasWorktree: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Slice harness - constructs the slice with a closure-backed set/get, plus
// the sibling-slice fields (`tasks`, `lanePins`, `moveTask`, `loadBoard`,
// `dropTaskLanePin`) the real board store supplies from other slices.
// ---------------------------------------------------------------------------

type HarnessState = TaskMoveConfirmSlice & {
  tasks: Task[];
  lanePins: ReadonlyMap<string, LanePin>;
  moveTask: (input: TaskMoveInput, skipConfirmation?: boolean, projectId?: string | null) => Promise<{ ok: boolean }>;
  loadBoard: () => Promise<void>;
  dropTaskLanePin: (taskId: string, expectedLaneId: string) => void;
};

function buildHarness(initial: Partial<HarnessState> = {}): { getState: () => HarnessState } {
  let state: HarnessState;

  const set = (
    updater: Partial<HarnessState> | ((previous: HarnessState) => Partial<HarnessState>),
  ) => {
    const patch = typeof updater === 'function' ? updater(state) : updater;
    state = { ...state, ...patch };
  };

  const get = () => state;

  // StateCreator signature: (set, get, api). Only set/get are exercised by
  // this slice, so the api position is stubbed.
  const slice = createTaskMoveConfirmSlice(set as never, get as never, {} as never);

  state = {
    tasks: [],
    lanePins: new Map(),
    moveTask: vi.fn(async () => ({ ok: true })),
    loadBoard: vi.fn(async () => {}),
    dropTaskLanePin: vi.fn(),
    ...slice,
    ...initial,
  };

  return { getState: get };
}

beforeEach(() => {
  vi.resetAllMocks();
  useProjectStore.getState.mockReturnValue({ currentProject: { id: 'project-a' } });
});

// ---------------------------------------------------------------------------
// enqueueMoveConfirm - FIFO queue
// ---------------------------------------------------------------------------

describe('enqueueMoveConfirm', () => {
  it('keeps confirmations for two DIFFERENT tasks, with the first enqueued as head', () => {
    const { getState } = buildHarness();
    const pendingA = makePending('task-a');
    const pendingB = makePending('task-b');

    getState().enqueueMoveConfirm(pendingA);
    getState().enqueueMoveConfirm(pendingB);

    // Reverting to a single nullable slot loses pendingA the instant pendingB
    // is enqueued: pendingMoveConfirms would not exist as a growing queue and
    // pendingMoveConfirm would already read pendingB here.
    expect(getState().pendingMoveConfirms).toEqual([pendingA, pendingB]);
    expect(getState().pendingMoveConfirm).toEqual(pendingA);
  });

  it('re-enqueuing an already-queued task supersedes it IN PLACE, without changing its position', () => {
    const { getState } = buildHarness();
    const pendingA = makePending('task-a', { uncommittedFileCount: 1 });
    const pendingB = makePending('task-b');
    // A later probe for the SAME task, carrying a newer payload.
    const pendingAUpdated = makePending('task-a', { uncommittedFileCount: 5 });

    getState().enqueueMoveConfirm(pendingA);
    getState().enqueueMoveConfirm(pendingB);
    getState().enqueueMoveConfirm(pendingAUpdated);

    // Still task-a at the head, carrying the newer payload - NOT task-b
    // promoted into the dialog that was already on screen. A
    // filter-and-push implementation would drop task-a from index 0 and
    // promote task-b, so the user's next click would answer a question
    // they were never shown.
    expect(getState().pendingMoveConfirm).toEqual(pendingAUpdated);
    expect(getState().pendingMoveConfirms).toEqual([pendingAUpdated, pendingB]);
  });
});

// ---------------------------------------------------------------------------
// confirmPendingMove - promotes the next queued confirmation
// ---------------------------------------------------------------------------

describe('confirmPendingMove', () => {
  it('on a queue of two, promotes the second rather than dropping it (core regression)', async () => {
    const pendingA = makePending('task-a');
    const pendingB = makePending('task-b');
    const { getState } = buildHarness({
      // currentTask.swimlane_id already matches the pending target, and no
      // lane pin overrides it, so confirmPendingMove takes the "not stale"
      // branch and re-invokes moveTask.
      tasks: [makeTask({ id: 'task-a', swimlane_id: 'lane-todo' })],
    });
    getState().enqueueMoveConfirm(pendingA);
    getState().enqueueMoveConfirm(pendingB);

    const confirmPromise = getState().confirmPendingMove();

    // The queue shift happens synchronously, before the awaited moveTask
    // call, so the promotion is already visible without awaiting.
    expect(getState().pendingMoveConfirms).toEqual([pendingB]);
    expect(getState().pendingMoveConfirm).toEqual(pendingB);

    await confirmPromise;

    expect(getState().moveTask).toHaveBeenCalledWith(pendingA.input, true, 'project-a');
    expect(getState().dropTaskLanePin).not.toHaveBeenCalled();
    expect(getState().loadBoard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cancelPendingMove - promotes the next queued confirmation
// ---------------------------------------------------------------------------

describe('cancelPendingMove', () => {
  it('on a queue of two, promotes the next and leaves it on screen', () => {
    const pendingA = makePending('task-a');
    const pendingB = makePending('task-b');
    const { getState } = buildHarness();
    getState().enqueueMoveConfirm(pendingA);
    getState().enqueueMoveConfirm(pendingB);

    getState().cancelPendingMove();

    expect(getState().pendingMoveConfirms).toEqual([pendingB]);
    expect(getState().pendingMoveConfirm).toEqual(pendingB);
    // Releases the CANCELLED move's pin (task-a's), not task-b's.
    expect(getState().dropTaskLanePin).toHaveBeenCalledWith('task-a', pendingA.input.targetSwimlaneId);
    expect(getState().loadBoard).toHaveBeenCalledTimes(1);
  });

  it('drains the queue to empty and returns pendingMoveConfirm to null', () => {
    const { getState } = buildHarness();
    getState().enqueueMoveConfirm(makePending('task-a'));

    getState().cancelPendingMove();

    expect(getState().pendingMoveConfirms).toEqual([]);
    expect(getState().pendingMoveConfirm).toBeNull();
  });
});
