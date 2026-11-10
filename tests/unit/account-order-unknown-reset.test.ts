import { describe, expect, it } from 'vitest';
import {
  firstReset,
  hasRoom,
  nextAccountWithRoom,
  orderingReset,
  topAccountWithRoom,
} from '../../src/main/accounts/account-order';
import type { AgentAccount } from '../../src/shared/agent-accounts';
import type { RateLimitWindow } from '../../src/shared/types';

const NOW = 1_800_000_000;

function window(usedPercentage: number, resetsAt: number, windowDurationSeconds = 604_800): RateLimitWindow {
  return { id: `w-${resetsAt}-${usedPercentage}`, label: 'window', iconKind: 'period', usedPercentage, resetsAt, windowDurationSeconds };
}

function account(id: string, position: number, lastUsage: RateLimitWindow[] | null): AgentAccount {
  return {
    id, agent: 'test-agent', kind: position === 1 ? 'default' : 'folder', folderPath: null, keyFilePath: null, keyNames: [],
    email: `${id}@example.com`, plan: 'Pro', status: 'ok', position, historyPrivate: false,
    lastUsage, lastUsageAt: null, createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('a window with no reset time', () => {
  const unknownReset = account('unknown', 1, [window(100, 0)]);
  const free = account('free', 2, [window(10, NOW + 3600)]);

  it('keeps an account full, since nothing says when it frees', () => {
    expect(hasRoom(unknownReset, NOW)).toBe(false);
  });

  it('is never picked as the account with room', () => {
    expect(topAccountWithRoom([unknownReset], NOW)).toBeNull();
    expect(topAccountWithRoom([unknownReset, free], NOW)?.id).toBe('free');
    expect(nextAccountWithRoom([free, unknownReset], 'free', NOW)).toBeNull();
    expect(nextAccountWithRoom([unknownReset, free], 'free', NOW)).toBeNull();
  });

  it('names no first reset for an account whose only full window has no reset', () => {
    expect(firstReset([unknownReset], NOW)).toBeNull();
    const dated = account('dated', 3, [window(100, NOW + 600)]);
    expect(firstReset([unknownReset, dated], NOW)).toEqual({ account: dated, resetsAt: NOW + 600 });
  });

  it('is ignored when ordering by reset', () => {
    expect(orderingReset(unknownReset, NOW)).toBeNull();
    const mixed = account('mixed', 4, [window(20, 0, 2_592_000), window(30, NOW + 7200, 18_000)]);
    expect(orderingReset(mixed, NOW)).toBe(NOW + 7200);
  });
});

describe('a window whose reset has passed', () => {
  it('no longer counts', () => {
    const lapsed = account('lapsed', 1, [window(100, NOW - 1)]);
    expect(hasRoom(lapsed, NOW)).toBe(true);
    expect(orderingReset(lapsed, NOW)).toBeNull();
    expect(firstReset([lapsed], NOW)).toBeNull();
    expect(topAccountWithRoom([lapsed], NOW)?.id).toBe('lapsed');
  });

  it('still counts one second before the reset', () => {
    expect(hasRoom(account('soon', 1, [window(100, NOW + 1)]), NOW)).toBe(false);
  });
});
