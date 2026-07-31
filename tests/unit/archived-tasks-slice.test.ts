/**
 * Unit tests for the archived-tasks-slice Zustand slice
 * (`src/renderer/stores/board-store/archived-tasks-slice.ts`).
 *
 * Two behaviors are pinned here:
 *
 *  A. `archivedTotalCount` accounting. It is the authoritative archived
 *     count, threaded through every mutation with a "decrement only when the
 *     row was actually held in the loaded `archivedTasks` array" guard - a
 *     preview that holds only the newest-N must not skew the count when an
 *     id it never held is removed. Covers `archiveTask`, `deleteArchivedTask`
 *     (held vs. preview-miss), `bulkDeleteArchivedTasks`,
 *     `bulkUnarchiveTasks`, and the IPC-failure rollback path.
 *
 *  B. `loadArchivedTasks` project-switch guard. It captures the current
 *     project id at start and drops a result that resolves after a project
 *     switch, so project A's archive fetch can never overwrite project B's
 *     `archivedTasks` / `archivedTotalCount` or latch `archivedFullyLoaded`
 *     true for B.
 *
 *  C. `bulkUnarchiveTasks` session eviction, scoped to a `role === 'todo'`
 *     target lane. Restoring into To Do tears the suspended session down on
 *     the backend, and the renderer must drop it optimistically too (see
 *     `tests/ui/unarchive-to-todo-no-paused-row.spec.ts` for the singular
 *     `unarchiveTask` path's end-to-end coverage of the same mechanism) - a
 *     restore into any OTHER lane must not touch sessions at all.
 *
 * The slice is a Zustand `StateCreator` - a plain function of (set, get,
 * api). We drive it directly via a minimal in-memory harness (the same
 * pattern used by `board-manager-slice.test.ts` and
 * `task-changes-panel-slice.test.ts`), so no real board store, Electron, or
 * DOM is required. `useProjectStore` / `useToastStore` / `useSessionStore`
 * are mocked via `vi.mock` (the slice imports them directly for the
 * project-id stamp, toast surfacing, and session cleanup side effects).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Hoisted store mocks - vi.mock factories below run before this file's other
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
// mirrors the pattern in `session-store-cache-reconcile.test.ts`.
const tasksApi = {
  delete: vi.fn(),
  bulkDelete: vi.fn(),
  bulkUnarchive: vi.fn(),
  list: vi.fn(),
  listArchived: vi.fn(),
  onBulkDeleteProgress: vi.fn(),
};

(globalThis as Record<string, unknown>).window = {
  electronAPI: { tasks: tasksApi },
};

// Imported after the mocks/stub so the slice module resolves the mocked
// stores and the stubbed window.
import { createArchivedTasksSlice } from '../../src/renderer/stores/board-store/archived-tasks-slice';
import type { ArchivedTasksSlice } from '../../src/renderer/stores/board-store/archived-tasks-slice';
import { EMPTY_LANE_PINS, type LanePin } from '../../src/renderer/stores/board-store/lane-pins';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    display_id: 1,
    title: 'A task',
    description: '',
    swimlane_id: 'swim-1',
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Slice harness - constructs the slice with a closure-backed set/get, plus
// the sibling `tasks` / `swimlanes` / `lanePins` fields the slice reads (and,
// for `lanePins`, reconciles via `applyTaskListPayload`) from other
// board-store slices in the real app.
// ---------------------------------------------------------------------------

type HarnessState = ArchivedTasksSlice & { tasks: Task[]; swimlanes: Swimlane[]; lanePins: ReadonlyMap<string, LanePin> };

function buildHarness(initial: Partial<HarnessState> = {}): {
  getState: () => HarnessState;
  setState: (partial: Partial<HarnessState> | ((state: HarnessState) => Partial<HarnessState>)) => void;
} {
  let state: HarnessState;

  const set = (
    updater: Partial<HarnessState> | ((state: HarnessState) => Partial<HarnessState>),
  ) => {
    const patch = typeof updater === 'function' ? updater(state) : updater;
    state = { ...state, ...patch };
  };

  const get = () => state;

  // StateCreator signature: (set, get, api). Only set/get are exercised by
  // the tests below, so the api position is stubbed.
  const slice = createArchivedTasksSlice(set as never, get as never, {} as never);

  state = {
    tasks: [],
    swimlanes: [],
    lanePins: EMPTY_LANE_PINS,
    ...slice,
    ...initial,
  };

  return { getState: get, setState: set };
}

beforeEach(() => {
  vi.resetAllMocks();
  tasksApi.onBulkDeleteProgress.mockImplementation(() => () => {});
  useToastStore.getState.mockReturnValue({ addToast: vi.fn() });
  useSessionStore.getState.mockReturnValue({ setSpawnProgress: vi.fn() });
  useSessionStore.setState.mockImplementation(() => {});
  useProjectStore.getState.mockReturnValue({ currentProject: null });
});

// ---------------------------------------------------------------------------
// A. archivedTotalCount accounting
// ---------------------------------------------------------------------------

describe('archiveTask', () => {
  it('moves the task from tasks to the front of archivedTasks and increments archivedTotalCount by 1', () => {
    const movingTask = makeTask({ id: 'moving' });
    const existingArchived = makeTask({ id: 'already-archived' });
    const { getState } = buildHarness({
      tasks: [movingTask],
      archivedTasks: [existingArchived],
      archivedTotalCount: 1,
    });

    getState().archiveTask('moving');

    const state = getState();
    expect(state.tasks.find((t) => t.id === 'moving')).toBeUndefined();
    expect(state.archivedTasks).toHaveLength(2);
    // Prepended - the newly archived task is the newest, so it sits at the front.
    expect(state.archivedTasks[0].id).toBe('moving');
    expect(state.archivedTasks[0].archived_at).not.toBeNull();
    expect(state.archivedTasks[1]).toBe(existingArchived);
    expect(state.archivedTotalCount).toBe(2);
  });

  it('is a no-op when the id is not found in tasks (does not touch archivedTotalCount)', () => {
    const { getState } = buildHarness({
      tasks: [],
      archivedTasks: [],
      archivedTotalCount: 4,
    });

    getState().archiveTask('missing-id');

    expect(getState().archivedTotalCount).toBe(4);
  });
});

describe('deleteArchivedTask', () => {
  it('decrements archivedTotalCount when the id IS held in archivedTasks', async () => {
    tasksApi.delete.mockResolvedValueOnce(undefined);
    const held = makeTask({ id: 'held' });
    const { getState } = buildHarness({
      archivedTasks: [held],
      archivedTotalCount: 3,
    });

    await getState().deleteArchivedTask('held');

    const state = getState();
    expect(state.archivedTasks).toEqual([]);
    expect(state.archivedTotalCount).toBe(2);
  });

  it('leaves archivedTotalCount UNCHANGED when the id is a preview miss (not in archivedTasks)', async () => {
    tasksApi.delete.mockResolvedValueOnce(undefined);
    const { getState } = buildHarness({
      archivedTasks: [],
      archivedTotalCount: 5,
    });

    await getState().deleteArchivedTask('not-previewed');

    const state = getState();
    expect(state.archivedTasks).toEqual([]);
    // A preview miss must not skew the authoritative count.
    expect(state.archivedTotalCount).toBe(5);
  });

  it('rolls back the optimistic removal and restores archivedTotalCount on IPC failure', async () => {
    tasksApi.delete.mockRejectedValueOnce(new Error('delete failed'));
    const held = makeTask({ id: 'held' });
    const { getState } = buildHarness({
      archivedTasks: [held],
      archivedTotalCount: 7,
    });

    await getState().deleteArchivedTask('held');

    const state = getState();
    expect(state.archivedTasks).toEqual([held]);
    expect(state.archivedTotalCount).toBe(7);
  });
});

describe('bulkDeleteArchivedTasks', () => {
  it('decrements archivedTotalCount by the number of ids ACTUALLY present in archivedTasks, not ids.length', async () => {
    tasksApi.bulkDelete.mockResolvedValueOnce({ deleted: 2, failures: [] });
    const held1 = makeTask({ id: 'held-1' });
    const held2 = makeTask({ id: 'held-2' });
    const { getState } = buildHarness({
      archivedTasks: [held1, held2],
      // Total includes tasks beyond what the (preview) archivedTasks array holds.
      archivedTotalCount: 5,
    });

    // Third id is a preview miss - present on the backend's full archive but
    // never held in this loaded archivedTasks array.
    await getState().bulkDeleteArchivedTasks(['held-1', 'held-2', 'preview-miss']);

    const state = getState();
    expect(state.archivedTasks).toEqual([]);
    // Decrement by 2 (rows actually held), NOT by ids.length (3): 5 - 2 = 3.
    expect(state.archivedTotalCount).toBe(3);
  });

  it('rolls back the optimistic removal and restores archivedTotalCount on IPC failure', async () => {
    tasksApi.bulkDelete.mockRejectedValueOnce(new Error('bulk delete failed'));
    const held = makeTask({ id: 'held' });
    const { getState } = buildHarness({
      archivedTasks: [held],
      archivedTotalCount: 9,
    });

    await getState().bulkDeleteArchivedTasks(['held']);

    const state = getState();
    expect(state.archivedTasks).toEqual([held]);
    expect(state.archivedTotalCount).toBe(9);
  });
});

describe('bulkUnarchiveTasks', () => {
  it('decrements archivedTotalCount by the number of ids ACTUALLY present in archivedTasks, not ids.length', async () => {
    tasksApi.bulkUnarchive.mockResolvedValueOnce(undefined);
    tasksApi.list.mockResolvedValueOnce([]);
    const held = makeTask({ id: 'held-1' });
    const { getState } = buildHarness({
      archivedTasks: [held],
      archivedTotalCount: 4,
      swimlanes: [],
    });

    await getState().bulkUnarchiveTasks(['held-1', 'preview-miss'], 'lane-todo');

    const state = getState();
    expect(state.archivedTasks).toEqual([]);
    // Only 1 of the 2 ids was actually held: 4 - 1 = 3, not 4 - 2 = 2.
    expect(state.archivedTotalCount).toBe(3);
  });

  it('rolls back the optimistic removal and restores archivedTotalCount on IPC failure', async () => {
    tasksApi.bulkUnarchive.mockRejectedValueOnce(new Error('bulk unarchive failed'));
    const held = makeTask({ id: 'held' });
    const { getState } = buildHarness({
      tasks: [],
      archivedTasks: [held],
      archivedTotalCount: 6,
      swimlanes: [],
      // loadBoard is called in the catch branch; stub it directly on state
      // since it belongs to a sibling slice not under test here.
      loadBoard: vi.fn(async () => {}),
    } as never);

    await getState().bulkUnarchiveTasks(['held'], 'lane-todo');

    const state = getState();
    expect(state.archivedTasks).toEqual([held]);
    expect(state.archivedTotalCount).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// bulkUnarchiveTasks - session eviction for a To Do target, and the
// applyTaskListPayload switch (see the module header for both mechanisms;
// this is the bulk path's own coverage - the singular unarchiveTask path is
// covered end-to-end by tests/ui/unarchive-to-todo-no-paused-row.spec.ts, but
// that spec has no bulk equivalent).
// ---------------------------------------------------------------------------

function makeSwimlane(id: string, role: Swimlane['role']): Swimlane {
  return { id, role } as Swimlane;
}

describe('bulkUnarchiveTasks - session eviction scoped to a To Do target', () => {
  it("evicts sessions for EVERY restored task id when the target lane is role 'todo'", async () => {
    tasksApi.bulkUnarchive.mockResolvedValueOnce(undefined);
    tasksApi.list.mockResolvedValueOnce([]);
    const held1 = makeTask({ id: 'task-1' });
    const held2 = makeTask({ id: 'task-2' });
    const { getState } = buildHarness({
      archivedTasks: [held1, held2],
      archivedTotalCount: 2,
      swimlanes: [makeSwimlane('lane-todo', 'todo')],
    });

    await getState().bulkUnarchiveTasks(['task-1', 'task-2'], 'lane-todo');

    // The slice hands `useSessionStore.setState` an updater rather than
    // mutating state directly (real `set` semantics); the mock is a no-op, so
    // apply the captured updater ourselves against a seeded session list to
    // observe what it WOULD have evicted.
    expect(useSessionStore.setState).toHaveBeenCalledTimes(1);
    const evictionUpdater = useSessionStore.setState.mock.calls[0][0] as (
      state: { sessions: Array<{ id: string; taskId: string }> },
    ) => { sessions: Array<{ id: string; taskId: string }> };
    const seededSessions = [
      { id: 'sess-1', taskId: 'task-1' },
      { id: 'sess-2', taskId: 'task-2' },
      { id: 'sess-3', taskId: 'other-task' },
    ];
    const result = evictionUpdater({ sessions: seededSessions });
    // Both restored tasks' sessions are dropped; the unrelated task's survives.
    expect(result.sessions.map((session) => session.id)).toEqual(['sess-3']);
  });

  it("does NOT evict any session when the target lane is not role 'todo' (e.g. an auto-spawn column)", async () => {
    tasksApi.bulkUnarchive.mockResolvedValueOnce(undefined);
    tasksApi.list.mockResolvedValueOnce([]);
    const held = makeTask({ id: 'task-1' });
    const { getState } = buildHarness({
      archivedTasks: [held],
      archivedTotalCount: 1,
      swimlanes: [makeSwimlane('lane-executing', null)],
    });

    await getState().bulkUnarchiveTasks(['task-1'], 'lane-executing');

    // bulkUnarchiveTasks has exactly one useSessionStore.setState call site
    // (the role==='todo' eviction), so "not called at all" is the correct
    // negative assertion for a restore into a non-todo lane.
    expect(useSessionStore.setState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B. loadArchivedTasks project-switch guard
// ---------------------------------------------------------------------------

describe('loadArchivedTasks - project-switch guard', () => {
  it('drops a result that resolves AFTER a project switch (does not overwrite archivedTasks or latch archivedFullyLoaded)', async () => {
    useProjectStore.getState.mockReturnValue({ currentProject: { id: 'project-a' } });

    let resolveFetch: (tasks: Task[]) => void = () => {};
    tasksApi.listArchived.mockReturnValueOnce(
      new Promise<Task[]>((resolve) => { resolveFetch = resolve; }),
    );

    const { getState } = buildHarness({
      archivedTasks: [],
      archivedTotalCount: 0,
      archivedFullyLoaded: false,
    });

    const loadPromise = getState().loadArchivedTasks();

    // The user switches to project B while project A's fetch is still in flight.
    useProjectStore.getState.mockReturnValue({ currentProject: { id: 'project-b' } });

    // Project A's fetch resolves now - AFTER the switch.
    resolveFetch([makeTask({ id: 'project-a-task' })]);
    await loadPromise;

    const state = getState();
    expect(state.archivedTasks).toEqual([]);
    expect(state.archivedTotalCount).toBe(0);
    expect(state.archivedFullyLoaded).toBe(false);
  });

  it('applies the result when the project has NOT switched (contrast case)', async () => {
    useProjectStore.getState.mockReturnValue({ currentProject: { id: 'project-a' } });

    const fetchedTasks = [makeTask({ id: 'project-a-task' })];
    tasksApi.listArchived.mockResolvedValueOnce(fetchedTasks);

    const { getState } = buildHarness({
      archivedTasks: [],
      archivedTotalCount: 0,
      archivedFullyLoaded: false,
    });

    await getState().loadArchivedTasks();

    const state = getState();
    expect(state.archivedTasks).toEqual(fetchedTasks);
    expect(state.archivedTotalCount).toBe(1);
    expect(state.archivedFullyLoaded).toBe(true);
  });
});
