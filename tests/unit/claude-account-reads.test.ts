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
  vi.restoreAllMocks();
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
      signedIn: true, email: 'dev@example.com', orgId: null, plan: 'Ultra', hasSubscription: true,
    });
  });
});

// The file the login watch holds per home. macOS keeps the login in the Keychain: nothing to watch.
describe('CLAUDE_ACCOUNT_SUPPORT.loginFiles', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  function stubPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  });

  it.each(['win32', 'linux'] as const)('names .credentials.json in an account folder on %s', (platform) => {
    stubPlatform(platform);
    expect(CLAUDE_ACCOUNT_SUPPORT.loginFiles!(accountFolder)).toEqual([path.join(accountFolder, '.credentials.json')]);
  });

  it('names .credentials.json in Claude\'s own home for the default login', () => {
    stubPlatform('linux');
    process.env.CLAUDE_CONFIG_DIR = accountFolder;
    expect(CLAUDE_ACCOUNT_SUPPORT.loginFiles!(null)).toEqual([path.join(path.resolve(accountFolder), '.credentials.json')]);
  });

  it('names nothing on macOS, for an account folder or the default login', () => {
    stubPlatform('darwin');
    expect(CLAUDE_ACCOUNT_SUPPORT.loginFiles!(accountFolder)).toEqual([]);
    expect(CLAUDE_ACCOUNT_SUPPORT.loginFiles!(null)).toEqual([]);
  });
});

// The cheap read a turn end and the login file watch run: the home's state file, no CLI.
describe('CLAUDE_ACCOUNT_SUPPORT.readHomeIdentity', () => {
  it('reads the login the state file records, with no CLI run', async () => {
    writeState({ oauthAccount: { emailAddress: 'dev@example.com', organizationUuid: 'org-a', planDisplayName: 'Ultra' } });
    await expect(CLAUDE_ACCOUNT_SUPPORT.readHomeIdentity!(accountFolder)).resolves.toEqual({ email: 'dev@example.com', orgId: 'org-a' });
    expect(runClaudeCli).not.toHaveBeenCalled();
  });

  // No answer is never a change of login: a home mid-write or signed out reads as nothing.
  it.each([
    ['no state file', null],
    ['no login recorded', {}],
    ['a login with no email', { oauthAccount: { organizationUuid: 'org-a' } }],
  ])('gives no answer for %s', async (_case, state) => {
    if (state) writeState(state);
    await expect(CLAUDE_ACCOUNT_SUPPORT.readHomeIdentity!(accountFolder)).resolves.toBeNull();
  });

  // Replays the key set of a real Claude Code state file, not a shape written by hand.
  it('reads the login out of a real-shape state file', async () => {
    fs.copyFileSync(
      path.join(__dirname, '..', 'fixtures', 'claude-state-oauth-account.json'),
      path.join(accountFolder, '.claude.json'),
    );
    await expect(CLAUDE_ACCOUNT_SUPPORT.readHomeIdentity!(accountFolder)).resolves.toEqual({
      email: 'dev@example.com',
      orgId: '00000000-0000-0000-0000-000000000002',
    });
  });

  // The read parses again only when the file's size or time changed.
  it('re-parses a changed file and serves the cache for one with the same size and time', async () => {
    const statePath = path.join(accountFolder, '.claude.json');
    const stateFor = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: 'org-a' } });
    const firstTime = new Date('2026-01-01T00:00:00.000Z');
    const secondTime = new Date('2026-01-02T00:00:00.000Z');

    fs.writeFileSync(statePath, stateFor('first@example.com'));
    fs.utimesSync(statePath, firstTime, firstTime);
    await expect(CLAUDE_ACCOUNT_SUPPORT.readHomeIdentity!(accountFolder)).resolves.toEqual({ email: 'first@example.com', orgId: 'org-a' });

    fs.writeFileSync(statePath, stateFor('other1@example.com'));
    fs.utimesSync(statePath, secondTime, secondTime);
    await expect(CLAUDE_ACCOUNT_SUPPORT.readHomeIdentity!(accountFolder)).resolves.toEqual({ email: 'other1@example.com', orgId: 'org-a' });

    const unchangedStat = fs.statSync(statePath);
    fs.writeFileSync(statePath, stateFor('other2@example.com'));
    fs.utimesSync(statePath, unchangedStat.atime, unchangedStat.mtime);
    expect(fs.statSync(statePath).size).toBe(unchangedStat.size);
    await expect(CLAUDE_ACCOUNT_SUPPORT.readHomeIdentity!(accountFolder)).resolves.toEqual({ email: 'other1@example.com', orgId: 'org-a' });
  });

  it('gives no answer for a state file caught mid-write', async () => {
    fs.writeFileSync(path.join(accountFolder, '.claude.json'), '{"oauthAccount": {"emailAdd');
    await expect(CLAUDE_ACCOUNT_SUPPORT.readHomeIdentity!(accountFolder)).resolves.toBeNull();
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

  // Sentry DESKTOP-4E: the run's own failure was dropped here, so the report could not tell a
  // timeout from an exit or a CLI that would not start.
  it.each([
    ['a run stopped at its timeout', { killed: true, signal: 'SIGTERM' }, { kind: 'timeout', exitCode: null }],
    ['a run that exited non-zero', { code: 1, killed: false, signal: null }, { kind: 'exit_code', exitCode: 1 }],
    ['a CLI that would not start', { code: 'ENOENT' }, { kind: 'spawn_error', exitCode: null }],
  ])('hands on %s with how it ended and the error it caught', async (_label, shape, runFailure) => {
    const rejection = Object.assign(new Error('Command failed: claude -p /usage'), shape);
    runClaudeCli.mockRejectedValue(rejection);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const failure = await CLAUDE_ACCOUNT_SUPPORT.readIdleUsage!('claude', accountFolder).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmptyUsageReadError);
    expect((failure as EmptyUsageReadError).reason).toBe('run-failed');
    expect((failure as EmptyUsageReadError).runFailure).toEqual(runFailure);
    expect((failure as EmptyUsageReadError).cause).toBe(rejection);
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
