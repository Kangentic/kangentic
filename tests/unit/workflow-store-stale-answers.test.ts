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
