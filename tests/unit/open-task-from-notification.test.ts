/**
 * Unit tests for `openTaskFromNotification`
 * (`src/renderer/utils/open-task-from-notification.ts`): the one path an OS
 * notification click and a toast click both take to open a task's detail.
 *
 * Strategy: replace the project and session stores with `getState()` stubs and
 * stand in for the two `window.electronAPI` members the function reads
 * (`popOut.descriptor` and `monitor.revealTask`). The node test env has no
 * `window`, so each test attaches one to `globalThis` and `afterEach` removes it.
 *
 * The cross-project branch is the part with a rule worth pinning: the pending
 * id is set before the project switch, and cleared again when the switch does
 * not land, so the next successful switch cannot open a task the user never
 * asked for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OpenProjectOutcome } from '../../src/renderer/stores/project-store';

const mocks = vi.hoisted(() => ({
  useProjectStore: { getState: vi.fn() },
  useSessionStore: { getState: vi.fn() },
}));

vi.mock('../../src/renderer/stores/project-store', () => ({ useProjectStore: mocks.useProjectStore }));
vi.mock('../../src/renderer/stores/session-store', () => ({ useSessionStore: mocks.useSessionStore }));

import { openTaskFromNotification } from '../../src/renderer/utils/open-task-from-notification';

const CURRENT_PROJECT_ID = 'project-current';
const OTHER_PROJECT_ID = 'project-other';
const TASK_ID = 'task-42';

const requestHideCommandBar = vi.fn();
const setDetailTaskId = vi.fn();
const setPendingOpenTaskId = vi.fn();
const openProject = vi.fn<(projectId: string) => Promise<OpenProjectOutcome>>();
const revealTask = vi.fn<(projectId: string, taskId: string) => Promise<void>>();

type TestWindow = {
  electronAPI: {
    popOut: { descriptor: { kind: string; params: Record<string, never> } | null };
    monitor: { revealTask: typeof revealTask };
  };
};

function installWindow(options: { inPopOut: boolean }): void {
  const testWindow: TestWindow = {
    electronAPI: {
      popOut: { descriptor: options.inPopOut ? { kind: 'monitor', params: {} } : null },
      monitor: { revealTask },
    },
  };
  (globalThis as unknown as { window: TestWindow }).window = testWindow;
}

/** A promise the test settles by hand, so it can look at the state between the call and the settle. */
function deferredOutcome(): { promise: Promise<OpenProjectOutcome>; settle: (outcome: OpenProjectOutcome) => void } {
  let settle: (outcome: OpenProjectOutcome) => void = () => undefined;
  const promise = new Promise<OpenProjectOutcome>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** Let the `.then` the function attached to `openProject` run. */
async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  requestHideCommandBar.mockReset();
  setDetailTaskId.mockReset();
  setPendingOpenTaskId.mockReset();
  openProject.mockReset();
  revealTask.mockReset();
  revealTask.mockResolvedValue(undefined);
  mocks.useProjectStore.getState.mockReset();
  mocks.useSessionStore.getState.mockReset();
  mocks.useProjectStore.getState.mockImplementation(() => ({
    currentProject: { id: CURRENT_PROJECT_ID },
    openProject,
  }));
  mocks.useSessionStore.getState.mockImplementation(() => ({
    requestHideCommandBar,
    setDetailTaskId,
    setPendingOpenTaskId,
  }));
  installWindow({ inPopOut: false });
});

afterEach(() => {
  delete (globalThis as unknown as { window?: TestWindow }).window;
});

describe('openTaskFromNotification in the main window', () => {
  it('opens the task detail directly when the task is in the open project', () => {
    openTaskFromNotification(CURRENT_PROJECT_ID, TASK_ID);

    expect(setDetailTaskId).toHaveBeenCalledTimes(1);
    expect(setDetailTaskId).toHaveBeenCalledWith(TASK_ID);
    expect(openProject).not.toHaveBeenCalled();
    expect(setPendingOpenTaskId).not.toHaveBeenCalled();
  });

  it('hides the Command Terminal layer so the detail does not open behind it', () => {
    openTaskFromNotification(CURRENT_PROJECT_ID, TASK_ID);

    expect(requestHideCommandBar).toHaveBeenCalledTimes(1);
  });

  it('keeps the pending id after the project opens, so the board opens the task on arrival', async () => {
    const { promise, settle } = deferredOutcome();
    openProject.mockReturnValue(promise);

    openTaskFromNotification(OTHER_PROJECT_ID, TASK_ID);

    expect(setPendingOpenTaskId).toHaveBeenCalledTimes(1);
    expect(setPendingOpenTaskId).toHaveBeenCalledWith(TASK_ID);
    expect(openProject).toHaveBeenCalledWith(OTHER_PROJECT_ID);
    expect(setDetailTaskId).not.toHaveBeenCalled();

    settle('opened');
    await flushPromises();

    // Still exactly one call: the id set before the switch, never cleared.
    expect(setPendingOpenTaskId).toHaveBeenCalledTimes(1);
    expect(setPendingOpenTaskId).not.toHaveBeenCalledWith(null);
  });

  it.each<OpenProjectOutcome>(['missing-path', 'not-found', 'failed'])(
    'clears the pending id once the project switch settles as %s, so a later switch cannot open it',
    async (outcome) => {
      const { promise, settle } = deferredOutcome();
      openProject.mockReturnValue(promise);

      openTaskFromNotification(OTHER_PROJECT_ID, TASK_ID);

      // While the switch is in flight the id stays set: the board reads it on arrival.
      expect(setPendingOpenTaskId).toHaveBeenCalledTimes(1);
      expect(setPendingOpenTaskId).toHaveBeenLastCalledWith(TASK_ID);

      settle(outcome);
      await flushPromises();

      expect(setPendingOpenTaskId).toHaveBeenCalledTimes(2);
      expect(setPendingOpenTaskId).toHaveBeenLastCalledWith(null);
      expect(setDetailTaskId).not.toHaveBeenCalled();
    },
  );
});

describe('openTaskFromNotification in a pop-out window', () => {
  beforeEach(() => {
    installWindow({ inPopOut: true });
  });

  it('asks main to reveal the task and touches neither store', () => {
    openTaskFromNotification(OTHER_PROJECT_ID, TASK_ID);

    expect(revealTask).toHaveBeenCalledTimes(1);
    expect(revealTask).toHaveBeenCalledWith(OTHER_PROJECT_ID, TASK_ID);
    expect(mocks.useSessionStore.getState).not.toHaveBeenCalled();
    expect(mocks.useProjectStore.getState).not.toHaveBeenCalled();
    expect(openProject).not.toHaveBeenCalled();
    expect(setDetailTaskId).not.toHaveBeenCalled();
    expect(setPendingOpenTaskId).not.toHaveBeenCalled();
  });
});
