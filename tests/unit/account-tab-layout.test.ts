/**
 * Settings > Accounts layout rules (task #1064): which agents get a card of their own, which share
 * More agents, when a list takes a drag, and the usage lines a row draws so every row of an agent
 * is one height. Runs the real helpers. Tier: Unit.
 */
import { describe, expect, it } from 'vitest';
import type { AgentAccount, AgentAccountsCard, AgentUsageWindowShape } from '../../src/shared/agent-accounts';
import type { RateLimitWindow } from '../../src/shared/types';
import {
  accountSwitchingCards,
  hasOwnAccountsCard,
  isAccountOrderEditable,
  partitionAccountCards,
} from '../../src/renderer/utils/account-cards';
import { accountUsageLines, liveRateLimitWindows } from '../../src/renderer/utils/rate-limit-window';

const NOW_MS = Date.UTC(2026, 10, 11, 12, 0, 0);
const NOW_SECONDS = NOW_MS / 1000;

function account(id: string, overrides: Partial<AgentAccount> = {}): AgentAccount {
  return {
    id, agent: 'agent', kind: 'default', folderPath: null, keyFilePath: null, keyNames: [], email: null, plan: null,
    status: 'ok', position: 1, historyPrivate: false, lastUsage: null, lastUsageAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function card(agent: string, overrides: Partial<AgentAccountsCard> = {}): AgentAccountsCard {
  return {
    agent, kind: 'key-file', accounts: [account(`${agent}-own`)], activeAccountId: null, reportsUsage: false, usageWindows: [],
    signInIsInteractive: false, switchMovesSessions: true, overrides: [], unsupportedTarget: false,
    ...overrides,
  };
}

const FIVE_HOUR: AgentUsageWindowShape = { id: 'five-hour', label: '5h session', iconKind: 'session', windowDurationSeconds: 5 * 3600 };
const SEVEN_DAY: AgentUsageWindowShape = { id: 'seven-day', label: '7d weekly', iconKind: 'period', windowDurationSeconds: 7 * 86_400 };

function reading(shape: AgentUsageWindowShape, usedPercentage: number, resetsInSeconds: number): RateLimitWindow {
  return { ...shape, usedPercentage, resetsAt: NOW_SECONDS + resetsInSeconds };
}

describe('partitionAccountCards', () => {
  it('sends an agent with only its own login and nothing to show to More agents', () => {
    const { own, more } = partitionAccountCards([card('cursor'), card('warp')]);
    expect(own).toEqual([]);
    expect(more.map((entry) => entry.agent)).toEqual(['cursor', 'warp']);
  });

  it('keeps a card for each reason it has something of its own, in list order', () => {
    const twoAccounts = card('droid', { accounts: [account('droid-own'), account('droid-key', { kind: 'key-file' })] });
    const usage = card('claude', { kind: 'folder', reportsUsage: true });
    const override = card('aider', { overrides: [{ variable: 'OPENAI_API_KEY', source: 'environment' }] });
    const wsl = card('gemini', { kind: 'folder', unsupportedTarget: true });
    const plain = card('cursor');
    for (const entry of [twoAccounts, usage, override, wsl]) expect(hasOwnAccountsCard(entry)).toBe(true);
    expect(hasOwnAccountsCard(plain)).toBe(false);
    const { own, more } = partitionAccountCards([usage, plain, twoAccounts, override, wsl]);
    expect(own.map((entry) => entry.agent)).toEqual(['claude', 'droid', 'aider', 'gemini']);
    expect(more.map((entry) => entry.agent)).toEqual(['cursor']);
  });
});

describe('accountSwitchingCards and isAccountOrderEditable', () => {
  it('limits the switching settings to agents that report usage and have two accounts', () => {
    const usageTwo = card('claude', { reportsUsage: true, accounts: [account('a'), account('b')] });
    const usageOne = card('codex', { reportsUsage: true });
    const quietTwo = card('droid', { accounts: [account('c'), account('d')] });
    expect(accountSwitchingCards([usageTwo, usageOne, quietTwo]).map((entry) => entry.agent)).toEqual(['claude']);
    // A non-usage agent with two accounts alone shows no switching card.
    expect(accountSwitchingCards([usageOne, quietTwo])).toEqual([]);
  });

  it('takes a drag only where the order is the user\'s, and only with two accounts', () => {
    const usageTwo = card('claude', { reportsUsage: true, accounts: [account('a'), account('b')] });
    const quietTwo = card('droid', { accounts: [account('c'), account('d')] });
    const usageOne = card('claude', { reportsUsage: true });
    // Automatic sorts an agent with usage by reset, so its rows have no grip.
    expect(isAccountOrderEditable(usageTwo, 'automatic')).toBe(false);
    expect(isAccountOrderEditable(usageTwo, 'manual')).toBe(true);
    // With no usage there is no reset to sort by: the list is always in the user's order.
    expect(isAccountOrderEditable(quietTwo, 'automatic')).toBe(true);
    expect(isAccountOrderEditable(usageOne, 'manual')).toBe(false);
  });
});

describe('accountUsageLines', () => {
  it('draws every declared window, an unopened one as not started, in declared order', () => {
    const lines = accountUsageLines([FIVE_HOUR, SEVEN_DAY], [reading(SEVEN_DAY, 40, 3 * 86_400)], true);
    expect(lines.map((line) => line.kind)).toEqual(['not-started', 'live']);
    expect(lines[0]).toEqual({ kind: 'not-started', shape: FIVE_HOUR });
  });

  it('adds a window the CLI reported beyond the declared ones after them, shortest first', () => {
    const perModel: RateLimitWindow = { id: 'seven-day-model', label: '7d Fable', iconKind: 'period', usedPercentage: 12, resetsAt: NOW_SECONDS + 86_400, windowDurationSeconds: 7 * 86_400 };
    const noDuration: RateLimitWindow = { id: 'credits', label: 'Credits', iconKind: 'period', usedPercentage: 5, resetsAt: 0 };
    const lines = accountUsageLines([FIVE_HOUR, SEVEN_DAY], [noDuration, reading(FIVE_HOUR, 3, 3600), perModel, reading(SEVEN_DAY, 55, 86_400)], true);
    expect(lines.map((line) => (line.kind === 'live' ? line.window.id : line.kind))).toEqual(['five-hour', 'seven-day', 'seven-day-model', 'credits']);
  });

  it('reads a window whose reset passed as not started again, once lapsed windows are dropped', () => {
    const lapsed = reading(FIVE_HOUR, 90, -60);
    const lines = accountUsageLines([FIVE_HOUR, SEVEN_DAY], liveRateLimitWindows([lapsed, reading(SEVEN_DAY, 10, 86_400)], NOW_MS), true);
    expect(lines.map((line) => line.kind)).toEqual(['not-started', 'live']);
  });

  it('marks every declared window unread before any reading, and one unnamed line for an agent that declares none', () => {
    expect(accountUsageLines([FIVE_HOUR, SEVEN_DAY], [], false).map((line) => line.kind)).toEqual(['unread', 'unread']);
    expect(accountUsageLines([], [], false)).toEqual([{ kind: 'unread', shape: null }]);
  });

  it('shows only the reported windows for an agent that declares none', () => {
    const lines = accountUsageLines([], [reading(SEVEN_DAY, 20, 86_400)], true);
    expect(lines.map((line) => line.kind)).toEqual(['live']);
  });
});
