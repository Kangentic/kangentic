/**
 * The Stop script failure toast's ration (src/main/stop-script/stop-script-failure.ts):
 * one push a minute per project, released after 60 s, and a failure that finds the
 * window gone starts no cooldown, so the next one with a live window is sent.
 * Only the clock is faked: nothing here waits on a timer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { StopScriptFailedEvent } from '../../src/shared/types';
import { IPC } from '../../src/shared/ipc-channels';
import { reportStopScriptFailure, resetStopScriptFailureReportsForTests } from '../../src/main/stop-script/stop-script-failure';

const COOLDOWN_MS = 60_000;

function eventFor(projectId: string, taskId = 'task-1'): StopScriptFailedEvent {
  return { projectId, taskId, taskTitle: 'Fix login', failure: { kind: 'exit-code', exitCode: 1, detail: 'boom' } };
}

function makeContext(destroyed = false) {
  const send = vi.fn();
  const mainWindow = { isDestroyed: vi.fn(() => destroyed), webContents: { send } };
  return { context: { mainWindow } as unknown as IpcContext, mainWindow, send };
}

describe('reportStopScriptFailure', () => {
  let startedAt: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    startedAt = Date.now();
    resetStopScriptFailureReportsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushes the failure to the window', () => {
    const { context, send } = makeContext();

    reportStopScriptFailure(context, eventFor('proj-1'));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(IPC.STOP_SCRIPT_FAILED, eventFor('proj-1'));
  });

  it('sends one toast a minute per project, and releases the cooldown after 60 s', () => {
    const { context, send } = makeContext();

    reportStopScriptFailure(context, eventFor('proj-1'));
    vi.setSystemTime(startedAt + COOLDOWN_MS - 1);
    reportStopScriptFailure(context, eventFor('proj-1', 'task-2'));
    expect(send).toHaveBeenCalledTimes(1);

    vi.setSystemTime(startedAt + COOLDOWN_MS);
    reportStopScriptFailure(context, eventFor('proj-1', 'task-3'));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(IPC.STOP_SCRIPT_FAILED, eventFor('proj-1', 'task-3'));
  });

  it('rations each project on its own', () => {
    const { context, send } = makeContext();

    reportStopScriptFailure(context, eventFor('proj-1'));
    reportStopScriptFailure(context, eventFor('proj-2'));

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends nothing to a window that is gone, and starts no cooldown for it', () => {
    const gone = makeContext(true);
    const live = makeContext(false);

    reportStopScriptFailure(gone.context, eventFor('proj-1'));
    expect(gone.send).not.toHaveBeenCalled();

    // No time has passed: a cooldown started by the first call would hold this one back.
    reportStopScriptFailure(live.context, eventFor('proj-1', 'task-2'));
    expect(live.send).toHaveBeenCalledTimes(1);
  });
});
