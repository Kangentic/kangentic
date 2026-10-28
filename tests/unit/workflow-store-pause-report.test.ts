/**
 * What the workflow store does with main's report of a Pause, driven through the
 * real store with a hand-held bridge. A Pause that could not stop some of its
 * agents raises one error toast naming their tasks, since those cards keep
 * working under a header that reads Paused. A clean Pause and every Resume
 * raise none: a Resume's failures show each task's own spawn-blocked notice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowPauseReport, WorkflowResumeReport } from '../../src/shared/types';

const harness = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: { id: 'p' } }) },
}));
vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: harness.addToast }) },
}));
vi.mock('../../src/renderer/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ upsertSession: vi.fn() }) },
}));

const { useWorkflowStore } = await import('../../src/renderer/stores/workflow-store');

interface WorkflowsBridge {
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

function installBridge(): WorkflowsBridge {
  const workflows: WorkflowsBridge = { pause: vi.fn(), resume: vi.fn() };
  (globalThis as unknown as { window: { electronAPI: { workflows: WorkflowsBridge } } }).window = {
    electronAPI: { workflows },
  };
  return workflows;
}

const failure = (displayId: number) => ({ projectId: 'p', taskId: `task-${displayId}`, displayId });

beforeEach(() => {
  harness.addToast.mockClear();
  useWorkflowStore.setState({ projectId: 'p', selectedWorkflowId: 'w' });
});

describe('pauseWorkflow', () => {
  it('names the tasks whose agents it could not stop, in one error toast', async () => {
    const bridge = installBridge();
    const report: WorkflowPauseReport = { paused: 2, notLive: 1, failed: [failure(917), failure(918)] };
    bridge.pause.mockResolvedValue(report);

    expect(await useWorkflowStore.getState().pauseWorkflow()).toBe(true);

    expect(bridge.pause).toHaveBeenCalledWith('p', 'w');
    expect(harness.addToast).toHaveBeenCalledTimes(1);
    expect(harness.addToast).toHaveBeenCalledWith({
      title: 'Couldn\'t pause 2 agents',
      message: 'Still running: #917, #918.',
      variant: 'error',
    });
  });

  it('says one agent in the singular', async () => {
    installBridge().pause.mockResolvedValue({ paused: 0, notLive: 3, failed: [failure(917)] } satisfies WorkflowPauseReport);

    await useWorkflowStore.getState().pauseWorkflow();

    expect(harness.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Couldn\'t pause 1 agent', message: 'Still running: #917.' }));
  });

  it('raises no toast when every agent paused', async () => {
    installBridge().pause.mockResolvedValue({ paused: 3, notLive: 2, failed: [] } satisfies WorkflowPauseReport);

    await useWorkflowStore.getState().pauseWorkflow();

    expect(harness.addToast).not.toHaveBeenCalled();
  });
});

describe('resumeWorkflow', () => {
  it('raises no toast of its own for a failed resume', async () => {
    installBridge().resume.mockResolvedValue({ resumed: 1, started: 0, alreadyRunning: 0, failed: [failure(918)] } satisfies WorkflowResumeReport);

    expect(await useWorkflowStore.getState().resumeWorkflow()).toBe(true);

    expect(harness.addToast).not.toHaveBeenCalled();
  });
});
