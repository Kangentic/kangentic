/**
 * Unit tests for hydrateDetailViewStateForTasks in task-changes-panel-slice.ts.
 *
 * Three behaviors pinned:
 *
 * 1. Idempotency guard (hydratedDetailViewTasks + the unseen filter):
 *    A task already in the guard set is skipped on re-hydration, so a live
 *    edit made after first hydration (e.g. the user closes the Changes panel)
 *    survives a subsequent board refresh that carries the original blob.
 *    Red condition: remove the `!alreadyHydrated.has(task.id)` predicate from
 *    the `unseen` filter and the second hydrate re-opens the panel.
 *
 * 2. Malformed-blob skip (the try/catch with continue):
 *    A task whose detail_view_state fails JSON.parse is skipped without
 *    throwing, yet is still added to hydratedDetailViewTasks so it is never
 *    retried. Valid tasks in the same batch hydrate normally.
 *    Red condition: change `continue` in the catch block to `throw` and the
 *    test fails with an exception.
 *
 * 3. changesSelectedCommit round-trips through the persisted detail_view_state
 *    blob (buildDetailViewBlob's write side, hydrateDetailViewStateForTasks's
 *    read side): setChangesSelectedCommit(id, '<oid>') schedules a debounced
 *    save whose blob carries `changesSelectedCommit: '<oid>'`; the default
 *    (null - "Uncommitted changes") is never written (mirrors
 *    changesOpen/browserOpen, which also only persist when set). Hydrating a
 *    blob with `changesSelectedCommit: '<oid>'` restores it.
 *    Red condition (write): remove the
 *    `if (selectedCommit) blob.changesSelectedCommit = selectedCommit;`
 *    line from buildDetailViewBlob and the persist test's captured blob loses
 *    the key. Red condition (read): remove the
 *    `if (blob.changesSelectedCommit !== undefined) changesSelectedCommit[task.id] = blob.changesSelectedCommit;`
 *    line from hydrateDetailViewStateForTasks and the hydrate test fails.
 *
 * All tests drive the Zustand store directly. window.electronAPI is stubbed
 * before importing the store. vi.useFakeTimers() prevents the debounced-save
 * setTimeout (triggered by setter calls like toggleChangesOpen) from
 * firing during or between tests unless a test explicitly advances timers
 * (the changesSelectedCommit persistence tests do, to flush the debounced save
 * and inspect the blob it would have sent over IPC).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { Task, TaskDetailViewState } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Stub window.electronAPI before importing the store.
// hydrateDetailViewStateForTasks is synchronous and does not call any IPC,
// but the store module reads window.electronAPI at module load time.
// setDetailViewStateMock captures every debounced-save payload so the
// changesSelectedCommit persistence tests can inspect the blob that would
// have been sent to the main process.
// ---------------------------------------------------------------------------

const setDetailViewStateMock = vi.fn(async (_taskId: string, _state: TaskDetailViewState | null, _projectId?: string | null) => {});

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: {
      set: vi.fn(),
      get: async () => DEFAULT_CONFIG,
      getGlobal: async () => DEFAULT_CONFIG,
      getProjectOverrides: async () => null,
    },
    projects: {
      list: async () => [],
    },
    sessions: {
      list: async () => [],
      spawn: async () => ({}),
      kill: async () => {},
      reset: async () => {},
      suspend: async () => {},
      resume: async () => ({}),
      reconcile: async () => null,
      getUsage: async () => ({}),
      getActivity: async () => ({}),
      getActivityReasons: async () => ({}),
      getEventsCache: async () => ({}),
      getFirstOutput: async () => ({}),
    },
    tasks: {
      getSpawnProgress: async () => ({}),
      setDetailViewState: setDetailViewStateMock,
    },
  },
};

// Import after the global stub so the store module sees the mocked window.
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { commandTerminalChangesEntityId } from '../../src/renderer/stores/session-store/task-changes-panel-slice';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Task carrying only the two fields hydrateDetailViewStateForTasks
 * reads: `id` and `detail_view_state`. All other required Task fields are absent and
 * cast away so test construction stays concise without enumerating the full shape.
 */
