/**
 * Answers the workflow store must not apply, driven straight through the real
 * store with a hand-held `workflows.get`.
 *
 * The board's links overlay is fed by `showLinks`, which waits on the workflow
 * and may be answered after the overlay was cleared or asked again. A clear
 * (Escape, a press on empty board, the board unmounting) and a newer show both
 * outrank a load still in flight. The UI tier pins the Escape and the press
 * (tests/ui/workflows-board.spec.ts); the board unmounting is pinned here,
 * because React.StrictMode's dev remount runs the overlay's cleanup again on
 * every mount and so hides it from a rendered test.
 *
 * `setPositions` draws the dropped places before it saves them. A save main
 * refuses writes nothing and sends no change push, so the store has to read the
 * workflow again itself or the cards stay where the refused save left them.
 *
 * `createWorkflow` and `deleteWorkflow` both wait on main, and the user can act
 * meanwhile: a project switch must not have the new workflow selected over the
 * project now on screen, and a workflow picked while a delete ran must keep its
 * selection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Workflow, WorkflowDeleteReport, WorkflowDetail, WorkflowSummary, WorkflowViewTask } from '../../src/shared/types';

// The project on screen, which a test changes to switch projects mid-call.
const projectHarness = vi.hoisted(() => ({ currentProjectId: 'p' }));
vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: { id: projectHarness.currentProjectId } }) },
}));
const toastHarness = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: toastHarness.addToast }) },
}));

const { useWorkflowStore } = await import('../../src/renderer/stores/workflow-store');

function viewTask(key: string, canvasX: number | null = null, canvasY: number | null = null): WorkflowViewTask {
  return {
    key, projectId: 'p', task: null, planned: null, title: `Task ${key}`, displayId: null, place: 'planned',
    swimlaneId: null, steps: [], canvasX, canvasY, unnamedBlockerCount: 0,
  };
}

function detailOf(workflowId: string, tasks: WorkflowViewTask[] = [viewTask('a')]): WorkflowDetail {
  return {
    workflow: {
      id: workflowId, title: 'Usage budgets', brief: null, source_task_id: null, state: 'draft', draft: null,
      color_slot: 1, revision: 1, created_at: '', started_at: null, finished_at: null,
    },
    homeProjectId: 'p',
    tasks,
    links: [],
    projectNames: { p: 'kangentic' },
  } as WorkflowDetail;
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (reason: Error) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<Value>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

function summaryOf(workflowId: string): WorkflowSummary {
  return {
    workflow: detailOf(workflowId).workflow,
    taskCount: 0,
    doneCount: 0,
    inProgressCount: 0,
    queuedCount: 0,
    blockedCount: 0,
    boardTasks: {},
    agent: null,
  };
}

interface WorkflowsBridge {
  get: ReturnType<typeof vi.fn>;
  setPositions: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  listSupersessions: ReturnType<typeof vi.fn>;
}

function installBridge(): WorkflowsBridge {
  const workflows: WorkflowsBridge = {
    get: vi.fn(),
    setPositions: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    listSupersessions: vi.fn().mockResolvedValue([]),
  };
  (globalThis as unknown as { window: { electronAPI: { workflows: WorkflowsBridge } } }).window = {
    electronAPI: { workflows },
  };
  return workflows;
}

beforeEach(() => {
  projectHarness.currentProjectId = 'p';
  useWorkflowStore.getState().clearLinks();
  useWorkflowStore.setState({ projectId: null, selectedWorkflowId: null, detail: null, linkFocus: null });
});

describe('showLinks and clearLinks', () => {
  it('draws the overlay when nothing cleared the load', async () => {
    const bridge = installBridge();
    bridge.get.mockResolvedValue(detailOf('w'));

    await useWorkflowStore.getState().showLinks('t1', 'p', 'w');

    expect(useWorkflowStore.getState().linkFocus?.taskId).toBe('t1');
    // A refused move keeps the links until something clears them.
    expect(useWorkflowStore.getState().linkFocus?.kept).toBe(true);
  });

  it('keeps the overlay cleared when the answer lands after a clear', async () => {
    const bridge = installBridge();
    const answer = deferred<WorkflowDetail>();
    bridge.get.mockReturnValue(answer.promise);

    const shown = useWorkflowStore.getState().showLinks('t1', 'p', 'w');
    // The board unmounts (or Escape, or a press on empty space) while it loads.
    useWorkflowStore.getState().clearLinks();
    answer.resolve(detailOf('w'));
    await shown;

    expect(useWorkflowStore.getState().linkFocus).toBeNull();
  });

  it('keeps the newest show, whichever of two loads answers last', async () => {
    const bridge = installBridge();
    const older = deferred<WorkflowDetail>();
    const newer = deferred<WorkflowDetail>();
    bridge.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const olderShown = useWorkflowStore.getState().showLinks('t1', 'p', 'w');
    const newerShown = useWorkflowStore.getState().showLinks('t2', 'p', 'w');
    newer.resolve(detailOf('w'));
    await newerShown;
    expect(useWorkflowStore.getState().linkFocus?.taskId).toBe('t2');

    // The older load answering afterwards does not take the overlay back.
    older.resolve(detailOf('w'));
    await olderShown;
    expect(useWorkflowStore.getState().linkFocus?.taskId).toBe('t2');
  });

  it('keeps the newest show when the older load answers first', async () => {
    const bridge = installBridge();
    const older = deferred<WorkflowDetail>();
    const newer = deferred<WorkflowDetail>();
    bridge.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const olderShown = useWorkflowStore.getState().showLinks('t1', 'p', 'w');
    const newerShown = useWorkflowStore.getState().showLinks('t2', 'p', 'w');
    older.resolve(detailOf('w'));
    await olderShown;
    expect(useWorkflowStore.getState().linkFocus).toBeNull();

    newer.resolve(detailOf('w'));
    await newerShown;
    expect(useWorkflowStore.getState().linkFocus?.taskId).toBe('t2');
  });

  // The overlay listens for Escape and a press on empty space while
  // `linkFocusLoading` is set, so the flag has to cover exactly the loads
  // still in flight: an outranked answer must not end it early.
  it('says a load is in flight from the show until its answer, or a clear', async () => {
    const bridge = installBridge();
    const first = deferred<WorkflowDetail>();
    const second = deferred<WorkflowDetail>();
    bridge.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    expect(useWorkflowStore.getState().linkFocusLoading).toBe(false);

    const firstShown = useWorkflowStore.getState().showLinks('t1', 'p', 'w');
    expect(useWorkflowStore.getState().linkFocusLoading).toBe(true);
    first.resolve(detailOf('w'));
    await firstShown;
    expect(useWorkflowStore.getState().linkFocusLoading).toBe(false);

    const secondShown = useWorkflowStore.getState().showLinks('t2', 'p', 'w');
    expect(useWorkflowStore.getState().linkFocusLoading).toBe(true);
    useWorkflowStore.getState().clearLinks();
    expect(useWorkflowStore.getState().linkFocusLoading).toBe(false);
    second.resolve(detailOf('w'));
    await secondShown;
    expect(useWorkflowStore.getState().linkFocusLoading).toBe(false);
    expect(useWorkflowStore.getState().linkFocus).toBeNull();
  });

  it('keeps saying a load is in flight when an outranked one answers first', async () => {
    const bridge = installBridge();
    const older = deferred<WorkflowDetail>();
    const newer = deferred<WorkflowDetail>();
    bridge.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const olderShown = useWorkflowStore.getState().showLinks('t1', 'p', 'w');
    const newerShown = useWorkflowStore.getState().showLinks('t2', 'p', 'w');
    older.resolve(detailOf('w'));
    await olderShown;
    expect(useWorkflowStore.getState().linkFocusLoading).toBe(true);

    newer.resolve(detailOf('w'));
    await newerShown;
    expect(useWorkflowStore.getState().linkFocusLoading).toBe(false);
  });

  it('keeps saying a load is in flight when an outranked one fails first', async () => {
    const bridge = installBridge();
    const older = deferred<WorkflowDetail>();
    const newer = deferred<WorkflowDetail>();
    bridge.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const olderShown = useWorkflowStore.getState().showLinks('t1', 'p', 'w');
    const newerShown = useWorkflowStore.getState().showLinks('t2', 'p', 'w');
    older.reject(new Error('The workflow is gone.'));
    await olderShown;
    warn.mockRestore();
    expect(useWorkflowStore.getState().linkFocusLoading).toBe(true);

    newer.resolve(detailOf('w'));
    await newerShown;
    expect(useWorkflowStore.getState().linkFocusLoading).toBe(false);
    expect(useWorkflowStore.getState().linkFocus?.taskId).toBe('t2');
  });

  it('ends the in-flight state when the load fails', async () => {
    const bridge = installBridge();
    bridge.get.mockRejectedValueOnce(new Error('The workflow is gone.'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await useWorkflowStore.getState().showLinks('t1', 'p', 'w');
    warn.mockRestore();

    expect(useWorkflowStore.getState().linkFocusLoading).toBe(false);
    expect(useWorkflowStore.getState().linkFocus).toBeNull();
  });

  it('does not clear the overlay when a load that was outranked fails', async () => {
    const bridge = installBridge();
    const older = deferred<WorkflowDetail>();
    bridge.get.mockReturnValueOnce(older.promise).mockResolvedValueOnce(detailOf('w'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const olderShown = useWorkflowStore.getState().showLinks('t1', 'p', 'w');
    await useWorkflowStore.getState().showLinks('t2', 'p', 'w');
    expect(useWorkflowStore.getState().linkFocus?.taskId).toBe('t2');

    older.reject(new Error('The workflow is gone.'));
    await olderShown;
    warn.mockRestore();

    expect(useWorkflowStore.getState().linkFocus?.taskId).toBe('t2');
  });
});

// Resting the pointer on a card previews its links, and a refused move keeps
// them (#732 board 8c). Kept links outrank a preview, a preview
// ends with the pointer leaving its card, and each keeps its mode through a
// reload.
describe('previewLinks and endPreview', () => {
  const state = () => useWorkflowStore.getState();

  it('previews a card\'s links unkept, and leaving the card ends them', async () => {
    const bridge = installBridge();
    bridge.get.mockResolvedValue(detailOf('w'));

    await state().previewLinks('t1', 'p', 'w');
    expect(state().linkFocus).toMatchObject({ taskId: 't1', kept: false });

    state().endPreview('t1');
    expect(state().linkFocus).toBeNull();
  });

  it('leaving a card before its preview loads cancels the load, so its answer draws nothing', async () => {
    const bridge = installBridge();
    const answer = deferred<WorkflowDetail>();
    bridge.get.mockReturnValue(answer.promise);

    const previewed = state().previewLinks('t1', 'p', 'w');
    state().endPreview('t1');
    expect(state().linkFocusLoading).toBe(false);
    answer.resolve(detailOf('w'));
    await previewed;

    expect(state().linkFocus).toBeNull();
  });

  it('previews nothing while links are kept, its own or another card\'s', async () => {
    const bridge = installBridge();
    bridge.get.mockResolvedValue(detailOf('w'));
    await state().showLinks('t1', 'p', 'w');
    bridge.get.mockClear();

    await state().previewLinks('t2', 'p', 'w');
    await state().previewLinks('t1', 'p', 'w');

    expect(bridge.get).not.toHaveBeenCalled();
    expect(state().linkFocus).toMatchObject({ taskId: 't1', kept: true });
    // Leaving a card never ends kept links.
    state().endPreview('t1');
    state().endPreview('t2');
    expect(state().linkFocus).toMatchObject({ taskId: 't1', kept: true });
  });

  it('previews nothing while a keep is still loading', async () => {
    const bridge = installBridge();
    const kept = deferred<WorkflowDetail>();
    bridge.get.mockReturnValueOnce(kept.promise);

    const keeping = state().showLinks('t1', 'p', 'w');
    await state().previewLinks('t2', 'p', 'w');
    kept.resolve(detailOf('w'));
    await keeping;

    expect(bridge.get).toHaveBeenCalledTimes(1);
    expect(state().linkFocus).toMatchObject({ taskId: 't1', kept: true });
  });

  it('a keep (a refused move) while the card\'s preview loads lands kept, and leaving the card keeps it', async () => {
    const bridge = installBridge();
    const answer = deferred<WorkflowDetail>();
    bridge.get.mockReturnValueOnce(answer.promise).mockResolvedValue(detailOf('w'));

    const previewed = state().previewLinks('t1', 'p', 'w');
    const keeping = state().showLinks('t1', 'p', 'w');
    answer.resolve(detailOf('w'));
    await Promise.all([previewed, keeping]);

    expect(state().linkFocus).toMatchObject({ taskId: 't1', kept: true });
    state().endPreview('t1');
    expect(state().linkFocus).toMatchObject({ taskId: 't1', kept: true });
  });

  it('a change push reloads the links on screen in the mode they had', async () => {
    const bridge = installBridge();
    bridge.get.mockResolvedValue(detailOf('w'));
    await state().previewLinks('t1', 'p', 'w');
    const reloaded = deferred<WorkflowDetail>();
    bridge.get.mockReturnValueOnce(reloaded.promise);

    state().handleChanged({ projectId: 'p', workflowId: 'w' });
    expect(bridge.get).toHaveBeenLastCalledWith('p', 'w');
    reloaded.resolve(detailOf('w'));
    await vi.waitFor(() => expect(state().linkFocusLoading).toBe(false));

    // Still a preview: leaving the strip ends it.
    expect(state().linkFocus).toMatchObject({ taskId: 't1', kept: false });
    state().endPreview('t1');
    expect(state().linkFocus).toBeNull();
  });
});

// A task detail's panel watches its workflow and reloads it on every push. The
// store drops a workflow's bookkeeping when its last watcher leaves, so a read
// that was in flight at that moment must not be mistaken for the newest read of
// the next watch of the same workflow.
describe('watchDetail', () => {
  const state = () => useWorkflowStore.getState();
  // A late answer is a microtask away from landing. There is nothing to poll for
  // when it must NOT land, so let every pending microtask run, then assert.
  const settleAnswers = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

  beforeEach(() => {
    useWorkflowStore.setState({ watchedDetails: {} });
  });

  it('keeps the newer read when the last watcher leaves and the workflow is watched again', async () => {
    const bridge = installBridge();
    const staleRead = deferred<WorkflowDetail>();
    const freshRead = deferred<WorkflowDetail>();
    bridge.get.mockReturnValueOnce(staleRead.promise).mockReturnValueOnce(freshRead.promise);

    const unwatchFirst = state().watchDetail('p', 'w-late');
    expect(bridge.get).toHaveBeenCalledTimes(1);
    // The panel closes with its read still out, then a new panel watches the same workflow.
    unwatchFirst();
    expect(state().watchedDetails['w-late']).toBeUndefined();
    const unwatchSecond = state().watchDetail('p', 'w-late');
    expect(bridge.get).toHaveBeenCalledTimes(2);

    // The newer read answers first, then the older one answers late.
    freshRead.resolve(detailOf('w-late', [viewTask('fresh')]));
    await vi.waitFor(() => {
      expect(state().watchedDetails['w-late']?.detail?.tasks.map((task) => task.key)).toEqual(['fresh']);
    });
    staleRead.resolve(detailOf('w-late', [viewTask('stale')]));
    await settleAnswers();

    expect(state().watchedDetails['w-late']?.detail?.tasks.map((task) => task.key)).toEqual(['fresh']);
    unwatchSecond();
  });

  it('marks a workflow it cannot read as gone, so the panel stops waiting, and clears that once a read lands', async () => {
    const bridge = installBridge();
    // A deleted workflow's Done tasks keep their membership, so a panel can
    // watch a workflow whose read fails every time.
    bridge.get.mockRejectedValueOnce(new Error('No workflow "w-gone" in this project.'));

    const unwatch = state().watchDetail('p', 'w-gone');
    await vi.waitFor(() => {
      expect(state().watchedDetails['w-gone']?.readFailure).toBe('gone');
    });
    expect(state().watchedDetails['w-gone']?.detail).toBeNull();

    // A later change push whose read lands (the failure was passing) clears it.
    bridge.get.mockResolvedValueOnce(detailOf('w-gone'));
    state().handleChanged({ projectId: 'p', workflowId: 'w-gone' });
    await vi.waitFor(() => {
      expect(state().watchedDetails['w-gone']?.readFailure).toBeNull();
    });
    expect(state().watchedDetails['w-gone']?.detail?.workflow.id).toBe('w-gone');
    unwatch();
  });

  it('keeps the newer read when the older one answers first and the workflow was dropped between', async () => {
    const bridge = installBridge();
    const staleRead = deferred<WorkflowDetail>();
    const freshRead = deferred<WorkflowDetail>();
    bridge.get.mockReturnValueOnce(staleRead.promise).mockReturnValueOnce(freshRead.promise);

    state().watchDetail('p', 'w-early')();
    const unwatchSecond = state().watchDetail('p', 'w-early');

    // The older read answers into the new watch before the newer one does: it
    // must not land, so the panel never shows it.
    staleRead.resolve(detailOf('w-early', [viewTask('stale')]));
    await settleAnswers();
    expect(state().watchedDetails['w-early']?.detail).toBeNull();

    freshRead.resolve(detailOf('w-early', [viewTask('fresh')]));
    await vi.waitFor(() => {
      expect(state().watchedDetails['w-early']?.detail?.tasks.map((task) => task.key)).toEqual(['fresh']);
    });
    unwatchSecond();
  });

  // Only main's not-found refusal means a workflow is gone. A panel that took any
  // other rejection for "gone" would tell the user a live workflow was deleted.
  describe('a failed read', () => {
    // Electron decorates a rejected invoke with the channel and the error class,
    // so this is the sentence as the renderer receives it from a real main.
    const NOT_FOUND_AS_SENT = 'Error invoking remote method \'workflows:get\': WorkflowRequestError: No workflow "w-sent" in this project. List them with kangentic_list_workflows.';

    beforeEach(() => {
      // Each failed read logs a warning by design; keep the run output readable.
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('is unreadable, never gone, when main refuses for any other reason', async () => {
      const bridge = installBridge();
      bridge.get.mockRejectedValueOnce(new Error('database is locked'));

      const unwatch = state().watchDetail('p', 'w-locked');
      await vi.waitFor(() => {
        expect(state().watchedDetails['w-locked']?.readFailure).not.toBeNull();
      });

      expect(state().watchedDetails['w-locked']?.readFailure).toBe('unreadable');
      expect(state().watchedDetails['w-locked']?.detail).toBeNull();
      unwatch();
    });

    it('keeps the detail the panel already has when a later read is refused for another reason', async () => {
      const bridge = installBridge();
      bridge.get.mockResolvedValueOnce(detailOf('w-kept', [viewTask('shown')]));
      const unwatch = state().watchDetail('p', 'w-kept');
      await vi.waitFor(() => {
        expect(state().watchedDetails['w-kept']?.detail?.tasks.map((task) => task.key)).toEqual(['shown']);
      });

      bridge.get.mockRejectedValueOnce(new Error('database is locked'));
      state().handleChanged({ projectId: 'p', workflowId: 'w-kept' });
      await vi.waitFor(() => {
        expect(state().watchedDetails['w-kept']?.readFailure).not.toBeNull();
      });

      expect(state().watchedDetails['w-kept']?.readFailure).toBe('unreadable');
      expect(state().watchedDetails['w-kept']?.detail?.tasks.map((task) => task.key)).toEqual(['shown']);
      unwatch();
    });

    it('is gone when the not-found refusal arrives as Electron sends it, channel and class prefix included', async () => {
      const bridge = installBridge();
      bridge.get.mockRejectedValueOnce(new Error(NOT_FOUND_AS_SENT));

      const unwatch = state().watchDetail('p', 'w-sent');
      await vi.waitFor(() => {
        expect(state().watchedDetails['w-sent']?.readFailure).not.toBeNull();
      });

      expect(state().watchedDetails['w-sent']?.readFailure).toBe('gone');
      unwatch();
    });

    it('does not mark a workflow that was watched again, when the read from before the re-watch fails late', async () => {
      const bridge = installBridge();
      const staleRead = deferred<WorkflowDetail>();
      const freshRead = deferred<WorkflowDetail>();
      bridge.get.mockReturnValueOnce(staleRead.promise).mockReturnValueOnce(freshRead.promise);

      state().watchDetail('p', 'w-stale-fail')();
      const unwatchSecond = state().watchDetail('p', 'w-stale-fail');
      expect(bridge.get).toHaveBeenCalledTimes(2);

      // The first panel's read fails with the strongest verdict there is, the
      // not-found refusal. It belongs to a watch that ended, so it says nothing
      // about the workflow the second panel is reading.
      staleRead.reject(new Error('No workflow "w-stale-fail" in this project.'));
      await settleAnswers();
      expect(state().watchedDetails['w-stale-fail']?.readFailure).toBeNull();

      freshRead.resolve(detailOf('w-stale-fail', [viewTask('fresh')]));
      await vi.waitFor(() => {
        expect(state().watchedDetails['w-stale-fail']?.detail?.tasks.map((task) => task.key)).toEqual(['fresh']);
      });
      expect(state().watchedDetails['w-stale-fail']?.readFailure).toBeNull();
      unwatchSecond();
    });

    it.each([
      ['gone', 'No workflow "w-again" in this project.'],
      ['unreadable', 'database is locked'],
    ] as const)('writes nothing when a read fails again with the same kind (%s)', async (kind, message) => {
      const bridge = installBridge();
      bridge.get.mockRejectedValueOnce(new Error(message));
      const unwatch = state().watchDetail('p', 'w-again');
      await vi.waitFor(() => {
        expect(state().watchedDetails['w-again']?.readFailure).toBe(kind);
      });
      const watchedBefore = state().watchedDetails;

      // A change push reads again, and the read fails the same way.
      bridge.get.mockRejectedValueOnce(new Error(message));
      state().handleChanged({ projectId: 'p', workflowId: 'w-again' });
      expect(bridge.get).toHaveBeenCalledTimes(2);
      await settleAnswers();

      // The same object, not an equal copy: every panel subscribed to the map would re-render for nothing.
      expect(state().watchedDetails).toBe(watchedBefore);
      unwatch();
    });

    it('is read again by a second watcher, which keeps showing the failure until the read lands', async () => {
      const bridge = installBridge();
      bridge.get.mockRejectedValueOnce(new Error('No workflow "w-retry" in this project.'));
      const unwatchFirst = state().watchDetail('p', 'w-retry');
      await vi.waitFor(() => {
        expect(state().watchedDetails['w-retry']?.readFailure).toBe('gone');
      });
      expect(bridge.get).toHaveBeenCalledTimes(1);

      const secondRead = deferred<WorkflowDetail>();
      bridge.get.mockReturnValueOnce(secondRead.promise);
      const unwatchSecond = state().watchDetail('p', 'w-retry');

      // The panel opens over the failure and asks again...
      expect(bridge.get).toHaveBeenCalledTimes(2);
      // ...without flashing Loading in the meantime: the failure carries over.
      expect(state().watchedDetails['w-retry']).toMatchObject({ watchers: 2, readFailure: 'gone', detail: null });

      secondRead.resolve(detailOf('w-retry', [viewTask('back')]));
      await vi.waitFor(() => {
        expect(state().watchedDetails['w-retry']?.readFailure).toBeNull();
      });
      expect(state().watchedDetails['w-retry']?.detail?.tasks.map((task) => task.key)).toEqual(['back']);
      unwatchSecond();
      unwatchFirst();
    });

    it('is not asked again by a second watcher over a workflow that read fine (the control)', async () => {
      const bridge = installBridge();
      bridge.get.mockResolvedValueOnce(detailOf('w-fine'));
      const unwatchFirst = state().watchDetail('p', 'w-fine');
      await vi.waitFor(() => {
        expect(state().watchedDetails['w-fine']?.detail).not.toBeNull();
      });

      const unwatchSecond = state().watchDetail('p', 'w-fine');
      await settleAnswers();

      expect(bridge.get).toHaveBeenCalledTimes(1);
      expect(state().watchedDetails['w-fine']?.watchers).toBe(2);
      unwatchSecond();
      unwatchFirst();
    });
  });
});

describe('setPositions', () => {
  function placed(canvasX: number | null, canvasY: number | null): WorkflowDetail {
    return detailOf('w', [viewTask('a', canvasX, canvasY)]);
  }

  beforeEach(() => {
    useWorkflowStore.setState({ projectId: 'p', selectedWorkflowId: 'w', detail: placed(null, null) });
  });

  it('reads the workflow again when main refuses the save, so the card goes back', async () => {
    const bridge = installBridge();
    bridge.setPositions.mockRejectedValue(new Error('That workflow is no longer in this project.'));
    bridge.get.mockResolvedValue(placed(null, null));

    const saved = await useWorkflowStore.getState().setPositions([{ key: 'a', x: 40.4, y: 80.6 }]);

    expect(saved).toBe(false);
    // Drawn where it was dropped while the save was out...
    expect(bridge.get).toHaveBeenCalledWith('p', 'w');
    // ...and put back by the read, which is not awaited by the save.
    await vi.waitFor(() => {
      expect(useWorkflowStore.getState().detail?.tasks[0]).toMatchObject({ canvasX: null, canvasY: null });
    });
  });

  it('draws the dropped place at once, rounded, and does not read again after a save main accepts', async () => {
    const bridge = installBridge();
    bridge.setPositions.mockResolvedValue(undefined);

    const saved = await useWorkflowStore.getState().setPositions([{ key: 'a', x: 40.4, y: 80.6 }]);

    expect(saved).toBe(true);
    expect(useWorkflowStore.getState().detail?.tasks[0]).toMatchObject({ canvasX: 40, canvasY: 81 });
    expect(bridge.get).not.toHaveBeenCalled();
  });
});

// A delete is a round trip to main. The workflow it names is read when the user
// acted, so what it clears afterwards is that workflow's selection and no other.
describe('deleteWorkflow', () => {
  const state = () => useWorkflowStore.getState();

  beforeEach(() => {
    useWorkflowStore.setState({
      projectId: 'p', summaries: [summaryOf('a')], selectedWorkflowId: 'a', detail: detailOf('a'), selectedTaskKey: null,
    });
  });

  it('keeps the workflow the user picked while the delete was in flight', async () => {
    const bridge = installBridge();
    const deletion = deferred<WorkflowDeleteReport>();
    const reload = deferred<WorkflowSummary[]>();
    bridge.delete.mockReturnValue(deletion.promise);
    bridge.list.mockReturnValue(reload.promise);
    bridge.get.mockImplementation(async (_projectId: string, workflowId: string) => detailOf(workflowId));

    const deleting = state().deleteWorkflow();
    expect(bridge.delete).toHaveBeenCalledWith('p', 'a', undefined);
    // The user picks another workflow while main deletes the first.
    state().selectWorkflow('b');
    deletion.resolve({ deleted: 0, failed: [] });
    // The picker reload starts only after the delete's own bookkeeping ran.
    await vi.waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(1));
    expect(state().selectedWorkflowId).toBe('b');

    // The reload names another workflow first: were b's selection dropped, the picker would fall back to it.
    reload.resolve([summaryOf('c'), summaryOf('b')]);
    await expect(deleting).resolves.toBe(true);
    expect(state().selectedWorkflowId).toBe('b');
    expect(state().detail?.workflow.id).toBe('b');
  });

  it('clears the selection when the workflow deleted is still the one on screen, so the picker moves on (the control)', async () => {
    const bridge = installBridge();
    const reload = deferred<WorkflowSummary[]>();
    bridge.delete.mockResolvedValue({ deleted: 0, failed: [] });
    bridge.list.mockReturnValue(reload.promise);
    bridge.get.mockImplementation(async (_projectId: string, workflowId: string) => detailOf(workflowId));

    const deleting = state().deleteWorkflow();
    await vi.waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(1));
    // The deleted workflow leaves the view at once, before the reload answers.
    expect(state().selectedWorkflowId).toBeNull();
    expect(state().detail).toBeNull();

    reload.resolve([summaryOf('c')]);
    await expect(deleting).resolves.toBe(true);
    expect(state().selectedWorkflowId).toBe('c');
  });

  it('moves on as soon as main says the workflow is gone, while the delete still waits on its tasks', async () => {
    // Main deletes the workflow, pushes the change, then deletes each task that
    // never started, so the answer can come seconds after the push.
    const bridge = installBridge();
    const deletion = deferred<WorkflowDeleteReport>();
    bridge.delete.mockReturnValue(deletion.promise);
    bridge.list.mockResolvedValue([summaryOf('c')]);
    bridge.get.mockImplementation(async (_projectId: string, workflowId: string) => {
      if (workflowId === 'a') throw new Error('No workflow "a".');
      return detailOf(workflowId);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const deleting = state().deleteWorkflow({ deleteNeverStarted: true });
    state().handleChanged({ projectId: 'p', workflowId: 'a' });

    // Off the deleted workflow before the delete has answered.
    await vi.waitFor(() => expect(state().selectedWorkflowId).toBe('c'));
    expect(state().detail?.workflow.id).toBe('c');

    deletion.resolve({ deleted: 2, failed: [] });
    await expect(deleting).resolves.toBe(true);
    expect(state().selectedWorkflowId).toBe('c');
  });

  it('hands main the choice to delete the tasks that never started, and names the ones it could not', async () => {
    const bridge = installBridge();
    bridge.delete.mockResolvedValue({
      deleted: 1,
      failed: [{ projectId: 'p', taskId: 't-14', displayId: 14, reason: 'worktree removal timed out' }],
    });
    bridge.list.mockResolvedValue([]);
    toastHarness.addToast.mockClear();

    await expect(state().deleteWorkflow({ deleteNeverStarted: true })).resolves.toBe(true);

    expect(bridge.delete).toHaveBeenCalledWith('p', 'a', { deleteNeverStarted: true });
    expect(toastHarness.addToast).toHaveBeenCalledTimes(1);
    // Main's own reason, after the task it names, and a card that opens that task.
    expect(toastHarness.addToast).toHaveBeenCalledWith(expect.objectContaining({
      message: '#14 stays in To Do. Worktree removal timed out.',
      variant: 'error',
      onOpen: expect.any(Function),
    }));
  });
});

// A create is a round trip to main too, and the user can switch projects while
// it runs. The view then shows the other project, so the new workflow is not
// selected over it.
describe('createWorkflow', () => {
  const state = () => useWorkflowStore.getState();

  it('selects the new workflow in the project it was created in (the control)', async () => {
    const bridge = installBridge();
    const creation = deferred<Workflow>();
    bridge.create.mockReturnValue(creation.promise);
    bridge.list.mockResolvedValue([summaryOf('created')]);
    bridge.get.mockImplementation(async (_projectId: string, workflowId: string) => detailOf(workflowId));
    useWorkflowStore.setState({ projectId: 'p', summaries: [], selectedWorkflowId: null, detail: null });

    const creating = state().createWorkflow(null);
    expect(bridge.create).toHaveBeenCalledWith('p', null);
    creation.resolve(detailOf('created').workflow);
    await expect(creating).resolves.toMatchObject({ id: 'created' });

    expect(state().projectId).toBe('p');
    expect(state().selectedWorkflowId).toBe('created');
  });

  it('leaves the project the user switched to alone: the new workflow is not selected over it, though it is still returned', async () => {
    const bridge = installBridge();
    const creation = deferred<Workflow>();
    bridge.create.mockReturnValue(creation.promise);
    bridge.list.mockResolvedValue([]);
    bridge.get.mockImplementation(async (_projectId: string, workflowId: string) => detailOf(workflowId));
    // The view already shows project q, loaded by the switch.
    useWorkflowStore.setState({ projectId: 'q', summaries: [summaryOf('q-first')], selectedWorkflowId: 'q-first', detail: null });
    // Every write the store makes from here is kept: a wrong one the switch's own
    // load would overwrite a moment later still reaches the screen for a frame.
    const writes: Array<{ projectId: string | null; selectedWorkflowId: string | null }> = [];
    const unsubscribe = useWorkflowStore.subscribe((next) => {
      writes.push({ projectId: next.projectId, selectedWorkflowId: next.selectedWorkflowId });
    });
    try {
      const creating = state().createWorkflow(null);
      expect(bridge.create).toHaveBeenCalledWith('p', null);
      // The user switches projects while main creates the workflow in the first.
      projectHarness.currentProjectId = 'q';
      creation.resolve(detailOf('created').workflow);
      await expect(creating).resolves.toMatchObject({ id: 'created' });
    } finally {
      unsubscribe();
    }

    expect(writes.filter((write) => write.projectId === 'p' || write.selectedWorkflowId === 'created')).toEqual([]);
    expect(state().projectId).toBe('q');
    expect(state().selectedWorkflowId).toBe('q-first');
  });
});
