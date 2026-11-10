import { describe, expect, it, vi } from 'vitest';
import { AccountContinuation, CONTINUE_PROMPT, type LimitedSession } from '../../src/main/accounts/account-continuation';
import type { AgentAccount } from '../../src/shared/agent-accounts';

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;

function account(id: string, position: number, usedPercentage: number): AgentAccount {
  return {
    id, agent: 'test-agent', kind: position === 1 ? 'default' : 'folder', folderPath: null, keyFilePath: null, keyNames: [],
    email: `${id}@example.com`, plan: 'Max', status: 'ok', position, historyPrivate: false,
    lastUsage: [
      { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage, resetsAt: NOW + 86_400 * position, windowDurationSeconds: 604_800 },
    ],
    lastUsageAt: null, createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function setUsed(target: AgentAccount, usedPercentage: number): void {
  target.lastUsage = [{ ...(target.lastUsage as NonNullable<AgentAccount['lastUsage']>)[0], usedPercentage }];
}

const SESSION: LimitedSession = { sessionId: 'session-1', taskId: 'task-1', projectId: 'project-1', agent: 'test-agent', accountId: 'one' };

function rig(accounts: AgentAccount[], readUsageNow: (accountId: string) => Promise<void> = async () => undefined) {
  const read = vi.fn(readUsageNow);
  const continueOn = vi.fn(async (_session: LimitedSession, _accountId: string, _prompt: string) => true);
  const notifySwitched = vi.fn();
  const notifyAllFull = vi.fn();
  const continuation = new AccountContinuation({
    readConfig: () => ({ orderMode: 'manual', autoSwitchAtLimit: true }),
    findTaskSession: (sessionId) => (sessionId === SESSION.sessionId ? SESSION : null),
    isUsageLimitFailure: (_agent, detail) => detail.includes('rate_limit'),
    ordered: () => accounts,
    readUsageNow: read,
    continueOn,
    notifySwitched,
    notifyAllFull,
    now: () => NOW_MS,
  });
  return { continuation, read, continueOn, notifySwitched, notifyAllFull };
}

describe('AccountContinuation in-flight guard', () => {
  it('ignores a second failure for a session whose first pass is still reading usage', async () => {
    const accounts = [account('one', 1, 100), account('two', 2, 40)];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { continuation, continueOn } = rig(accounts, async (accountId) => {
      if (accountId === 'one') await gate;
    });

    const first = continuation.onTurnFailure('session-1', 'rate_limit');
    const second = await continuation.onTurnFailure('session-1', 'rate_limit');
    expect(second).toBe('ignored');
    expect(continueOn).not.toHaveBeenCalled();

    release();
    expect(await first).toBe('continued');
    expect(continueOn).toHaveBeenCalledTimes(1);
    expect(continueOn).toHaveBeenCalledWith(SESSION, 'two', CONTINUE_PROMPT);
  });

  it('ignores a pass whose usage read rejects, then lets a later failure proceed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const accounts = [account('one', 1, 100), account('two', 2, 40)];
    let reads = 0;
    const { continuation, continueOn } = rig(accounts, async () => {
      reads += 1;
      if (reads === 1) throw new Error('cli unavailable');
    });

    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('ignored');
    expect(continueOn).not.toHaveBeenCalled();

    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('continued');
    expect(continueOn).toHaveBeenCalledWith(SESSION, 'two', CONTINUE_PROMPT);
    vi.restoreAllMocks();
  });
});

describe('AccountContinuation waiting on its own account', () => {
  it('continues a waiting session on its own account when a recheck finds that account has room', async () => {
    const accounts = [account('one', 1, 100), account('two', 2, 100)];
    const { continuation, continueOn, notifyAllFull } = rig(accounts);

    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('waiting');
    expect(notifyAllFull).toHaveBeenCalledTimes(1);

    // Its own account reset; the other is still full.
    setUsed(accounts[0], 20);
    await continuation.recheck();
    expect(continueOn).toHaveBeenCalledTimes(1);
    expect(continueOn).toHaveBeenCalledWith(SESSION, 'one', CONTINUE_PROMPT);

    // No longer waiting: a later recheck moves nothing.
    await continuation.recheck();
    expect(continueOn).toHaveBeenCalledTimes(1);
  });

  it('leaves a session that was never waiting alone when its own account has room', async () => {
    const accounts = [account('one', 1, 40), account('two', 2, 10)];
    const { continuation, continueOn, notifySwitched } = rig(accounts);
    expect(await continuation.onTurnFailure('session-1', 'rate_limit')).toBe('ignored');
    expect(continueOn).not.toHaveBeenCalled();
    expect(notifySwitched).not.toHaveBeenCalled();
  });
});
