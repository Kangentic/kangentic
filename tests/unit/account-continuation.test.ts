import { describe, expect, it, vi } from 'vitest';
import { AccountContinuation, CONTINUE_PROMPT, type LimitedSession } from '../../src/main/accounts/account-continuation';
import type { AgentAccount } from '../../src/shared/agent-accounts';

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;

function account(id: string, position: number, usedPercentage: number | null, status: AgentAccount['status'] = 'ok'): AgentAccount {
  return {
    id, agent: 'test-agent', kind: position === 1 ? 'default' : 'folder', folderPath: null, keyFilePath: null, keyNames: [],
    email: `${id}@example.com`, plan: 'Max', status, position, historyPrivate: false,
    lastUsage: usedPercentage === null ? null : [
      { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage, resetsAt: NOW + 86_400 * position, windowDurationSeconds: 604_800 },
    ],
    lastUsageAt: null, absentWindowIds: [], createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const SESSION: LimitedSession = { sessionId: 'session-1', taskId: 'task-1', projectId: 'project-1', agent: 'test-agent', accountId: 'one' };

function rig(options: {
  accounts: AgentAccount[];
  /** What a fresh read finds, by account id. An account left out keeps its stored usage. */
  freshUsage?: Record<string, number>;
  autoSwitchAtLimit?: boolean;
  continues?: boolean;
  canContinue?: boolean;
  session?: LimitedSession;
  openingPrompt?: string | null;
}) {
  const accounts = options.accounts.map((entry) => ({ ...entry }));
  const readUsageNow = vi.fn(async (accountId: string) => {
    const fresh = options.freshUsage?.[accountId];
    const target = accounts.find((entry) => entry.id === accountId);
    if (fresh !== undefined && target?.lastUsage) target.lastUsage = [{ ...target.lastUsage[0], usedPercentage: fresh }];
  });
  const continueOn = vi.fn(async () => options.continues ?? true);
  const notifySwitched = vi.fn();
  const notifyAllFull = vi.fn();
  let live: LimitedSession | null = options.session ?? SESSION;
  const continuation = new AccountContinuation({
    readConfig: () => ({ orderMode: 'manual', autoSwitchAtLimit: options.autoSwitchAtLimit ?? true }),
    findTaskSession: (sessionId) => (live && live.sessionId === sessionId ? live : null),
    canContinue: () => options.canContinue ?? true,
    openingPrompt: () => (options.openingPrompt === undefined ? 'Read the handoff.' : options.openingPrompt),
    isUsageLimitFailure: (_agent, detail) => detail.includes('rate_limit'),
    ordered: () => accounts,
    readUsageNow,
    continueOn,
    notifySwitched,
    notifyAllFull,
    now: () => NOW_MS,
  });
  return { continuation, accounts, readUsageNow, continueOn, notifySwitched, notifyAllFull, endSession: () => { live = null; }, restoreSession: (restored: LimitedSession) => { live = restored; } };
}

describe('AccountContinuation', () => {
  it('continues on the next account with room when the turn failed at a limit and the account is full', async () => {
    const { continuation, continueOn, notifySwitched, readUsageNow } = rig({
      accounts: [account('one', 1, 96), account('two', 2, 40)],
      freshUsage: { one: 100 },
    });
    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('continued');
    // Both accounts were read before the move: the one that failed, then the one chosen.
    expect(readUsageNow.mock.calls.map(([accountId]) => accountId)).toEqual(['one', 'two']);
    expect(continueOn).toHaveBeenCalledWith(SESSION, 'two', CONTINUE_PROMPT);
    expect(notifySwitched).toHaveBeenCalledTimes(1);
  });

  it('leaves a session alone when the fresh read shows its account still has room', async () => {
    const { continuation, continueOn } = rig({ accounts: [account('one', 1, 100), account('two', 2, 40)], freshUsage: { one: 62 } });
    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('ignored');
    expect(continueOn).not.toHaveBeenCalled();
  });

  it('ignores a failure that is not a usage limit, with no read at all', async () => {
    const { continuation, readUsageNow } = rig({ accounts: [account('one', 1, 100), account('two', 2, 40)] });
    expect(await continuation.onTurnFailure('session-1', 'server_error')).toBe('ignored');
    expect(readUsageNow).not.toHaveBeenCalled();
  });

  it('does nothing with the setting off, with one account, or for a session that is not a task session', async () => {
    const off = rig({ accounts: [account('one', 1, 100), account('two', 2, 40)], autoSwitchAtLimit: false });
    expect(await off.continuation.onTurnFailure('session-1', 'rate_limit')).toBe('ignored');
    const single = rig({ accounts: [account('one', 1, 100)] });
    expect(await single.continuation.onTurnFailure('session-1', 'rate_limit')).toBe('ignored');
    const other = rig({ accounts: [account('one', 1, 100), account('two', 2, 40)] });
    expect(await other.continuation.onTurnFailure('a-command-terminal', 'rate_limit')).toBe('ignored');
    expect(off.continueOn).not.toHaveBeenCalled();
    expect(single.continueOn).not.toHaveBeenCalled();
    expect(other.readUsageNow).not.toHaveBeenCalled();
  });

  it('passes over an account that turns out full when read, and a signed-out one', async () => {
    const { continuation, continueOn } = rig({
      accounts: [account('one', 1, 100), account('two', 2, 80), account('three', 3, 10, 'signed-out'), account('four', 4, 5)],
      freshUsage: { two: 100 },
    });
    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('continued');
    expect(continueOn).toHaveBeenCalledWith(SESSION, 'four', CONTINUE_PROMPT);
  });

  it('waits when every account is full, says so once, and continues when one frees', async () => {
    const { continuation, accounts, continueOn, notifyAllFull, notifySwitched } = rig({
      accounts: [account('one', 1, 100), account('two', 2, 100)],
    });
    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('waiting');
    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('waiting');
    expect(notifyAllFull).toHaveBeenCalledTimes(1);
    // The soonest reset among the full accounts is the one named.
    expect(notifyAllFull.mock.calls[0][1]?.account.id).toBe('one');
    expect(continueOn).not.toHaveBeenCalled();

    // Still full: a recheck moves nothing.
    await continuation.recheck();
    expect(continueOn).not.toHaveBeenCalled();

    // Account two reset.
    accounts[1].lastUsage = [{ ...accounts[1].lastUsage![0], usedPercentage: 0 }];
    await continuation.recheck();
    expect(continueOn).toHaveBeenCalledWith(SESSION, 'two', CONTINUE_PROMPT);
    expect(notifySwitched).toHaveBeenCalledTimes(1);
    // Continued once: a later recheck has nothing waiting.
    await continuation.recheck();
    expect(continueOn).toHaveBeenCalledTimes(1);
  });

  it('forgets a waiting session that ended', async () => {
    const { continuation, accounts, continueOn, endSession } = rig({ accounts: [account('one', 1, 100), account('two', 2, 100)] });
    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('waiting');
    endSession();
    accounts[1].lastUsage = [{ ...accounts[1].lastUsage![0], usedPercentage: 0 }];
    await continuation.recheck();
    expect(continueOn).not.toHaveBeenCalled();
  });

  // Task #1147: a resume on a spent account fired its SessionStart and nothing else, so no failed
  // turn ever came, and its opening prompt (the Testing column's handoff) was never answered.
  describe('a resumed session that starts on a full account', () => {
    const RESUMED: LimitedSession = { ...SESSION, resuming: true };

    it('moves with its opening prompt when its row shows full', async () => {
      const { continuation, continueOn, readUsageNow } = rig({ accounts: [account('one', 1, 100), account('two', 2, 40)], session: RESUMED });
      expect(await continuation.onSessionStarted('session-1')).toBe('continued');
      expect(readUsageNow.mock.calls.map(([accountId]) => accountId)).toEqual(['one', 'two']);
      expect(continueOn).toHaveBeenCalledWith(RESUMED, 'two', 'Read the handoff.');
    });

    it('reads a near-full row, which a spent account reports, and moves only when the read finds it full', async () => {
      const spent = rig({ accounts: [account('one', 1, 99), account('two', 2, 40)], session: RESUMED, freshUsage: { one: 100 } });
      expect(await spent.continuation.onSessionStarted('session-1')).toBe('continued');
      const roomy = rig({ accounts: [account('one', 1, 99), account('two', 2, 40)], session: RESUMED, freshUsage: { one: 96 } });
      expect(await roomy.continuation.onSessionStarted('session-1')).toBe('ignored');
      expect(roomy.readUsageNow.mock.calls.map(([accountId]) => accountId)).toEqual(['one']);
      expect(roomy.continueOn).not.toHaveBeenCalled();
    });

    it('resumes idle when the session started with no prompt', async () => {
      const { continuation, continueOn } = rig({ accounts: [account('one', 1, 100), account('two', 2, 40)], session: RESUMED, openingPrompt: null });
      expect(await continuation.onSessionStarted('session-1')).toBe('continued');
      expect(continueOn).toHaveBeenCalledWith(RESUMED, 'two', undefined);
    });

    it('waits with its opening prompt when every account is full, and carries it when one frees', async () => {
      const { continuation, accounts, continueOn } = rig({ accounts: [account('one', 1, 100), account('two', 2, 100)], session: RESUMED });
      expect(await continuation.onSessionStarted('session-1')).toBe('waiting');
      accounts[1].lastUsage = [{ ...accounts[1].lastUsage![0], usedPercentage: 0 }];
      await continuation.recheck();
      expect(continueOn).toHaveBeenCalledWith(RESUMED, 'two', 'Read the handoff.');
    });

    it('checks only the first start, since a compact or a clear fires SessionStart mid-session', async () => {
      const { continuation, accounts, readUsageNow } = rig({ accounts: [account('one', 1, 40), account('two', 2, 40)], session: RESUMED });
      expect(await continuation.onSessionStarted('session-1')).toBe('ignored');
      accounts[0].lastUsage = [{ ...accounts[0].lastUsage![0], usedPercentage: 100 }];
      expect(await continuation.onSessionStarted('session-1')).toBe('ignored');
      expect(readUsageNow).not.toHaveBeenCalled();
    });

    it('does not spend the one check on a start that finds no live session', async () => {
      const { continuation, continueOn, endSession, restoreSession } = rig({ accounts: [account('one', 1, 100), account('two', 2, 40)], session: RESUMED });
      endSession();
      expect(await continuation.onSessionStarted('session-1')).toBe('ignored');
      restoreSession(RESUMED);
      expect(await continuation.onSessionStarted('session-1')).toBe('continued');
      expect(continueOn).toHaveBeenCalledWith(RESUMED, 'two', 'Read the handoff.');
    });

    it('checks a session again after it was forgotten', async () => {
      const { continuation, accounts } = rig({ accounts: [account('one', 1, 40), account('two', 2, 40)], session: RESUMED });
      expect(await continuation.onSessionStarted('session-1')).toBe('ignored');
      accounts[0].lastUsage = [{ ...accounts[0].lastUsage![0], usedPercentage: 100 }];
      expect(await continuation.onSessionStarted('session-1')).toBe('ignored');
      continuation.forgetSession('session-1');
      expect(await continuation.onSessionStarted('session-1')).toBe('continued');
    });

    it('keeps its opening prompt when a failed turn finds it already waiting', async () => {
      const { continuation, accounts, continueOn } = rig({ accounts: [account('one', 1, 100), account('two', 2, 100)], session: RESUMED });
      expect(await continuation.onSessionStarted('session-1')).toBe('waiting');
      expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('waiting');
      accounts[1].lastUsage = [{ ...accounts[1].lastUsage![0], usedPercentage: 0 }];
      await continuation.recheck();
      expect(continueOn).toHaveBeenCalledWith(RESUMED, 'two', 'Read the handoff.');
    });

    it('continues with Continue. after a failed turn when it waited idle', async () => {
      const { continuation, accounts, continueOn } = rig({ accounts: [account('one', 1, 100), account('two', 2, 100)], session: RESUMED, openingPrompt: null });
      expect(await continuation.onSessionStarted('session-1')).toBe('waiting');
      expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('waiting');
      accounts[1].lastUsage = [{ ...accounts[1].lastUsage![0], usedPercentage: 0 }];
      await continuation.recheck();
      expect(continueOn).toHaveBeenCalledWith(RESUMED, 'two', CONTINUE_PROMPT);
    });

    it('resumes idle on its own account when that account is the one that frees', async () => {
      const { continuation, accounts, continueOn } = rig({ accounts: [account('one', 1, 100), account('two', 2, 100)], session: RESUMED, openingPrompt: null });
      expect(await continuation.onSessionStarted('session-1')).toBe('waiting');
      accounts[0].lastUsage = [{ ...accounts[0].lastUsage![0], usedPercentage: 0 }];
      await continuation.recheck();
      expect(continueOn).toHaveBeenCalledWith(RESUMED, 'one', undefined);
    });
  });

  it('reads nothing when a session starts on an account well short of full', async () => {
    const { continuation, readUsageNow, continueOn } = rig({ accounts: [account('one', 1, 80), account('two', 2, 40)], session: { ...SESSION, resuming: true } });
    expect(await continuation.onSessionStarted('session-1')).toBe('ignored');
    expect(readUsageNow).not.toHaveBeenCalled();
    expect(continueOn).not.toHaveBeenCalled();
  });

  it('leaves a fresh session to its failed turn, and a start with the setting off, another session, or an agent that cannot move', async () => {
    const accounts = () => [account('one', 1, 100), account('two', 2, 40)];
    const fresh = rig({ accounts: accounts() });
    expect(await fresh.continuation.onSessionStarted('session-1')).toBe('ignored');
    const off = rig({ accounts: accounts(), autoSwitchAtLimit: false, session: { ...SESSION, resuming: true } });
    expect(await off.continuation.onSessionStarted('session-1')).toBe('ignored');
    const other = rig({ accounts: accounts(), session: { ...SESSION, resuming: true } });
    expect(await other.continuation.onSessionStarted('a-command-terminal')).toBe('ignored');
    const stays = rig({ accounts: accounts(), canContinue: false, session: { ...SESSION, resuming: true } });
    expect(await stays.continuation.onSessionStarted('session-1')).toBe('ignored');
    expect(await stays.continuation.onTurnFailure('session-1', 'rate_limit')).toBe('ignored');
    for (const { readUsageNow } of [fresh, off, other, stays]) expect(readUsageNow).not.toHaveBeenCalled();
  });

  // The follower of automatic order leaves a session alone while the continuation owns its next move.
  describe('isHandling', () => {
    it('is false for a session the continuation has not touched', () => {
      const { continuation } = rig({ accounts: [account('one', 1, 100), account('two', 2, 40)] });
      expect(continuation.isHandling('session-1')).toBe(false);
    });

    it('is true while the decision is in flight and false once it settles', async () => {
      const { continuation, readUsageNow } = rig({ accounts: [account('one', 1, 100), account('two', 2, 40)] });
      let finishRead: () => void = () => undefined;
      readUsageNow.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRead = resolve; }));
      const decision = continuation.onTurnFailure('session-1', 'rate_limit');
      expect(continuation.isHandling('session-1')).toBe(true);
      expect(continuation.isHandling('another-session')).toBe(false);
      finishRead();
      expect(await decision).toBe('continued');
      expect(continuation.isHandling('session-1')).toBe(false);
    });

    it('is false after a decision that left the session alone', async () => {
      const { continuation } = rig({ accounts: [account('one', 1, 100), account('two', 2, 40)], freshUsage: { one: 50 } });
      expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('ignored');
      expect(continuation.isHandling('session-1')).toBe(false);
    });

    it('is true while the session waits for an account to free, and false once it was forgotten', async () => {
      const { continuation } = rig({ accounts: [account('one', 1, 100), account('two', 2, 100)] });
      expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('waiting');
      expect(continuation.isHandling('session-1')).toBe(true);
      continuation.forgetSession('session-1');
      expect(continuation.isHandling('session-1')).toBe(false);
    });

    it('is false again once a waiting session was continued', async () => {
      const { continuation, accounts } = rig({ accounts: [account('one', 1, 100), account('two', 2, 100)] });
      expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('waiting');
      accounts[1].lastUsage = [{ ...accounts[1].lastUsage![0], usedPercentage: 0 }];
      await continuation.recheck();
      expect(continuation.isHandling('session-1')).toBe(false);
    });
  });

  it('reports nothing switched when the restart did not happen', async () => {
    const { continuation, notifySwitched } = rig({ accounts: [account('one', 1, 100), account('two', 2, 40)], continues: false });
    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('ignored');
    expect(notifySwitched).not.toHaveBeenCalled();
  });
});
