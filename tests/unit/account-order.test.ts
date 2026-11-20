import { describe, expect, it } from 'vitest';
import {
  automaticOrder,
  firstReset,
  hasRoom,
  isNearFull,
  keepFullWindows,
  nextAccountWithRoom,
  SAME_WINDOW_SLACK_SECONDS,
  topAccountWithRoom,
} from '../../src/main/accounts/account-order';
import type { AgentAccount } from '../../src/shared/agent-accounts';
import type { RateLimitWindow } from '../../src/shared/types';

const NOW = 1_800_000_000;

function window(id: 'five-hour' | 'seven-day', used: number, resetsInSeconds: number): RateLimitWindow {
  return {
    id,
    label: id === 'five-hour' ? '5h session' : '7d weekly',
    iconKind: id === 'five-hour' ? 'session' : 'period',
    usedPercentage: used,
    resetsAt: NOW + resetsInSeconds,
    windowDurationSeconds: id === 'five-hour' ? 18_000 : 604_800,
  };
}

function account(id: string, position: number, usage: RateLimitWindow[] | null, status: AgentAccount['status'] = 'ok'): AgentAccount {
  return {
    id,
    agent: 'claude',
    kind: 'folder',
    folderPath: null,
    keyFilePath: null,
    keyNames: [],
    email: `${id}@example.com`,
    plan: 'Ultra',
    status,
    position,
    historyPrivate: false,
    lastUsage: usage,
    lastUsageAt: null,
    createdAt: '2026-11-09T00:00:00.000Z',
  };
}

describe('automaticOrder', () => {
  it('puts the account whose longest window resets soonest first', () => {
    const accounts = [
      account('dev', 1, [window('five-hour', 81, 3_600), window('seven-day', 93, 5 * 86_400)]),
      account('work', 2, [window('seven-day', 42, 2 * 86_400)]),
      account('side', 3, [window('five-hour', 12, 600), window('seven-day', 29, 6 * 86_400)]),
    ];
    expect(automaticOrder(accounts, NOW).map((entry) => entry.id)).toEqual(['work', 'dev', 'side']);
  });

  it('keeps accounts with no reading after those with one, and skipped accounts last', () => {
    const accounts = [
      account('fresh', 1, null),
      account('gone', 2, [window('seven-day', 10, 86_400)], 'signed-out'),
      account('read', 3, [window('seven-day', 10, 86_400)]),
    ];
    expect(automaticOrder(accounts, NOW).map((entry) => entry.id)).toEqual(['read', 'fresh', 'gone']);
  });
});

describe('room', () => {
  it('has no room at 100% until that window resets', () => {
    const full = account('full', 1, [window('seven-day', 100, 3_600)]);
    expect(hasRoom(full, NOW)).toBe(false);
    expect(hasRoom(full, NOW + 3_601)).toBe(true);
  });

  it('starts new sessions on the top account with room', () => {
    const ordered = [account('full', 1, [window('five-hour', 100, 600)]), account('next', 2, null)];
    expect(topAccountWithRoom(ordered, NOW)?.id).toBe('next');
  });

  it('continues on the next account down, then wraps, never the same one', () => {
    const ordered = [account('a', 1, null), account('b', 2, [window('seven-day', 100, 600)]), account('c', 3, null)];
    expect(nextAccountWithRoom(ordered, 'a', NOW)?.id).toBe('c');
    expect(nextAccountWithRoom(ordered, 'c', NOW)?.id).toBe('a');
    expect(nextAccountWithRoom([account('only', 1, null)], 'only', NOW)).toBeNull();
  });

  it('names the soonest reset that frees an account when all are full', () => {
    const ordered = [
      account('a', 1, [window('five-hour', 100, 7_200)]),
      account('b', 2, [window('five-hour', 100, 600), window('seven-day', 100, 3_000)]),
    ];
    expect(firstReset(ordered, NOW)).toEqual({ account: ordered[1], resetsAt: NOW + 3_000 });
  });
});

describe('isNearFull', () => {
  it('is true from 95% up and false below it', () => {
    expect(isNearFull(account('a', 1, [window('seven-day', 94, 3_600)]), NOW)).toBe(false);
    expect(isNearFull(account('a', 1, [window('seven-day', 95, 3_600)]), NOW)).toBe(true);
  });

  it('ignores a window whose reset already passed, and counts one with no reset time', () => {
    expect(isNearFull(account('a', 1, [window('seven-day', 99, -60)]), NOW)).toBe(false);
    const noReset = { ...window('seven-day', 99, 0), resetsAt: 0 };
    expect(isNearFull(account('a', 1, [noReset]), NOW)).toBe(true);
  });
});

// Task #1147: Claude's status line read 99 for a weekly window its cache read 100 and spent.
describe('keepFullWindows', () => {
  const full = window('seven-day', 100, 2 * 86_400);

  it('keeps a full window against a lower report of the same window', () => {
    expect(keepFullWindows([full], [{ ...full, usedPercentage: 99 }], NOW)).toEqual([full]);
    // A source that rounds the reset differently still names the same window.
    const roundedLater = { ...full, usedPercentage: 99, resetsAt: full.resetsAt + SAME_WINDOW_SLACK_SECONDS };
    expect(keepFullWindows([full], [roundedLater], NOW)).toEqual([full]);
    const kept = [account('spent', 1, keepFullWindows([full], [{ ...full, usedPercentage: 99 }], NOW)), account('other', 2, [window('seven-day', 40, 86_400)])];
    expect(hasRoom(kept[0], NOW)).toBe(false);
    expect(topAccountWithRoom(kept, NOW)?.id).toBe('other');
  });

  it('takes a report of the next window, and any report once the full window has reset', () => {
    const nextWindow = { ...full, usedPercentage: 2, resetsAt: full.resetsAt + 604_800 };
    expect(keepFullWindows([full], [nextWindow], NOW)).toEqual([nextWindow]);
    const afterReset = full.resetsAt + 1;
    expect(keepFullWindows([full], [{ ...full, usedPercentage: 5 }], afterReset)).toEqual([{ ...full, usedPercentage: 5 }]);
  });

  it('never holds a window with no reset time, and leaves other windows and higher reports alone', () => {
    const noReset = { ...full, resetsAt: 0 };
    expect(keepFullWindows([noReset], [{ ...noReset, usedPercentage: 50 }], NOW)).toEqual([{ ...noReset, usedPercentage: 50 }]);
    const fiveHour = window('five-hour', 30, 600);
    expect(keepFullWindows([full], [fiveHour], NOW)).toEqual([fiveHour]);
    expect(keepFullWindows([window('seven-day', 80, 86_400)], [{ ...full, usedPercentage: 60 }], NOW)).toEqual([{ ...full, usedPercentage: 60 }]);
  });
});
