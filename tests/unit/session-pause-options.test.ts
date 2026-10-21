/**
 * `pauseTaskSession`'s options for a pause Kangentic decides on its own (the
 * idle timeout, and low memory): who the pause is recorded as, and the
 * eligibility re-check it runs under the task lock.
 *
 * The re-check is what keeps an automatic pause from landing on an agent that
 * started working, or that the user resumed or moved, while the pause waited
 * for the lock. A declined pause writes nothing and stops nothing. A guarded
 * pause also leaves an in-flight resume alone: the user's Resume is the newer
 * intent, where a user Pause cancels a resume because it is.
 *
 * The lock is the real one; the reconcile, the DB writes and the resume cancel
 * are mocked, so each step's call can be asserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../src/shared/types';

const mocks = vi.hoisted(() => ({
  reconcileTaskSessionRef: vi.fn(),
  applySuspendDbWrites: vi.fn(),
  abortInFlightResume: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({
  reconcileTaskSessionRef: mocks.reconcileTaskSessionRef,
  applySuspendDbWrites: mocks.applySuspendDbWrites,
}));

vi.mock('../../src/main/ipc/handlers/session-resume-controllers', () => ({
  abortInFlightResume: mocks.abortInFlightResume,
}));

import { pauseTaskSession } from '../../src/main/ipc/handlers/session-pause';

const LIVE_SESSION = { id: 'sess-live', taskId: 'task-1', status: 'running' } as Session;

function makeContext() {
  return {
    currentProjectId: 'proj-1',
    sessionManager: { suspend: vi.fn(async () => {}) },
  };
}

describe('pauseTaskSession options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reconcileTaskSessionRef.mockReturnValue({ task: { id: 'task-1' }, liveSession: LIVE_SESSION });
  });

  it('records the user\'s pause by default and cancels an in-flight resume', async () => {
    const context = makeContext();

    const outcome = await pauseTaskSession(context as never, 'task-1');

    expect(outcome).toBe('paused');
    expect(mocks.abortInFlightResume).toHaveBeenCalledWith('task-1');
    expect(mocks.applySuspendDbWrites).toHaveBeenCalledWith(context, 'proj-1', 'task-1', 'user');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-live');
  });

  it('records Kangentic\'s own pause as auto', async () => {
    const context = makeContext();

    await pauseTaskSession(context as never, 'task-1', { suspendedBy: 'auto', stillEligible: () => true });

    expect(mocks.applySuspendDbWrites).toHaveBeenCalledWith(context, 'proj-1', 'task-1', 'auto');
    expect(context.sessionManager.suspend).toHaveBeenCalledWith('sess-live');
  });

  it('hands the re-check the live session it found under the lock', async () => {
    const stillEligible = vi.fn(() => true);

    await pauseTaskSession(makeContext() as never, 'task-1', { suspendedBy: 'auto', stillEligible });

    expect(stillEligible).toHaveBeenCalledWith(LIVE_SESSION);
  });

  it('declines, writing and stopping nothing, when the session no longer qualifies', async () => {
    const context = makeContext();
    const onAccepted = vi.fn();

    const outcome = await pauseTaskSession(context as never, 'task-1', {
      suspendedBy: 'auto',
      stillEligible: () => false,
      onAccepted,
    });

    expect(outcome).toBe('declined');
    expect(mocks.applySuspendDbWrites).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(context.sessionManager.suspend).not.toHaveBeenCalled();
  });

  it('leaves an in-flight resume alone when the pause is guarded', async () => {
    await pauseTaskSession(makeContext() as never, 'task-1', { suspendedBy: 'auto', stillEligible: () => true });

    expect(mocks.abortInFlightResume).not.toHaveBeenCalled();
  });

  it('answers not-live without asking the re-check when there is no live session', async () => {
    mocks.reconcileTaskSessionRef.mockReturnValue({ task: { id: 'task-1' }, liveSession: null });
    const stillEligible = vi.fn(() => true);

    const outcome = await pauseTaskSession(makeContext() as never, 'task-1', { suspendedBy: 'auto', stillEligible });

    expect(outcome).toBe('not-live');
    expect(stillEligible).not.toHaveBeenCalled();
    expect(mocks.applySuspendDbWrites).not.toHaveBeenCalled();
  });
});
