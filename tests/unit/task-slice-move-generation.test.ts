/**
 * Unit tests for `moveTask`'s per-task generation supersession
 * (`src/renderer/stores/board-store/task-slice.ts`, the module-scope
 * `moveGenerations` map, `claimMoveGeneration` / `isSupersededMove`).
 *
 * The regression: `moveGeneration` used to be ONE counter shared by every
 * task. Dragging two DIFFERENT tasks in quick succession meant the second
 * move's `claimMoveGeneration` bumped the SAME counter the first move was
 * still waiting on, so the first move's post-await check
 * (`moveGeneration !== thisGen`) read "superseded" even though nothing about
 * ITS OWN move was superseded - its reload was silently dropped and nothing
 * else ever repaired the board for that task. It is now a `Map<taskId,
 * number>`, so a claim for task B cannot affect task A's generation.
 *
 * `claimMoveGeneration` / `isSupersededMove` are module-private (not
 * exported) - exporting them for a test would just assert a `Map.get` against
 * the key handed to it, which is tautological and adds production surface for
 * no functional reason. The only thing that actually matters is observable
 * through `moveTask` itself: WHICH `tasks.list()` payload ends up written to
 * the store. So this drives the real `moveTask` twice with controlled,
 * distinguishable `tasks.list()` results and asserts on the final `tasks`
 * array, the same way `task-move-confirm-slice.test.ts` drives the real
 * `enqueueMoveConfirm` rather than asserting on a queue index directly.
 *
 * Both tasks are seeded with `worktree_path: null, branch_name: null` and
 * moved with `skipConfirmation: true` so the destructive-move confirmation
 * probe (`git.checkPendingChanges` / `enqueueMoveConfirm`) never enters the
 * picture - the fixture trick `move-stale-reload-no-lane-flash.spec.ts` also
 * relies on. The target lane's `role` is deliberately neither `'done'` nor
 * `'todo'` and `auto_spawn: false`, so none of moveTask's Done-completion or
 * session-eviction/spawn-progress branches fire either - the only thing under
 * test is the generation guard.
 *
 * The slice is a Zustand `StateCreator` - a plain function of (set, get,
 * api). Driven directly via a minimal in-memory harness (the same pattern
 * used by `archived-tasks-slice.test.ts` / `task-move-confirm-slice.test.ts`),
 * so no real board store, Electron, or DOM is required. `useProjectStore` /
 * `useToastStore` / `useSessionStore` are mocked via `vi.mock`;
 * `fetchArchivedReconcile` (imported by task-slice.ts from
 * archived-tasks-slice.ts) is left real and resolves through the same
 * `window.electronAPI` stub, returning an empty preview.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane, TaskMoveInput } from '../../src/shared/types';
import type { LanePin } from '../../src/renderer/stores/board-store/lane-pins';

// ---------------------------------------------------------------------------
// Hoisted store mocks - vi.mock factories run before this file's other
// top-level statements, so mutable mock state must be created via vi.hoisted.
// ---------------------------------------------------------------------------

const storeMocks = vi.hoisted(() => ({
  useProjectStore: { getState: vi.fn() },
  useToastStore: { getState: vi.fn() },
  useSessionStore: { getState: vi.fn(), setState: vi.fn() },
}));

vi.mock('../../src/renderer/stores/project-store', () => ({ useProjectStore: storeMocks.useProjectStore }));
vi.mock('../../src/renderer/stores/toast-store', () => ({ useToastStore: storeMocks.useToastStore }));
vi.mock('../../src/renderer/stores/session-store', () => ({ useSessionStore: storeMocks.useSessionStore }));

const { useProjectStore, useToastStore, useSessionStore } = storeMocks;

// window.electronAPI stub. vitest's default (node) environment has no
// `window`, so we attach it to globalThis before importing the slice -
// mirrors the pattern in `archived-tasks-slice.test.ts`.
const tasksApi = {
  move: vi.fn(),
  list: vi.fn(),
  listArchivedPreview: vi.fn(),
};
const gitApi = {
  checkPendingChanges: vi.fn(),
};

(globalThis as Record<string, unknown>).window = {
  electronAPI: { tasks: tasksApi, git: gitApi },
};

// Imported after the mocks/stub so the slice module (and the
// archived-tasks-slice module it pulls `fetchArchivedReconcile` from)
// resolve the mocked stores and the stubbed window.
import { createTaskSlice } from '../../src/renderer/stores/board-store/task-slice';
import type { TaskSlice } from '../../src/renderer/stores/board-store/task-slice';
import { EMPTY_LANE_PINS } from '../../src/renderer/stores/board-store/lane-pins';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    display_id: 1,
    description: '',
    swimlane_id: 'lane-source',
    position: 0,
    agent: null,
    session_id: null,
    // Null on both, so moveTask's destructive-move confirmation probe
    // (git.checkPendingChanges / enqueueMoveConfirm) never fires - see the
    // module header.
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

function makeSwimlane(id: string): Swimlane {
  // role: null, auto_spawn: false - none of moveTask's Done-completion,
  // todo-eviction, or spawn-progress branches key off this lane, so only the
  // generation guard is exercised.
  return { id, role: null, auto_spawn: false, auto_command: null } as Swimlane;
}

// ---------------------------------------------------------------------------
// Slice harness - constructs the slice with a closure-backed set/get, plus
// the sibling-slice fields (`swimlanes`, `lanePins`, `archivedTasks`,
// `archivedTotalCount`, `archivedFullyLoaded`, and the TaskCompletionSlice /
// TaskMoveConfirmSlice / LanePinSlice / BoardHydrationSlice methods) the real
// board store supplies from other slices. None of moveTask's branches that
// call the completion/confirm methods are reachable by this file's fixtures
// (see the module header), so they are stubbed only to satisfy the type and
// to fail loudly (via a call assertion) if that assumption ever breaks.
// ---------------------------------------------------------------------------

type HarnessState = TaskSlice & {
  swimlanes: Swimlane[];
  archivedTasks: Task[];
  archivedTotalCount: number;
  archivedFullyLoaded: boolean;
  lanePins: ReadonlyMap<string, LanePin>;
  addCompletingTaskId: (taskId: string) => void;
  removeCompletingTaskId: (taskId: string) => void;
  enqueueMoveConfirm: (payload: unknown) => void;
  dropTaskLanePin: (taskId: string, expectedLaneId: string) => void;
  loadBoard: () => Promise<void>;
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
  // moveTask, so the api position is stubbed.
  const slice = createTaskSlice(set as never, get as never, {} as never);

  state = {
    swimlanes: [],
    archivedTasks: [],
    archivedTotalCount: 0,
    archivedFullyLoaded: false,
    lanePins: EMPTY_LANE_PINS,
    addCompletingTaskId: vi.fn(),
    removeCompletingTaskId: vi.fn(),
    enqueueMoveConfirm: vi.fn(),
    dropTaskLanePin: vi.fn(),
    loadBoard: vi.fn(async () => {}),
    ...slice,
    ...initial,
  };

  return { getState: get };
}

beforeEach(() => {
  vi.resetAllMocks();
  useProjectStore.getState.mockReturnValue({ currentProject: { id: 'project-a' } });
  useToastStore.getState.mockReturnValue({ addToast: vi.fn() });
  useSessionStore.getState.mockReturnValue({
    setSpawnProgress: vi.fn(),
    setPendingCommandLabel: vi.fn(),
    clearPendingCommandLabel: vi.fn(),
    setActiveSession: vi.fn(),
  });
  useSessionStore.setState.mockImplementation(() => {});
  // fetchArchivedReconcile (archivedFullyLoaded: false in every fixture here)
  // always takes this path; an empty preview keeps it a no-op for these tests.
  tasksApi.listArchivedPreview.mockResolvedValue({ tasks: [], totalCount: 0 });
});

describe('moveTask - per-task generation supersession', () => {
  it("a DIFFERENT task's move claiming a generation does NOT suppress this task's own reload (the regression)", async () => {
    const taskA = makeTask({ id: 'task-a', title: 'Task A' });
    const taskB = makeTask({ id: 'task-b', title: 'Task B' });
    const lane = makeSwimlane('lane-target');
    const { getState } = buildHarness({
      tasks: [taskA, taskB],
      swimlanes: [lane],
    });

    // Task A's move IPC is held open - claimed BEFORE task B's move starts.
    let resolveMoveA: () => void = () => {};
    const moveAHeld = new Promise<void>((resolve) => { resolveMoveA = resolve; });
    tasksApi.move.mockImplementation((input: TaskMoveInput) => (
      input.taskId === 'task-a' ? moveAHeld : Promise.resolve()
    ));

    // task-a's own tasks.list() (queued first, consumed once task A's move
    // resolves and re-enters `Promise.all`) carries a payload the CONTRAST
    // case below never reaches if the old shared counter regresses.
    const afterATasks: Task[] = [
      { ...taskA, title: 'Task A - reload applied' },
      taskB,
    ];
    // task-b's own tasks.list() (consumed first, since task B's move
    // resolves and reloads while task A's move is still held).
    const afterBTasks: Task[] = [
      taskA,
      { ...taskB, title: 'Task B - reload applied' },
    ];

    // moveTask(A) starts, runs synchronously up to `await tasks.move()`,
    // claims task-a's generation, and suspends on the held promise.
    const movePromiseA = getState().moveTask(
      { taskId: 'task-a', targetSwimlaneId: 'lane-target', targetPosition: 0 },
      true,
    );

    // moveTask(B) starts (task A's move is still pending) and claims task-b's
    // OWN generation. Under the old shared-counter bug this claim is exactly
    // what marked task A's still-pending move "superseded".
    tasksApi.list.mockResolvedValueOnce(afterBTasks);
    const movePromiseB = getState().moveTask(
      { taskId: 'task-b', targetSwimlaneId: 'lane-target', targetPosition: 1 },
      true,
    );
    await movePromiseB;

    // Now release task A's held move IPC and let its own reload run.
    tasksApi.list.mockResolvedValueOnce(afterATasks);
    resolveMoveA();
    const resultA = await movePromiseA;

    // moveTask returns { ok: true } on BOTH the superseded-skip path and the
    // genuine-success path - it cannot distinguish them. The only
    // observable proof is which payload actually landed in the store.
    expect(resultA).toEqual({ ok: true });
    const finalTaskA = getState().tasks.find((task) => task.id === 'task-a');
    // Task A's OWN tasks.list() result was written. Under the old shared
    // counter this fails: isSupersededMove would have been true right after
    // `tasks.move()` resolved, task A's own `tasks.list()` would never even
    // be called (the return happens before that Promise.all), and the store
    // would still show whatever task B's reload wrote for task A - the
    // untouched fixture object, title 'Task A'.
    expect(finalTaskA?.title).toBe('Task A - reload applied');
  });

  it('a NEWER move of the SAME task supersedes the older move, whose reload is skipped (contrast case)', async () => {
    const taskA = makeTask({ id: 'task-a', title: 'Task A' });
    const laneOne = makeSwimlane('lane-one');
    const laneTwo = makeSwimlane('lane-two');
    const { getState } = buildHarness({
      tasks: [taskA],
      swimlanes: [laneOne, laneTwo],
    });

    // The FIRST move of task-a is held open.
    let resolveFirstMove: () => void = () => {};
    const firstMoveHeld = new Promise<void>((resolve) => { resolveFirstMove = resolve; });
    let moveCallCount = 0;
    tasksApi.move.mockImplementation(() => {
      moveCallCount += 1;
      return moveCallCount === 1 ? firstMoveHeld : Promise.resolve();
    });

    const firstMovePromise = getState().moveTask(
      { taskId: 'task-a', targetSwimlaneId: 'lane-one', targetPosition: 0 },
      true,
    );

    // A SECOND move of the SAME task starts before the first one resolves -
    // this is the case the per-task generation map exists to police. It
    // claims a newer generation for task-a.
    const afterSecondMoveTasks: Task[] = [{ ...taskA, title: 'Task A - second move applied', swimlane_id: 'lane-two' }];
    tasksApi.list.mockResolvedValueOnce(afterSecondMoveTasks);
    const secondMovePromise = getState().moveTask(
      { taskId: 'task-a', targetSwimlaneId: 'lane-two', targetPosition: 0 },
      true,
    );
    await secondMovePromise;

    expect(getState().tasks.find((task) => task.id === 'task-a')?.title)
      .toBe('Task A - second move applied');

    // A `tasks.list()` queued here would prove the bug the OTHER way (the
    // stale reload clobbering the newer one) if it were ever consumed. It
    // must NOT be consumed: the first (now-stale) move's generation check
    // must short-circuit before it reaches `tasks.list()` at all.
    tasksApi.list.mockResolvedValueOnce([{ ...taskA, title: 'STALE - must never apply', swimlane_id: 'lane-one' }]);
    resolveFirstMove();
    const firstResult = await firstMovePromise;

    expect(firstResult).toEqual({ ok: true });
    // The second move's reload is still the one in the store - the first
    // (older) move's own reload was skipped as superseded, exactly as a
    // single shared counter always guaranteed and a per-task map must keep
    // guaranteeing for repeat moves of ONE task.
    expect(getState().tasks.find((task) => task.id === 'task-a')?.title)
      .toBe('Task A - second move applied');
    // Confirms the skip happened via the generation guard, not by chance:
    // the stale queued payload was never consumed.
    expect(tasksApi.list).toHaveBeenCalledTimes(1);
  });
});
