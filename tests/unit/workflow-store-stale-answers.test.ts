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
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowDetail, WorkflowViewTask } from '../../src/shared/types';

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: { id: 'p' } }) },
}));
vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

const { useWorkflowStore } = await import('../../src/renderer/stores/workflow-store');

function viewTask(key: string, canvasX: number | null = null, canvasY: number | null = null): WorkflowViewTask {
  return {
    key, projectId: 'p', task: null, planned: null, title: `Task ${key}`, displayId: null, place: 'planned',
    swimlaneId: null, steps: [], canvasX, canvasY,
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

interface WorkflowsBridge {
  get: ReturnType<typeof vi.fn>;
  setPositions: ReturnType<typeof vi.fn>;
}

function installBridge(): WorkflowsBridge {
  const workflows: WorkflowsBridge = { get: vi.fn(), setPositions: vi.fn() };
  (globalThis as unknown as { window: { electronAPI: { workflows: WorkflowsBridge } } }).window = {
    electronAPI: { workflows },
  };
  return workflows;
}

beforeEach(() => {
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
