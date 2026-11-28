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
import { EmptyUsageReadError, IdentityReadError, UnreadableUsageError } from '../../src/main/accounts/account-support';

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

  // Sentry DESKTOP-60: the report could not tell a timeout from an exit or a CLI that would not
  // start, so the error carries the run's rejection and how it ended.
  it('says a run stopped at its timeout timed out, and hands on the rejection', async () => {
    const rejection = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', stdout: '' });
    runClaudeCli.mockRejectedValue(rejection);
    const failure = await CLAUDE_ACCOUNT_SUPPORT.identify('claude', accountFolder).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdentityReadError);
    expect((failure as IdentityReadError).runFailure).toEqual({ kind: 'timeout', exitCode: null });
    expect((failure as IdentityReadError).cause).toBe(rejection);
  });

  it.each([
    ['exited non-zero', Object.assign(new Error('Command failed'), { code: 2, stdout: '' }), { kind: 'exit_code', exitCode: 2 }],
    ['could not start', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', stdout: '' }), { kind: 'spawn_error', exitCode: null }],
  ])('says a run that %s with no answer, and hands on the rejection', async (_label, rejection, expected) => {
    runClaudeCli.mockRejectedValue(rejection);
    const failure = await CLAUDE_ACCOUNT_SUPPORT.identify('claude', accountFolder).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdentityReadError);
    expect((failure as IdentityReadError).runFailure).toEqual(expected);
    expect((failure as IdentityReadError).cause).toBe(rejection);
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
    const reading = await CLAUDE_ACCOUNT_SUPPORT.readIdleUsage!('claude', accountFolder);
    if (!reading || Array.isArray(reading)) throw new Error('expected a reading that names absent windows');
    expect(reading.windows.map((window) => window.id)).toEqual(['seven-day']);
    // `five_hour: null` is a plan with no 5h window, not one it has yet to open.
    expect(reading.absentWindowIds).toEqual(['five-hour']);
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

  // Sentry DESKTOP-4E on 0.62.0: one `cache-missing` covered three states, and the normal one
  // before Claude's first usage fetch reported on every launch. Each now has its own word.
  it('names a missing state file, an unparseable one, one that is not a record, and one with no cache', async () => {
    expect(await emptyReason()).toBe('state-unreadable');
    fs.writeFileSync(path.join(accountFolder, '.claude.json'), '{"cachedUsageUtilization": {"fetchedAt');
    expect(await emptyReason()).toBe('state-unreadable');
    writeState([]);
    expect(await emptyReason()).toBe('state-not-record');
    writeState({ oauthAccount: {} });
    expect(await emptyReason()).toBe('no-cache');
  });

  it('names a cache the run did not refresh', async () => {
    writeState(cachedUsage(Date.now() - 60 * 60 * 1000, { seven_day: SEVEN_DAY }));
    expect(await emptyReason()).toBe('cache-stale');
  });

  // Sentry DESKTOP-4E on 0.62.0 was one stale read, which could not be told from a cache that never
  // refreshes. The bounds are the report's tag, so each side of one is pinned.
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  it.each([
    ['eleven minutes', 11 * MINUTE_MS, 'under_1h'],
    ['a millisecond short of an hour', HOUR_MS - 1, 'under_1h'],
    ['an hour', HOUR_MS, '1h_to_1d'],
    ['a millisecond short of a day', 24 * HOUR_MS - 1, '1h_to_1d'],
    ['a day', 24 * HOUR_MS, 'over_1d'],
    ['a month', 30 * 24 * HOUR_MS, 'over_1d'],
  ])('hands on the age of a stale cache %s old as a fixed word', async (_label, ageMs, cacheAge) => {
    const now = Date.UTC(2026, 10, 23, 19, 18, 35);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    writeState(cachedUsage(now - ageMs, { seven_day: SEVEN_DAY }));

    const failure = await CLAUDE_ACCOUNT_SUPPORT.readIdleUsage!('claude', accountFolder).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmptyUsageReadError);
    expect((failure as EmptyUsageReadError).reason).toBe('cache-stale');
    expect((failure as EmptyUsageReadError).cacheAge).toBe(cacheAge);
  });

  it('names a fresh cache with no window in it, which used to replace good windows with none', async () => {
    writeState(cachedUsage(Date.now(), { seven_day: null, five_hour: null }));
    expect(await emptyReason()).toBe('no-windows');
  });

  // Sentry DESKTOP-4E on 0.61.0: a `no-windows` that could be a plan with every window null, or a
  // Claude Code release that renamed the fields. The second is a shape the adapter does not know.
  it('throws unreadable with the keys it found for a cache that holds none of the known windows', async () => {
    writeState(cachedUsage(Date.now(), { weekly: SEVEN_DAY, limits: [] }));
    const failure = await CLAUDE_ACCOUNT_SUPPORT.readIdleUsage!('claude', accountFolder).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnreadableUsageError);
    expect((failure as UnreadableUsageError).keys).toBe('limits,weekly');
  });

  // Deliberate: an empty record names no window either, so it is a shape the adapter does not know.
  it('throws unreadable with no keys for an empty utilization record', async () => {
    writeState(cachedUsage(Date.now(), {}));
    const failure = await CLAUDE_ACCOUNT_SUPPORT.readIdleUsage!('claude', accountFolder).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnreadableUsageError);
    expect((failure as UnreadableUsageError).keys).toBe('');
  });
});
