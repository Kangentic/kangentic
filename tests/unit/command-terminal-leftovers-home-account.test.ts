/**
 * Which account a Command Terminal's background-session stop runs under
 * (src/main/ipc/helpers/command-terminal-leftovers.ts, task #1113).
 *
 * A background session is listed only under the home the terminal ran in. A /login there moves the
 * session's `accountId` but never its home, so the stop must name the home's account, falling back
 * to the session's own `accountId` when the manager cannot say.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Session } from '../../src/shared/types';
import { CommandTerminalLeftoverReaper } from '../../src/main/ipc/helpers/command-terminal-leftovers';
import type { EndedCommandTerminal } from '../../src/main/ipc/helpers/command-terminal-background-session';

function endedTerminal(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    taskId: 'transient-task-uuid',
    projectId: 'project-1',
    pid: 4242,
    status: 'exited',
    shell: 'pwsh.exe',
    cwd: 'C:\\work\\project',
    startedAt: '2026-10-11T19:00:00.000Z',
    exitCode: 0,
    resuming: false,
    transient: true,
    commandTerminalSlot: 'slot-1',
    commandTerminalLabel: 'Terminal',
    agentSessionId: 'background-conversation-1',
    accountId: 'account-b',
    ...overrides,
  } as unknown as Session;
}

function makeRig(getSessionHomeAccountId?: (sessionId: string) => string | null) {
  const sessionManager = new EventEmitter();
  if (getSessionHomeAccountId) Object.assign(sessionManager, { getSessionHomeAccountId });
  const stopBackgroundSession = vi.fn(async (_ended: EndedCommandTerminal) => undefined);
  const reaper = new CommandTerminalLeftoverReaper({
    sessionManager: sessionManager as never,
    reap: async () => undefined,
    stopBackgroundSession,
    isShuttingDown: () => false,
  });
  reaper.start();
  return { sessionManager, stopBackgroundSession, reaper };
}

describe('CommandTerminalLeftoverReaper background stop account', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stops under the home account when a /login repointed the session to another account', async () => {
    const { sessionManager, stopBackgroundSession, reaper } = makeRig(() => 'account-a');
    sessionManager.emit('session-removed', 'session-1', endedTerminal({ accountId: 'account-b' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
    expect(stopBackgroundSession.mock.calls[0][0].accountId).toBe('account-a');
    reaper.dispose();
  });

  it('asks the manager by the removed session id', async () => {
    const lookup = vi.fn((_sessionId: string): string | null => 'account-a');
    const { sessionManager, reaper } = makeRig(lookup);
    sessionManager.emit('session-removed', 'session-1', endedTerminal());
    await vi.advanceTimersByTimeAsync(0);

    expect(lookup).toHaveBeenCalledWith('session-1');
    reaper.dispose();
  });

  it('falls back to the session accountId when the manager answers null', async () => {
    const { sessionManager, stopBackgroundSession, reaper } = makeRig(() => null);
    sessionManager.emit('session-removed', 'session-1', endedTerminal({ accountId: 'account-b' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(stopBackgroundSession.mock.calls[0][0].accountId).toBe('account-b');
    reaper.dispose();
  });

  it('falls back to the session accountId when the manager has no getSessionHomeAccountId', async () => {
    const { sessionManager, stopBackgroundSession, reaper } = makeRig();
    sessionManager.emit('session-removed', 'session-1', endedTerminal({ accountId: 'account-b' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(stopBackgroundSession.mock.calls[0][0].accountId).toBe('account-b');
    reaper.dispose();
  });
});
