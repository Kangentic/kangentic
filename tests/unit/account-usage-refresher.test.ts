import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountUsageRefresher,
  type AccountUsageRefresherOptions,
  USAGE_FRESH_MS,
  USAGE_STALE_FOR_RANKING_MS,
  needsReadBeforeRanking,
} from '../../src/main/accounts/account-usage';
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

function rig(accounts: AgentAccount[], optionOverrides: Partial<AccountUsageRefresherOptions> = {}) {
  /** Every read in the order it ran: `usage:<id>` or `identity:<id>`. */
  const reads: string[] = [];
  const refreshUsage = vi.fn(async (accountId: string) => {
    reads.push(`usage:${accountId}`);
    return true;
  });
  const refreshIdentity = vi.fn(async (accountId: string) => {
    reads.push(`identity:${accountId}`);
    return null;
  });
  const checkHomeIdentity = vi.fn(async (accountId: string) => {
    reads.push(`home:${accountId}`);
    return null;
  });
  const refresher = new AccountUsageRefresher({ refreshUsage, refreshIdentity, checkHomeIdentity }, {
    listAccounts: () => accounts,
    now: () => NOW_MS,
    ...optionOverrides,
  });
  return { refresher, refreshUsage, refreshIdentity, checkHomeIdentity, reads };
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

  // The incident: the own login was signed out by a failed sign-in read, and two days of
  // scheduled passes skipped it because only the Accounts tab read sign-ins.
  it('reads the sign-in of an account that is not ok before its usage on a scheduled pass', async () => {
    const parked = { ...account('own', 'multi', null), kind: 'default' as const, status: 'signed-out' as const };
    const { refresher, reads } = rig([parked, account('other', 'multi', null)]);
    await refresher.refreshAll('scheduled');
    expect(reads).toEqual(['identity:own', 'usage:own', 'home:other', 'usage:other']);
  });

  it('reads every sign-in at startup, and no key file', async () => {
    const keyFile = { ...account('key', 'multi', null), kind: 'key-file' as const };
    const { refresher, reads } = rig([account('one', 'multi', null), keyFile, account('solo', 'single', null)]);
    await refresher.refreshAll('startup');
    expect(reads).toEqual(['identity:one', 'usage:one', 'usage:key']);
  });

  it('checks the home of each ok account and reads the sign-in of each other one on a scheduled pass, never both', async () => {
    const failureReporter = { report: vi.fn() };
    const parked = { ...account('parked', 'multi', null), status: 'signed-out' as const };
    const { refresher, refreshIdentity, checkHomeIdentity, reads } = rig(
      [account('one', 'multi', null), parked, account('two', 'multi', null), account('solo', 'single', null)],
      { failureReporter },
    );
    await refresher.refreshAll('scheduled');
    expect(checkHomeIdentity.mock.calls.map(([accountId]) => accountId)).toEqual(['one', 'two']);
    expect(refreshIdentity.mock.calls.map(([accountId]) => accountId)).toEqual(['parked']);
    expect(reads.filter((read) => read.endsWith(':solo'))).toEqual([]);
    expect(failureReporter.report).not.toHaveBeenCalled();
  });

  it('reads the sign-in, not the cheap check, of an ok account at startup', async () => {
    const { refresher, refreshIdentity, checkHomeIdentity } = rig([account('one', 'multi', null), account('two', 'multi', null)]);
    await refresher.refreshAll('startup');
    expect(refreshIdentity.mock.calls.map(([accountId]) => accountId)).toEqual(['one', 'two']);
    expect(checkHomeIdentity).not.toHaveBeenCalled();
  });

  it('reads no sign-in on a requested pass, whose caller reads them', async () => {
    const parked = { ...account('own', 'multi', null), status: 'signed-out' as const };
    const { refresher, refreshIdentity } = rig([parked, account('other', 'multi', null)]);
    await refresher.refreshAll('requested');
    expect(refreshIdentity).not.toHaveBeenCalled();
  });

  it('runs the first pass after start as the startup pass', async () => {
    const { refresher, refreshIdentity } = rig([account('one', 'multi', null), account('two', 'multi', null)]);
    refresher.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refreshIdentity.mock.calls.map(([accountId]) => accountId)).toEqual(['one', 'two']);
    refresher.dispose();
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

describe('needsReadBeforeRanking', () => {
  it.each<[string, AgentAccount, boolean]>([
    ['no reading', account('none', 'a', null), true],
    ['a reading from this pass', account('recent', 'a', 60_000, [window(NOW_SECONDS + 3600)]), false],
    ['a reading older than a pass should leave', account('old', 'a', USAGE_STALE_FOR_RANKING_MS + 1, [window(NOW_SECONDS + 3600)]), true],
    ['a recent reading whose window has reset', account('lapsed', 'a', 60_000, [window(NOW_SECONDS - 1)]), true],
    ['an account that cannot run', { ...account('out', 'a', null), status: 'signed-out' }, false],
    ['a key file', { ...account('key', 'a', null), kind: 'key-file' }, false],
  ])('%s: %s', (_name, candidate, expected) => {
    expect(needsReadBeforeRanking(candidate, NOW_MS)).toBe(expected);
  });
});

describe('AccountUsageRefresher.readBeforeRanking', () => {
  it('force-reads only the accounts whose reading ran out, then resolves', async () => {
    const accounts = [account('stale', 'a', null), account('recent', 'a', 1000, [window(NOW_SECONDS + 3600)])];
    const { refresher, reads } = rig(accounts);
    await refresher.readBeforeRanking(accounts);
    expect(reads).toEqual(['usage:stale']);
  });

  it('asks an account once a minute, so a read that keeps failing costs one run', async () => {
    const accounts = [account('stale', 'a', null)];
    const { refresher, refreshUsage } = rig(accounts);
    await refresher.readBeforeRanking(accounts);
    await refresher.readBeforeRanking(accounts);
    expect(refreshUsage).toHaveBeenCalledTimes(1);
  });

  // Spawns at boot arrive together. The second must wait for the read the first queued, or it
  // ranks on the expired reading the read is about to replace.
  it('holds a second caller until the read the first one queued has finished', async () => {
    const accounts = [account('stale', 'a', null)];
    const { refresher, refreshUsage } = rig(accounts);
    let finishRead: () => void = () => undefined;
    refreshUsage.mockImplementation(() => new Promise((resolve) => { finishRead = () => resolve(true); }));
    let firstDone = false;
    let secondDone = false;
    void refresher.readBeforeRanking(accounts).then(() => { firstDone = true; });
    void refresher.readBeforeRanking(accounts).then(() => { secondDone = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);
    finishRead();
    await vi.advanceTimersByTimeAsync(0);
    expect(firstDone && secondDone).toBe(true);
    expect(refreshUsage).toHaveBeenCalledTimes(1);
  });

  it('resolves at its bound when the read hangs, and warns', async () => {
    const accounts = [account('stale', 'a', null)];
    const { refresher, refreshUsage } = rig(accounts);
    refreshUsage.mockImplementation(() => new Promise(() => undefined));
    let resolved = false;
    void refresher.readBeforeRanking(accounts, 5000).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ranking on the stored readings'));
  });

  it('asks an account again once the minute has passed, and not before', async () => {
    const accounts = [account('stale', 'a', null)];
    let clockMs = NOW_MS;
    const { refresher, refreshUsage } = rig(accounts, { now: () => clockMs });
    await refresher.readBeforeRanking(accounts);
    expect(refreshUsage).toHaveBeenCalledTimes(1);

    clockMs = NOW_MS + 59_000;
    await refresher.readBeforeRanking(accounts);
    expect(refreshUsage).toHaveBeenCalledTimes(1);

    clockMs = NOW_MS + 61_000;
    await refresher.readBeforeRanking(accounts);
    expect(refreshUsage).toHaveBeenCalledTimes(2);
  });

  // The serial queue runs Y's read first here, with the unrelated read of X queued behind it. A
  // wait on the whole queue would hold this spawn until X finished.
  it('waits only on the reads of the stale accounts it was given, not on unrelated queued work', async () => {
    const stale = account('stale', 'a', null);
    const unrelated = account('unrelated', 'b', null);
    const { refresher, refreshUsage } = rig([stale, unrelated]);
    let releaseUnrelated: () => void = () => undefined;
    refreshUsage.mockImplementation(async (accountId: string) => {
      if (accountId === 'unrelated') await new Promise<void>((resolve) => { releaseUnrelated = resolve; });
      return true;
    });
    let ranked = false;
    void refresher.readBeforeRanking([stale]).then(() => { ranked = true; });
    void refresher.refreshAccount('unrelated');
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshUsage.mock.calls.map(([accountId]) => accountId)).toEqual(['stale', 'unrelated']);
    expect(ranked).toBe(true);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('ranking on the stored readings'));
    releaseUnrelated();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('resolves at once when every stale account was asked within the minute and its read is done, even with other reads queued', async () => {
    const stale = account('stale', 'a', null);
    const unrelated = account('unrelated', 'b', null);
    const { refresher, refreshUsage } = rig([stale, unrelated]);
    await refresher.readBeforeRanking([stale]);
    let releaseUnrelated: () => void = () => undefined;
    refreshUsage.mockImplementation(async (accountId: string) => {
      if (accountId === 'unrelated') await new Promise<void>((resolve) => { releaseUnrelated = resolve; });
      return true;
    });
    void refresher.refreshAccount('unrelated');
    let ranked = false;
    void refresher.readBeforeRanking([stale]).then(() => { ranked = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(ranked).toBe(true);
    releaseUnrelated();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('never rejects and keeps the queue alive when the account list throws inside a queued read', async () => {
    const stale = account('stale', 'a', null);
    const other = account('other', 'a', null);
    const failureReporter = { report: vi.fn() };
    const listAccounts = vi.fn(() => [stale, other]);
    listAccounts.mockImplementationOnce(() => { throw new Error('database closed'); });
    const { refresher, refreshUsage } = rig([stale, other], { listAccounts, failureReporter });

    await expect(refresher.readBeforeRanking([stale])).resolves.toBeUndefined();
    expect(refreshUsage).not.toHaveBeenCalled();
    expect(failureReporter.report).toHaveBeenCalledWith(expect.any(Error), { tags: { stage: 'usage_read' } });

    await refresher.refreshAccount('other', true);
    expect(refreshUsage).toHaveBeenCalledWith('other');
  });
});

describe('AccountUsageRefresher failure reports', () => {
  it('reports a sign-in read that rejects, and still reads that account usage', async () => {
    const failureReporter = { report: vi.fn() };
    const { refresher, refreshIdentity, refreshUsage } = rig(
      [account('one', 'multi', null), account('two', 'multi', null)],
      { failureReporter },
    );
    refreshIdentity.mockRejectedValueOnce(new Error('identify defect'));
    await expect(refresher.refreshAll('startup')).resolves.toBeUndefined();
    expect(failureReporter.report).toHaveBeenCalledTimes(1);
    expect(failureReporter.report).toHaveBeenCalledWith(expect.any(Error), { tags: { stage: 'sign_in_read' } });
    expect(refreshUsage.mock.calls.map(([accountId]) => accountId)).toEqual(['one', 'two']);
  });

  it('reads each sign-in once when two startup passes overlap', async () => {
    const { refresher, refreshIdentity } = rig([account('one', 'multi', null), account('two', 'multi', null)]);
    await Promise.all([refresher.refreshAll('startup'), refresher.refreshAll('startup')]);
    expect(refreshIdentity.mock.calls.map(([accountId]) => accountId)).toEqual(['one', 'two']);
  });

  it('reports a usage read that throws a plain Error, and runs the next queued read', async () => {
    const failureReporter = { report: vi.fn() };
    const { refresher, refreshUsage } = rig([account('one', 'a', null), account('two', 'a', null)], { failureReporter });
    refreshUsage.mockRejectedValueOnce(new Error('usage defect'));
    await Promise.all([refresher.refreshAccount('one'), refresher.refreshAccount('two')]);
    expect(failureReporter.report).toHaveBeenCalledTimes(1);
    expect(failureReporter.report).toHaveBeenCalledWith(expect.any(Error), { tags: { stage: 'usage_read' } });
    expect(refreshUsage.mock.calls.map(([accountId]) => accountId)).toEqual(['one', 'two']);
  });
});

describe('AccountUsageRefresher.checkHome', () => {
  it('runs the cheap check once, behind a read already queued', async () => {
    const { refresher, checkHomeIdentity, refreshIdentity, reads } = rig([account('one', 'multi', null), account('two', 'multi', null)]);
    const usage = refresher.refreshAccount('one');
    await refresher.checkHome('two');
    await usage;
    expect(checkHomeIdentity).toHaveBeenCalledTimes(1);
    expect(checkHomeIdentity).toHaveBeenCalledWith('two');
    expect(refreshIdentity).not.toHaveBeenCalled();
    expect(reads).toEqual(['usage:one', 'home:two']);
  });

  it('adds no second check while one is queued for the same account', async () => {
    const { refresher, checkHomeIdentity } = rig([account('one', 'multi', null)]);
    await Promise.all([refresher.checkHome('one'), refresher.checkHome('one')]);
    expect(checkHomeIdentity).toHaveBeenCalledTimes(1);
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
