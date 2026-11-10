import { describe, expect, it, vi } from 'vitest';
import { CONTINUE_PROMPT } from '../../src/main/accounts/account-continuation';
import { moveRunningSessions, type RunningTaskSession } from '../../src/main/accounts/account-session-move';

function session(sessionId: string, accountId: string | null, working = false): RunningTaskSession {
  return { sessionId, taskId: `task-${sessionId}`, projectId: 'project-1', accountId, working };
}

describe('moveRunningSessions', () => {
  it('restarts each running session on the account, telling only a working one to continue', async () => {
    const restartOn = vi.fn(async () => true);
    const sessions = [session('idle', 'one'), session('working', 'one', true)];
    expect(await moveRunningSessions({ listRunning: () => sessions, restartOn }, 'test-agent', 'two')).toEqual({ moved: 2, failed: 0 });
    expect(restartOn.mock.calls).toEqual([
      [sessions[0], 'two', undefined],
      [sessions[1], 'two', CONTINUE_PROMPT],
    ]);
  });

  it('leaves alone a session already on the account and one accounts do not apply to', async () => {
    const restartOn = vi.fn(async () => true);
    const sessions = [session('already', 'two'), session('wsl', null), session('other', 'three')];
    expect(await moveRunningSessions({ listRunning: () => sessions, restartOn }, 'test-agent', 'two')).toEqual({ moved: 1, failed: 0 });
    expect(restartOn).toHaveBeenCalledTimes(1);
    expect(restartOn.mock.calls[0][0]).toBe(sessions[2]);
  });

  it('restarts one at a time, and a restart that fails or throws does not stop the rest', async () => {
    let running = 0;
    let mostAtOnce = 0;
    const restartOn = vi.fn(async (moving: RunningTaskSession) => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await Promise.resolve();
      running -= 1;
      if (moving.sessionId === 'throws') throw new Error('suspend failed');
      return moving.sessionId !== 'refused';
    });
    const sessions = [session('throws', 'one'), session('refused', 'one'), session('fine', 'one')];
    expect(await moveRunningSessions({ listRunning: () => sessions, restartOn }, 'test-agent', 'two')).toEqual({ moved: 1, failed: 2 });
    expect(restartOn).toHaveBeenCalledTimes(3);
    expect(mostAtOnce).toBe(1);
  });
});
