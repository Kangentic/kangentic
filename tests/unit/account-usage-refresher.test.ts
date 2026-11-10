import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountUsageRefresher, USAGE_FRESH_MS } from '../../src/main/accounts/account-usage';
import type { AgentAccount } from '../../src/shared/agent-accounts';
import type { RateLimitWindow } from '../../src/shared/types';

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const INTERVAL_MS = 15 * 60 * 1000;

function window(resetsAt: number): RateLimitWindow {
  return { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 10, resetsAt, windowDurationSeconds: 604_800 };
}

function account(id: string, agent: string, readAgoMs: number | null, lastUsage: RateLimitWindow[] | null = null): AgentAccount {
  return {
    id, agent, kind: 'folder', folderPath: null, keyFilePath: null, keyNames: [],
    email: `${id}@example.com`, plan: 'Pro', status: 'ok', position: 1, historyPrivate: false,
    lastUsage, lastUsageAt: readAgoMs === null ? null : new Date(NOW_MS - readAgoMs).toISOString(),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function rig(accounts: AgentAccount[]) {
  const refreshUsage = vi.fn(async (_accountId: string) => undefined);
  const refresher = new AccountUsageRefresher({ refreshUsage } as never, {
    listAccounts: () => accounts,
    now: () => NOW_MS,
  });
  return { refresher, refreshUsage };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AccountUsageRefresher.refreshAccount', () => {
  it('skips a reading under a minute old and reads an older one', async () => {
    const { refresher, refreshUsage } = rig([account('recent', 'a', USAGE_FRESH_MS - 1000), account('old', 'a', USAGE_FRESH_MS + 1000)]);
    await refresher.refreshAccount('recent');
    expect(refreshUsage).not.toHaveBeenCalled();
    await refresher.refreshAccount('old');
    expect(refreshUsage).toHaveBeenCalledWith('old');
  });

  it('reads a recent reading when one of its windows has reset since', async () => {
    const { refresher, refreshUsage } = rig([account('lapsed', 'a', 10_000, [window(NOW_SECONDS - 5)])]);
    await refresher.refreshAccount('lapsed');
    expect(refreshUsage).toHaveBeenCalledWith('lapsed');
  });

  it('reads a recent reading when forced', async () => {
    const { refresher, refreshUsage } = rig([account('recent', 'a', 1000)]);
    await refresher.refreshAccount('recent', true);
    expect(refreshUsage).toHaveBeenCalledTimes(1);
  });

  it('still reads when a forced request arrives for an account already queued unforced', async () => {
    const { refresher, refreshUsage } = rig([account('recent', 'a', 1000)]);
    const unforced = refresher.refreshAccount('recent');
    const forced = refresher.refreshAccount('recent', true);
    await Promise.all([unforced, forced]);
    expect(refreshUsage).toHaveBeenCalledTimes(1);
  });

  it('reads an account queued twice once', async () => {
    const { refresher, refreshUsage } = rig([account('stale', 'a', null)]);
    await Promise.all([refresher.refreshAccount('stale'), refresher.refreshAccount('stale')]);
    expect(refreshUsage).toHaveBeenCalledTimes(1);
  });

  it('keeps going after a read fails', async () => {
    const { refresher, refreshUsage } = rig([account('one', 'a', null), account('two', 'a', null)]);
    refreshUsage.mockRejectedValueOnce(new Error('cli failed'));
    await Promise.all([refresher.refreshAccount('one'), refresher.refreshAccount('two')]);
    expect(refreshUsage.mock.calls.map(([accountId]) => accountId)).toEqual(['one', 'two']);
  });
});

describe('AccountUsageRefresher.refreshAll', () => {
  it('reads only agents with two or more accounts when scheduled, and every agent when requested', async () => {
    const accounts = [account('a1', 'multi', null), account('a2', 'multi', null), account('solo', 'single', null)];
    const scheduled = rig(accounts);
    await scheduled.refresher.refreshAll('scheduled');
    expect(scheduled.refreshUsage.mock.calls.map(([accountId]) => accountId)).toEqual(['a1', 'a2']);

    const requested = rig(accounts);
    await requested.refresher.refreshAll('requested');
    expect(requested.refreshUsage.mock.calls.map(([accountId]) => accountId)).toEqual(['a1', 'a2', 'solo']);
  });

  it('arms the reset timer when the soonest reset falls within one interval, and reads again when it fires', async () => {
    const resetInSeconds = 5 * 60;
    const accounts = [
      account('a1', 'multi', null, [window(NOW_SECONDS + resetInSeconds)]),
      account('a2', 'multi', null, [window(NOW_SECONDS + 3 * 3600)]),
    ];
    const { refresher, refreshUsage } = rig(accounts);
    await refresher.refreshAll('scheduled');
    expect(refreshUsage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(resetInSeconds * 1000 + 30_000);
    expect(refreshUsage).toHaveBeenCalledTimes(4);
    refresher.dispose();
  });

  it('arms no reset timer when the soonest reset is past the next scheduled pass', async () => {
    const accounts = [
      account('a1', 'multi', null, [window(NOW_SECONDS + 3 * 3600)]),
      account('a2', 'multi', null, [window(NOW_SECONDS + 5 * 3600)]),
    ];
    const { refresher } = rig(accounts);
    await refresher.refreshAll('scheduled');
    expect(vi.getTimerCount()).toBe(0);
    expect(INTERVAL_MS).toBeLessThan(3 * 3600 * 1000);
  });

  it('arms no reset timer for an agent with one account', async () => {
    const { refresher } = rig([account('solo', 'single', null, [window(NOW_SECONDS + 300)])]);
    await refresher.refreshAll('requested');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('AccountUsageRefresher.dispose', () => {
  it('stops every timer and ignores later calls', async () => {
    const accounts = [
      account('a1', 'multi', null, [window(NOW_SECONDS + 300)]),
      account('a2', 'multi', null, null),
    ];
    const { refresher, refreshUsage } = rig(accounts);
    refresher.start();
    await refresher.refreshAll('scheduled');
    // Startup timer, interval and reset timer.
    expect(vi.getTimerCount()).toBe(3);
    refreshUsage.mockClear();

    refresher.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS);
    await refresher.refreshAccount('a1', true);
    await refresher.refreshAll('requested');
    expect(refreshUsage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
