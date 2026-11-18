/**
 * The keep-alive pass for board sign-ins (src/main/boards/sign-in-keep-alive.ts)
 * and the rule for when a sign-in is due (shared/sign-in-renewal.ts).
 *
 * What a user loses without each case: a provider's refresh token lapses when
 * nothing renews it (Linear's 30 days after the last refresh), so a user who
 * opened Kangentic daily and imported monthly was signed out. A pass that
 * stopped at the first failing provider would leave the rest to lapse, one that
 * swallowed a defect would hide it, and one that reported a provider's outage
 * would raise an issue nobody can fix. A timer left armed after shutdown fires
 * into a closing app.
 *
 * Each adapter's own renewal is tested with its client (linear-client,
 * jira-oauth, gitlab-adapter). This file runs the pass over stand-in adapters.
 *
 * Tier: Unit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardAdapter } from '../../src/main/boards/shared';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

vi.mock('electron', async () => {
  const { createFakeSafeStorage } = await import('./helpers/fake-safe-storage');
  return {
    app: { isReady: () => true, whenReady: () => Promise.resolve() },
    safeStorage: createFakeSafeStorage({ isAsyncEncryptionAvailable: () => false }),
  };
});

vi.mock('which', () => ({
  default: async () => {
    throw new Error('not found in test');
  },
}));

vi.mock('../../src/main/analytics/usage', () => ({ trackFeatureUsed: vi.fn() }));

const {
  KEEP_ALIVE_FIRST_PASS_DELAY_MS,
  KEEP_ALIVE_PASS_INTERVAL_MS,
  resetSignInKeepAliveForTests,
  runSignInKeepAlivePass,
  signInKeepAlive,
} = await import('../../src/main/boards/sign-in-keep-alive');
const { SIGN_IN_RENEWAL_AFTER_MS, isSignInRenewalDue } = await import('../../src/main/boards/shared/sign-in-renewal');
const { boardRegistry } = await import('../../src/main/boards/board-registry');
const { LinearError } = await import('../../src/main/boards/adapters/linear/linear-error');

/** The least of an adapter the pass reads: its id and, when it has one, its renewal. */
function adapterNamed(id: string, keepSignInAlive?: () => Promise<void>): BoardAdapter {
  return { id, keepSignInAlive } as unknown as BoardAdapter;
}

beforeEach(() => {
  reportHandledError.mockClear();
  resetSignInKeepAliveForTests();
});

afterEach(() => {
  resetSignInKeepAliveForTests();
  vi.useRealTimers();
});

describe('isSignInRenewalDue', () => {
  const savedAt = '2026-11-01T00:00:00.000Z';
  const savedAtMs = Date.parse(savedAt);

  it('is due at seven days and not a moment before', () => {
    expect(isSignInRenewalDue(savedAt, savedAtMs + SIGN_IN_RENEWAL_AFTER_MS - 1)).toBe(false);
    expect(isSignInRenewalDue(savedAt, savedAtMs + SIGN_IN_RENEWAL_AFTER_MS)).toBe(true);
    expect(SIGN_IN_RENEWAL_AFTER_MS).toBe(7 * 24 * 60 * 60_000);
  });

  it('is due when the save time does not parse, since the age is unknown', () => {
    expect(isSignInRenewalDue('', savedAtMs)).toBe(true);
    expect(isSignInRenewalDue('not a date', savedAtMs)).toBe(true);
  });
});

describe('runSignInKeepAlivePass', () => {
  it('asks every adapter that has a renewal, in order, and skips the rest', async () => {
    const asked: string[] = [];
    await runSignInKeepAlivePass([
      adapterNamed('linear', async () => { asked.push('linear'); }),
      adapterNamed('trello'),
      adapterNamed('jira', async () => { asked.push('jira'); }),
    ]);
    expect(asked).toEqual(['linear', 'jira']);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('goes on to the next provider after one fails, and reports the defect with the provider as its only tag of its own', async () => {
    const asked: string[] = [];
    await runSignInKeepAlivePass([
      adapterNamed('linear', async () => { throw new TypeError("Cannot read properties of undefined (reading 'secret')"); }),
      adapterNamed('gitlab', async () => { asked.push('gitlab'); }),
    ]);
    expect(asked).toEqual(['gitlab']);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [sent, tags] = reportHandledError.mock.calls[0] as [Error, Record<string, string>];
    expect(sent.message).toBe('Handled board-sign-in-keep-alive failure: TypeError');
    expect(tags).toEqual({ provider: 'linear', source: 'board-sign-in-keep-alive', error_name: 'TypeError' });
  });

  it('reports nothing for a provider that is down or a network that is gone', async () => {
    await runSignInKeepAlivePass([
      adapterNamed('linear', async () => { throw new LinearError('Linear is busy', 503); }),
      adapterNamed('jira', async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) }); }),
    ]);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('finds a renewal on Linear, Jira and GitLab in the real registry, and on nothing else', () => {
    const renewing = boardRegistry.list().filter((adapter) => adapter.keepSignInAlive).map((adapter) => adapter.id).sort();
    expect(renewing).toEqual(['gitlab', 'jira', 'linear']);
  });
});

describe('signInKeepAlive', () => {
  it('runs the first pass two minutes after start, then once a day, and not after stop', async () => {
    vi.useFakeTimers();
    const pass = vi.spyOn(boardRegistry, 'list').mockReturnValue([]);
    signInKeepAlive.start();
    signInKeepAlive.start();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_FIRST_PASS_DELAY_MS - 1);
    expect(pass).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_PASS_INTERVAL_MS);
    expect(pass).toHaveBeenCalledTimes(2);

    signInKeepAlive.stop();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_PASS_INTERVAL_MS * 3);
    expect(pass).toHaveBeenCalledTimes(2);
    pass.mockRestore();
  });

  it('does not re-arm when it was stopped while a pass was under way', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = adapterNamed('linear', () => gate);
    const pass = vi.spyOn(boardRegistry, 'list').mockReturnValue([slow]);
    signInKeepAlive.start();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_FIRST_PASS_DELAY_MS);
    expect(pass).toHaveBeenCalledTimes(1);
    signInKeepAlive.stop();
    release();
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_PASS_INTERVAL_MS * 2);
    expect(pass).toHaveBeenCalledTimes(1);
    pass.mockRestore();
  });
});