function makeTask(id: string, detailViewState: string | null): Task {
  return { id, detail_view_state: detailViewState } as unknown as Task;
}

/**
 * Reset only the TaskChangesPanelSlice fields touched by these tests to their
 * initial values, preventing cross-test state leakage.
 */
function resetSliceState(): void {
  useSessionStore.setState({
    changesOpenTasks: new Set<string>(),
    changesSelectedFile: {},
    changesScope: {},
    changesFileTreeWidth: {},
    changesViewedFiles: {},
    changesViewMode: {},
    changesSelectedCommit: {},
    changesHistoryHeight: {},
    dividerRatio: {},
    browserOpenTasks: new Set<string>(),
    maximizedTasks: new Set<string>(),
    hydratedDetailViewTasks: new Set<string>(),
  });
  setDetailViewStateMock.mockClear();
}

// ---------------------------------------------------------------------------
// Fake timers for the whole file.
//
// toggleChangesOpen calls scheduleDetailViewSave which enqueues a setTimeout.
// With fake timers the callback never fires mid-test, preventing the debounced
// IPC write from racing with store assertions.
// ---------------------------------------------------------------------------

beforeAll(() => {
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Behavior 1: Idempotency guard
// ---------------------------------------------------------------------------

describe('hydrateDetailViewStateForTasks - idempotency guard', () => {
  beforeEach(resetSliceState);

  it('opens the Changes panel on first hydration when the blob has changesOpen: true', () => {
    const task = makeTask('task-1', JSON.stringify({ changesOpen: true }));

    useSessionStore.getState().hydrateDetailViewStateForTasks([task]);

    expect(useSessionStore.getState().changesOpenTasks.has('task-1')).toBe(true);
  });

  it('does not re-open the Changes panel after a live toggle-close, even with the same blob on re-hydration', () => {
    // Arrange: first hydration plants the blob, opening the Changes panel.
    const task = makeTask('task-1', JSON.stringify({ changesOpen: true }));
    useSessionStore.getState().hydrateDetailViewStateForTasks([task]);
    expect(useSessionStore.getState().changesOpenTasks.has('task-1')).toBe(true);

    // Act: user closes the panel (live edit recorded in store).
    useSessionStore.getState().toggleChangesOpen('task-1');
    expect(useSessionStore.getState().changesOpenTasks.has('task-1')).toBe(false);

    // Act: board refresh fires hydrateDetailViewStateForTasks again with the same blob.
    // The guard (hydratedDetailViewTasks already contains task-1) must prevent
    // re-hydration from clobbering the live edit.
    useSessionStore.getState().hydrateDetailViewStateForTasks([task]);

    // Assert: the live edit (panel closed) survives.
    expect(useSessionStore.getState().changesOpenTasks.has('task-1')).toBe(false);
  });

  it('marks every newly-seen task hydrated regardless of whether it has a blob', () => {
    const taskWithBlob = makeTask('task-blob', JSON.stringify({ changesOpen: true }));
    const taskNullBlob = makeTask('task-null', null);

    useSessionStore.getState().hydrateDetailViewStateForTasks([taskWithBlob, taskNullBlob]);

    const hydrated = useSessionStore.getState().hydratedDetailViewTasks;
    expect(hydrated.has('task-blob')).toBe(true);
    expect(hydrated.has('task-null')).toBe(true);
  });

  it('returns immediately without mutating state when all tasks are already hydrated', () => {
    const task = makeTask('task-1', JSON.stringify({ changesOpen: true }));

    // Seed the guard set directly so the task appears already hydrated.
    useSessionStore.setState({
      hydratedDetailViewTasks: new Set<string>(['task-1']),
    });

    // Capture current state references.
    const stateBeforeRef = useSessionStore.getState();
    const hydratedBefore = stateBeforeRef.hydratedDetailViewTasks;
    const changesOpenBefore = stateBeforeRef.changesOpenTasks;

    useSessionStore.getState().hydrateDetailViewStateForTasks([task]);

    // The guard must have returned early: changesOpenTasks unchanged (blob NOT applied),
    // and the hydratedDetailViewTasks reference is the same Set (no setState call).
    const stateAfter = useSessionStore.getState();
    expect(stateAfter.changesOpenTasks).toBe(changesOpenBefore);
    expect(stateAfter.hydratedDetailViewTasks).toBe(hydratedBefore);
  });
});

// ---------------------------------------------------------------------------
// Behavior 2: Malformed-blob skip
// ---------------------------------------------------------------------------

describe('hydrateDetailViewStateForTasks - malformed-blob skip', () => {
  beforeEach(resetSliceState);

  it('does not throw when a task carries an invalid JSON blob', () => {
    const task = makeTask('task-bad', 'not-json');

    expect(() => {
      useSessionStore.getState().hydrateDetailViewStateForTasks([task]);
    }).not.toThrow();
  });

  it('hydrates the valid task and skips the malformed one in the same batch', () => {
    const malformedTask = makeTask('task-bad', 'not-json');
    const validTask = makeTask('task-good', JSON.stringify({ dividerRatio: 0.6 }));

    expect(() => {
      useSessionStore.getState().hydrateDetailViewStateForTasks([malformedTask, validTask]);
    }).not.toThrow();

    const state = useSessionStore.getState();

    // Valid task hydrated: dividerRatio is set.
    expect(state.dividerRatio['task-good']).toBe(0.6);

    // Malformed task produced no state change (blob was skipped via continue).
    expect(state.dividerRatio['task-bad']).toBeUndefined();
  });

  it('adds both the malformed and the valid task to hydratedDetailViewTasks', () => {
    // The guard must mark the malformed task hydrated so it is never retried,
    // even though its blob was skipped by the catch/continue branch.
    const malformedTask = makeTask('task-bad', 'not-json');
    const validTask = makeTask('task-good', JSON.stringify({ dividerRatio: 0.6 }));

    useSessionStore.getState().hydrateDetailViewStateForTasks([malformedTask, validTask]);

    const hydrated = useSessionStore.getState().hydratedDetailViewTasks;
    expect(hydrated.has('task-bad')).toBe(true);
    expect(hydrated.has('task-good')).toBe(true);
  });

  it('does not retry a malformed-blob task on subsequent hydration calls', () => {
    const malformedTask = makeTask('task-bad', 'not-json');

    // First call: blob skipped, task marked hydrated.
    useSessionStore.getState().hydrateDetailViewStateForTasks([malformedTask]);
    expect(useSessionStore.getState().hydratedDetailViewTasks.has('task-bad')).toBe(true);

    // Capture the Set reference after the first call.
    const hydratedAfterFirst = useSessionStore.getState().hydratedDetailViewTasks;

    // Second call: task already in the guard set, so the function must return
    // early (unseen is empty) without calling setState again.
    useSessionStore.getState().hydrateDetailViewStateForTasks([malformedTask]);

    // Same reference means no new setState was issued for the malformed task.
    expect(useSessionStore.getState().hydratedDetailViewTasks).toBe(hydratedAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// Behavior 3: changesSelectedCommit round-trips through the persisted blob
// ---------------------------------------------------------------------------

describe('changesSelectedCommit - persists to and hydrates from detail_view_state', () => {
  beforeEach(() => {
    // Flush any debounced saves left pending by earlier tests first: the
    // save-scheduling maps in task-changes-panel-slice.ts (detailViewPendingSaves /
    // detailViewSaveTimers) are module-scope singletons, not part of the
    // Zustand store state resetSliceState clears, so a stray timer from an
    // earlier describe block (e.g. toggleChangesOpen('task-1')) would
    // otherwise fire alongside this test's own save and inflate the call
    // count. Advancing first lets it fire and clear itself; resetSliceState's
    // trailing mockClear() then establishes a clean baseline for this test.
    vi.advanceTimersByTime(1000);
    resetSliceState();
  });

  it('persists changesSelectedCommit into the saved blob after setChangesSelectedCommit(id, oid)', () => {
    useSessionStore.getState().setChangesSelectedCommit('task-commit', 'a1b2c3d');

    // Flush the debounced save (500ms in the real slice); advance well past it.
    vi.advanceTimersByTime(1000);

    expect(setDetailViewStateMock).toHaveBeenCalledTimes(1);
    const [taskId, blob] = setDetailViewStateMock.mock.calls[0];
    expect(taskId).toBe('task-commit');
    expect(blob).toMatchObject({ changesSelectedCommit: 'a1b2c3d' });
  });

  it('does not persist changesSelectedCommit when set to null (Uncommitted changes, the default)', () => {
    useSessionStore.getState().setChangesSelectedCommit('task-uncommitted', null);

    vi.advanceTimersByTime(1000);

    expect(setDetailViewStateMock).toHaveBeenCalledTimes(1);
    const [, blob] = setDetailViewStateMock.mock.calls[0];
    expect(blob?.changesSelectedCommit).toBeUndefined();
  });

  it('hydrates changesSelectedCommit from a persisted blob back into the store', () => {
    const task = makeTask('task-hydrate-commit', JSON.stringify({ changesSelectedCommit: 'a1b2c3d' }));

    useSessionStore.getState().hydrateDetailViewStateForTasks([task]);

    expect(useSessionStore.getState().changesSelectedCommit['task-hydrate-commit']).toBe('a1b2c3d');
  });

  it('leaves changesSelectedCommit unset when the persisted blob omits it (Uncommitted stays the effective default)', () => {
    const task = makeTask('task-hydrate-default', JSON.stringify({ dividerRatio: 0.5 }));

    useSessionStore.getState().hydrateDetailViewStateForTasks([task]);

    expect(useSessionStore.getState().changesSelectedCommit['task-hydrate-default']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Behavior 4: a Command Terminal window's per-slot entity id is excluded from
// detail_view_state persistence, the same as the old shared 'command-terminal'
// sentinel was. Each window now gets its own id via commandTerminalChangesEntityId
// (e.g. 'command-terminal::slot-1'), so the exclusion check must recognize the
// whole family, not just the single old literal.
// Red condition: revert isNonTaskDetailViewId to a bare
// `NON_TASK_DETAIL_VIEW_IDS.has(taskId)` (no prefix check) and this test fails -
// the per-slot id no longer matches, so scheduleDetailViewSave stops skipping it
// and setDetailViewStateMock is called twice instead of once.
//
// The second test below pins the OTHER branch of isNonTaskDetailViewId's OR: the
// fixed-literal NON_TASK_DETAIL_VIEW_IDS.has(entityId) set (the create dialogs and
// the Edit Columns dialog), which the first test does not exercise.
// Red condition: drop 'board-manager-dialog' from NON_TASK_DETAIL_VIEW_IDS (or
// break the `||` into only the startsWith check) and this test fails -
// scheduleDetailViewSave stops skipping the sentinel id and setDetailViewStateMock
// is called twice instead of once.
// ---------------------------------------------------------------------------

describe('commandTerminalChangesEntityId - excluded from detail_view_state persistence', () => {
  beforeEach(() => {
    vi.advanceTimersByTime(1000);
    resetSliceState();
  });

  it('does not schedule a setDetailViewState save for a per-slot command-terminal id, but does for a real task id', () => {
    const slotOneEntityId = commandTerminalChangesEntityId('slot-1');
    const slotTwoEntityId = commandTerminalChangesEntityId('slot-2');

    useSessionStore.getState().toggleChangesOpen(slotOneEntityId);
    useSessionStore.getState().toggleChangesOpen(slotTwoEntityId);
    useSessionStore.getState().toggleChangesOpen('task-1');

    vi.advanceTimersByTime(1000);

    expect(setDetailViewStateMock).toHaveBeenCalledTimes(1);
    const [taskId] = setDetailViewStateMock.mock.calls[0];
    expect(taskId).toBe('task-1');
  });

  it('does not schedule a setDetailViewState save for a fixed sentinel id (board-manager-dialog), but does for a real task id', () => {
    useSessionStore.getState().toggleChangesOpen('board-manager-dialog');
    useSessionStore.getState().toggleChangesOpen('task-1');

    vi.advanceTimersByTime(1000);

    expect(setDetailViewStateMock).toHaveBeenCalledTimes(1);
    const [taskId] = setDetailViewStateMock.mock.calls[0];
    expect(taskId).toBe('task-1');
  });
});
