/**
 * restartIdleKeepingRecap (ipc/helpers/idle-restart-keeps-recap.ts): an idle restart of a task's
 * session that hands a return recap's mark to the session replacing it, then lets what waited on
 * the recap go at once, since the replacement resumes idle and takes no recap turn (task #1147).
 *
 * The restart and the task row are fakes. The recap registry is the real one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  restart: vi.fn(),
  getById: vi.fn(),
}));

vi.mock('../../src/main/ipc/handlers/session-reconcile', () => ({ restartSessionForSettingsChange: hoisted.restart }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: () => ({ tasks: { getById: hoisted.getById } }),
}));

const { restartIdleKeepingRecap } = await import('../../src/main/ipc/helpers/idle-restart-keeps-recap');
const {
  forgetRecapSession,
  markRecapSession,
  recapKindOf,
  resetRecapSessionsForTests,
  whenRecapTurnEnds,
} = await import('../../src/main/automations/turn-end/recap-turns');

import type { IpcContext } from '../../src/main/ipc/ipc-context';

const TEN_MINUTES_MS = 10 * 60 * 1000;
const context = {} as IpcContext;

/** Records how a wait settled, so one that never settles reads as `pending`. */
function trackWait(wait: Promise<boolean>): () => boolean | 'pending' {
  let outcome: boolean | 'pending' = 'pending';
  void wait.then((proceed) => { outcome = proceed; });
  return () => outcome;
}

afterEach(() => {
  resetRecapSessionsForTests();
  hoisted.restart.mockReset();
  hoisted.getById.mockReset();
});

describe('restartIdleKeepingRecap', () => {
  it('only restarts a session with no recap mark, and never reads the task row', async () => {
    hoisted.restart.mockResolvedValue({ ok: true });

    const result = await restartIdleKeepingRecap(context, 'project-1', '/mock/project', 'task-1', 'session-old', 'switching-account');

    expect(result).toEqual({ ok: true });
    expect(hoisted.restart).toHaveBeenCalledTimes(1);
    expect(hoisted.restart).toHaveBeenCalledWith(context, 'project-1', '/mock/project', 'task-1', { phase: 'switching-account' });
    expect(hoisted.getById).not.toHaveBeenCalled();
  });

  it('only restarts when there is no from session', async () => {
    hoisted.restart.mockResolvedValue({ ok: true });

    const result = await restartIdleKeepingRecap(context, 'project-1', '/mock/project', 'task-1', null, 'switching-account');

    expect(result).toEqual({ ok: true });
    expect(hoisted.restart).toHaveBeenCalledTimes(1);
    expect(hoisted.getById).not.toHaveBeenCalled();
  });

  it('lets a waiter on a return recap go (true, not dropped) once the replacement resumes idle', async () => {
    markRecapSession('session-old', 'return');
    const outcome = trackWait(whenRecapTurnEnds('session-old', TEN_MINUTES_MS));
    let rowSessionId: string | null = 'session-old';
    hoisted.getById.mockImplementation(() => ({ id: 'task-1', session_id: rowSessionId }));
    hoisted.restart.mockImplementation(async () => {
      // The real restart: the old session's removal tells its waiters it is gone, and the row names the new one.
      forgetRecapSession('session-old', false);
      rowSessionId = 'session-new';
      return { ok: true };
    });

    const result = await restartIdleKeepingRecap(context, 'project-1', '/mock/project', 'task-1', 'session-old', 'switching-account');
    await Promise.resolve();

    expect(result).toEqual({ ok: true });
    expect(outcome()).toBe(true);
    expect(recapKindOf('session-new')).toBeNull();
    expect(recapKindOf('session-old')).toBeNull();
  });

  it('tells the waiter the session is gone when the restart fails and the task has no session', async () => {
    markRecapSession('session-old', 'return');
    const outcome = trackWait(whenRecapTurnEnds('session-old', TEN_MINUTES_MS));
    hoisted.getById.mockImplementation(() => ({ id: 'task-1', session_id: null }));
    hoisted.restart.mockImplementation(async () => {
      forgetRecapSession('session-old', false);
      return { ok: false, reason: 'no session' };
    });

    const result = await restartIdleKeepingRecap(context, 'project-1', '/mock/project', 'task-1', 'session-old', 'switching-account');
    await Promise.resolve();

    expect(result).toEqual({ ok: false, reason: 'no session' });
    expect(outcome()).toBe(false);
  });
});
