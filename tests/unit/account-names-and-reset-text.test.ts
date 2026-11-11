/**
 * Agent accounts, renderer side: the names an account goes by and the reset text a usage window
 * and the "all accounts full" toast print.
 *
 * Pins `accountDisplayName`, `rateLimitWindowKey`, `accountNameFor`, `formatResetMoment`,
 * `formatResetTime`, `describeAccountSwitched` and `describeAccountsAllFull`. Every one runs the
 * real function. Tier: Unit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@lingui/core';
import {
  accountDisplayName,
  rateLimitWindowKey,
  type AgentAccount,
  type AgentAccountsCard,
} from '../../src/shared/agent-accounts';
import { __setLocaleForTests } from '../../src/renderer/lib/datetime';
import { accountNameFor } from '../../src/renderer/stores/accounts-store';
import { describeAccountSwitched, describeAccountsAllFull } from '../../src/renderer/lib/account-toasts';
import { formatResetMoment, formatResetTime } from '../../src/renderer/components/terminal/rate-limit-meter';

const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime();
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function epochSeconds(offsetMs: number): number {
  return Math.round((NOW + offsetMs) / 1000);
}

function makeAccount(id: string, overrides: Partial<AgentAccount> = {}): AgentAccount {
  return {
    id,
    agent: 'claude',
    kind: 'folder',
    folderPath: null,
    keyFilePath: null,
    keyNames: [],
    email: null,
    plan: null,
    status: 'ok',
    position: 1,
    historyPrivate: false,
    lastUsage: null,
    lastUsageAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeCard(accounts: AgentAccount[]): AgentAccountsCard {
  return {
    agent: 'claude',
    kind: 'folder',
    accounts,
    activeAccountId: null,
    reportsUsage: true,
    usageWindows: [],
    signInIsInteractive: false,
    switchMovesSessions: true,
    overrides: [],
    unsupportedTarget: false,
  };
}

beforeEach(() => {
  i18n.activate('en');
  __setLocaleForTests('en-US');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('accountDisplayName', () => {
  it('prefers the email over a key file', () => {
    expect(accountDisplayName({ email: 'dev@example.com', keyFilePath: '/keys/work.env' })).toBe('dev@example.com');
  });

  it('falls back to the key file base name for a POSIX path', () => {
    expect(accountDisplayName({ email: null, keyFilePath: '/keys/work.env' })).toBe('work.env');
  });

  it('falls back to the key file base name for a Windows path', () => {
    expect(accountDisplayName({ email: null, keyFilePath: 'C:\\Users\\dev\\keys\\work.env' })).toBe('work.env');
  });

  it('is null with neither an email nor a key file', () => {
    expect(accountDisplayName({ email: null, keyFilePath: null })).toBeNull();
  });
});

describe('rateLimitWindowKey', () => {
  it('scopes the window id by its account', () => {
    expect(rateLimitWindowKey({ id: 'five-hour', accountId: 'account-1' })).toBe('account-1:five-hour');
  });

  it('is the bare id without an account, so two accounts never share a key', () => {
    expect(rateLimitWindowKey({ id: 'five-hour' })).toBe('five-hour');
    expect(rateLimitWindowKey({ id: 'five-hour', accountId: 'account-1' }))
      .not.toBe(rateLimitWindowKey({ id: 'five-hour', accountId: 'account-2' }));
  });
});

describe('accountNameFor', () => {
  const one = makeAccount('one', { email: 'one@example.com' });
  const two = makeAccount('two', { email: 'two@example.com' });

  it('is null for an unknown account id and for no id', () => {
    expect(accountNameFor([makeCard([one, two])], 'missing')).toBeNull();
    expect(accountNameFor([makeCard([one, two])], null)).toBeNull();
  });

  it('is null when the agent has only that one account', () => {
    expect(accountNameFor([makeCard([one])], 'one')).toBeNull();
  });

  it('is the display name when the agent has two accounts', () => {
    expect(accountNameFor([makeCard([one, two])], 'two')).toBe('two@example.com');
  });
});

describe('formatResetMoment', () => {
  it('reads "now" at the reset time and after it', () => {
    const atReset = formatResetMoment(epochSeconds(0), NOW);
    expect(formatResetMoment(epochSeconds(-HOUR_MS), NOW)).toBe(atReset);
    expect(atReset).toBe('now');
  });

  it('counts whole minutes under an hour, with a floor of 1', () => {
    expect(formatResetMoment(epochSeconds(10 * MINUTE_MS), NOW)).toBe('10m');
    expect(formatResetMoment(epochSeconds(20 * SECOND_MS), NOW)).toBe('1m');
  });

  it('reads 59 at 59 minutes 31 seconds, never 60', () => {
    expect(formatResetMoment(epochSeconds(59 * MINUTE_MS + 31 * SECOND_MS), NOW)).toBe('59m');
  });

  it('reads hours and minutes from an hour up to a day', () => {
    expect(formatResetMoment(epochSeconds(2 * HOUR_MS + 10 * MINUTE_MS), NOW)).toBe('2h 10m');
  });

  it('counts days and whole hours from a day up, never a date (task #1064)', () => {
    expect(formatResetMoment(epochSeconds(DAY_MS + 4 * HOUR_MS + 30 * MINUTE_MS), NOW)).toBe('1d 4h');
    expect(formatResetMoment(epochSeconds(3 * DAY_MS), NOW)).toBe('3d');
    expect(formatResetMoment(epochSeconds(6 * DAY_MS + 15 * HOUR_MS), NOW)).not.toContain('Nov');
  });

  it('reads 23h 59m just under a day, and 1d from a day', () => {
    expect(formatResetMoment(epochSeconds(DAY_MS - MINUTE_MS), NOW)).toBe('23h 59m');
    expect(formatResetMoment(epochSeconds(DAY_MS), NOW)).toBe('1d');
  });

  it('reads 23h 59m at 23h 59m 59.6s, never 24h 0m', () => {
    // A fractional epoch: the reset is 400 ms short of a day, which rounding to the second would call 24h 0m.
    const justUnderADay = (NOW + DAY_MS - 400) / 1000;
    expect(formatResetMoment(justUnderADay, NOW)).toBe('23h 59m');
  });
});

describe('formatResetTime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  it('is empty for a window with no reset time, never the "now" text', () => {
    expect(formatResetTime(0)).toBe('');
    expect(formatResetTime(0)).not.toBe(formatResetTime(epochSeconds(-HOUR_MS)));
  });

  it('says "Resets now" for a past time', () => {
    expect(formatResetTime(epochSeconds(-HOUR_MS))).toBe('Resets now');
  });

  it('carries the duration under a day', () => {
    expect(formatResetTime(epochSeconds(2 * HOUR_MS + 10 * MINUTE_MS))).toBe('Resets in 2h 10m');
  });

  it('carries the date from a day up', () => {
    const text = formatResetTime(epochSeconds(3 * DAY_MS));
    expect(text.startsWith('Resets ')).toBe(true);
    expect(text).toContain('Nov');
    expect(text).not.toContain('Resets in');
  });
});

describe('describeAccountSwitched', () => {
  const base = { projectId: 'project-1', taskId: 'task-1', agent: 'claude', accountName: 'two@example.com' };

  it('names the task and the account when the task has a title', () => {
    const toast = describeAccountSwitched(base, 'Fix login');
    expect(toast.message).toContain('Fix login');
    expect(toast.message).toContain('two@example.com');
  });

  it('names only the account without a title', () => {
    const toast = describeAccountSwitched(base, null);
    expect(toast.message).toContain('two@example.com');
    expect(toast.message).not.toContain('Fix login');
  });

  it('falls back to the agent name when the account has no name', () => {
    const toast = describeAccountSwitched({ ...base, accountName: null }, null);
    expect(toast.message).toContain('Claude');
    expect(toast.message).not.toContain('null');
  });
});

describe('describeAccountsAllFull', () => {
  const agentFull = (resetsAt: number | null) => ({ agent: 'claude', resetsAt });

  it('says the sessions wait for the first reset when none is known', () => {
    const toast = describeAccountsAllFull(agentFull(null), NOW);
    expect(toast.message).toContain('Claude');
    expect(toast.message).not.toMatch(/\dh|\dm/u);
  });

  it('reads the same for a reset already past', () => {
    expect(describeAccountsAllFull(agentFull(epochSeconds(-HOUR_MS)), NOW).message)
      .toBe(describeAccountsAllFull(agentFull(null), NOW).message);
  });

  it('carries the duration under a day', () => {
    const toast = describeAccountsAllFull(agentFull(epochSeconds(2 * HOUR_MS + 10 * MINUTE_MS)), NOW);
    expect(toast.message).toContain('2h 10m');
  });

  it('carries the date from a day up', () => {
    const toast = describeAccountsAllFull(agentFull(epochSeconds(3 * DAY_MS)), NOW);
    expect(toast.message).toContain('Nov');
    expect(toast.message).toContain('12');
  });
});
