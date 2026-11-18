/**
 * The Claude adapter's two account reads, through `CLAUDE_ACCOUNT_SUPPORT` with the CLI run
 * stubbed and a real state file in a temp account folder. A failed `claude auth status` used to
 * read as signed out, which parked a working account at the bottom of Automatic for days; it now
 * throws `IdentityReadError` so the service keeps the account's status. An idle usage read that
 * gives no current windows throws `EmptyUsageReadError` naming why, so it is logged and reported
 * instead of kept silently.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmptyUsageReadError, IdentityReadError } from '../../src/main/accounts/account-support';

const runClaudeCli = vi.fn<(cliPath: string, args: readonly string[], timeoutMs: number, extraEnv?: Record<string, string>) => Promise<string>>();
vi.mock('../../src/main/agent/adapters/claude/cli-run', () => ({ runClaudeCli }));

const { CLAUDE_ACCOUNT_SUPPORT } = await import('../../src/main/agent/adapters/claude/accounts');

let accountFolder: string;

function writeState(state: object): void {
  fs.writeFileSync(path.join(accountFolder, '.claude.json'), JSON.stringify(state));
}

function cachedUsage(fetchedAtMs: number, utilization: object): object {
  return { cachedUsageUtilization: { fetchedAtMs, utilization } };
}

const SEVEN_DAY = { utilization: 1, resets_at: '2026-11-19T00:00:00+00:00' };

beforeEach(() => {
  accountFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-reads-'));
  runClaudeCli.mockReset();
  runClaudeCli.mockResolvedValue('');
});

afterEach(() => {
  fs.rmSync(accountFolder, { recursive: true, force: true });
});

describe('CLAUDE_ACCOUNT_SUPPORT.identify', () => {
  it('reads a signed-out home, which exits non-zero with its JSON, as signed out', async () => {
    runClaudeCli.mockRejectedValue(Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ loggedIn: false }) }));
    await expect(CLAUDE_ACCOUNT_SUPPORT.identify('claude', accountFolder)).resolves.toMatchObject({ signedIn: false });
  });

  it('throws run-failed for a run that failed with no answer, as a timeout does', async () => {
    runClaudeCli.mockRejectedValue(Object.assign(new Error('timed out'), { stdout: '' }));
    const failure = await CLAUDE_ACCOUNT_SUPPORT.identify('claude', accountFolder).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdentityReadError);
    expect((failure as IdentityReadError).reason).toBe('run-failed');
  });

  it('throws unreadable for a run that finished with output that is not the answer', async () => {
    runClaudeCli.mockResolvedValue('Updating Claude Code...');
    const failure = await CLAUDE_ACCOUNT_SUPPORT.identify('claude', accountFolder).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdentityReadError);
    expect((failure as IdentityReadError).reason).toBe('unreadable');
  });

  it('reads a signed-in answer with the plan name the state file keeps', async () => {
    runClaudeCli.mockResolvedValue(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'dev@example.com', planTier: 'max_20x' }));
    writeState({ oauthAccount: { planDisplayName: 'Ultra' } });
    await expect(CLAUDE_ACCOUNT_SUPPORT.identify('claude', accountFolder)).resolves.toEqual({
      signedIn: true, email: 'dev@example.com', plan: 'Ultra', hasSubscription: true,
    });
  });
});

describe('CLAUDE_ACCOUNT_SUPPORT.readIdleUsage', () => {
  async function emptyReason(): Promise<string | null> {
    const failure = await CLAUDE_ACCOUNT_SUPPORT.readIdleUsage!('claude', accountFolder).catch((error: unknown) => error);
    return failure instanceof EmptyUsageReadError ? failure.reason : null;
  }

  it('returns the windows of a cache the run just refreshed', async () => {
    writeState(cachedUsage(Date.now(), { seven_day: SEVEN_DAY, five_hour: null }));
    const windows = await CLAUDE_ACCOUNT_SUPPORT.readIdleUsage!('claude', accountFolder);
    expect(windows?.map((window) => window.id)).toEqual(['seven-day']);
  });

  it('names a failed run', async () => {
    runClaudeCli.mockRejectedValue(new Error('timed out'));
    writeState(cachedUsage(Date.now(), { seven_day: SEVEN_DAY }));
    expect(await emptyReason()).toBe('run-failed');
  });

  it('names a missing state file and one with no cache', async () => {
    expect(await emptyReason()).toBe('cache-missing');
    writeState({ oauthAccount: {} });
    expect(await emptyReason()).toBe('cache-missing');
  });

  it('names a cache the run did not refresh', async () => {
    writeState(cachedUsage(Date.now() - 60 * 60 * 1000, { seven_day: SEVEN_DAY }));
    expect(await emptyReason()).toBe('cache-stale');
  });

  it('names a fresh cache with no window in it, which used to replace good windows with none', async () => {
    writeState(cachedUsage(Date.now(), { seven_day: null, five_hour: null }));
    expect(await emptyReason()).toBe('no-windows');
  });
});
