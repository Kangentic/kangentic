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
    lastUsageAt: null, createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const SESSION: LimitedSession = { sessionId: 'session-1', taskId: 'task-1', projectId: 'project-1', agent: 'test-agent', accountId: 'one' };

function rig(options: {
  accounts: AgentAccount[];
  /** What a fresh read finds, by account id. An account left out keeps its stored usage. */
  freshUsage?: Record<string, number>;
  autoSwitchAtLimit?: boolean;
  continues?: boolean;
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
  let live: LimitedSession | null = SESSION;
  const continuation = new AccountContinuation({
    readConfig: () => ({ orderMode: 'manual', autoSwitchAtLimit: options.autoSwitchAtLimit ?? true }),
    findTaskSession: (sessionId) => (live && live.sessionId === sessionId ? live : null),
    isUsageLimitFailure: (_agent, detail) => detail.includes('rate_limit'),
    ordered: () => accounts,
    readUsageNow,
    continueOn,
    notifySwitched,
    notifyAllFull,
    now: () => NOW_MS,
  });
  return { continuation, accounts, readUsageNow, continueOn, notifySwitched, notifyAllFull, endSession: () => { live = null; } };
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

  it('reports nothing switched when the restart did not happen', async () => {
    const { continuation, notifySwitched } = rig({ accounts: [account('one', 1, 100), account('two', 2, 40)], continues: false });
    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('ignored');
    expect(notifySwitched).not.toHaveBeenCalled();
  });
});
