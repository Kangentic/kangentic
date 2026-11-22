/**
 * `readClaudeCachedUsage` reads Claude's own state file (`cachedUsageUtilization`), and the home
 * helpers that locate that file. The fixture keeps the real key names and nesting with made-up
 * values (tests/fixtures/claude-state-cached-usage.json).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UnreadableUsageError } from '../../src/main/accounts/account-support';
import { readClaudeCachedUsage } from '../../src/main/agent/adapters/claude/accounts';
import { claudeStatePathForHome, isDefaultClaudeHome } from '../../src/main/agent/adapters/claude/claude-json-lock';
import type { RateLimitWindow } from '../../src/shared/types';

interface CachedUsageState {
  cachedUsageUtilization: {
    fetchedAtMs: number;
    utilization: Record<string, { utilization: number; resets_at: string } | null>;
  };
}

function loadState(): CachedUsageState {
  const text = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-state-cached-usage.json'), 'utf8');
  return JSON.parse(text) as CachedUsageState;
}

/** The windows a reading holds, or null when it names why it holds none. */
function windowsOf(state: unknown, nowMs: number): RateLimitWindow[] | null {
  const reading = readClaudeCachedUsage(state, nowMs);
  return 'windows' in reading ? reading.windows : null;
}

/** What `run` threw, or undefined when it returned. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

const TEN_MINUTES_MS = 10 * 60 * 1000;

describe('readClaudeCachedUsage', () => {
  it('reads both windows of a real-shape cache, with resets_at as epoch seconds', () => {
    const state = loadState();
    const windows = windowsOf(state, state.cachedUsageUtilization.fetchedAtMs + 1000);
    expect(windows?.map((window) => window.id)).toEqual(['five-hour', 'seven-day']);
    expect(windows?.[0].usedPercentage).toBe(37);
    expect(windows?.[0].resetsAt).toBe(Date.UTC(2027, 0, 15, 8, 30, 0) / 1000);
    expect(windows?.[1].usedPercentage).toBe(21);
    expect(windows?.[1].resetsAt).toBe(Date.UTC(2027, 0, 18, 0, 0, 0) / 1000);
  });

  it('accepts a cache exactly ten minutes old and calls one a millisecond older stale', () => {
    const state = loadState();
    const fetchedAtMs = state.cachedUsageUtilization.fetchedAtMs;
    expect(windowsOf(state, fetchedAtMs + TEN_MINUTES_MS)).not.toBeNull();
    expect(readClaudeCachedUsage(state, fetchedAtMs + TEN_MINUTES_MS + 1)).toEqual({ empty: 'cache-stale' });
  });

  it('skips a null window, as a plan with no 5h window has', () => {
    const state = loadState();
    state.cachedUsageUtilization.utilization.five_hour = null;
    const windows = windowsOf(state, state.cachedUsageUtilization.fetchedAtMs);
    expect(windows?.map((window) => window.id)).toEqual(['seven-day']);
  });

  it('clamps utilization to 0..100', () => {
    const state = loadState();
    state.cachedUsageUtilization.utilization.five_hour = { utilization: 140, resets_at: '2027-01-15T08:30:00+00:00' };
    state.cachedUsageUtilization.utilization.seven_day = { utilization: -5, resets_at: '2027-01-18T00:00:00+00:00' };
    const windows = windowsOf(state, state.cachedUsageUtilization.fetchedAtMs);
    expect(windows?.map((window) => window.usedPercentage)).toEqual([100, 0]);
  });

  // Task #1147, measured on 2.1.330 with a spent weekly allowance: the status line read 99 while
  // the cache's `limits[]` marked the weekly window spent. The entries keep the real shape.
  describe('a window Claude marks spent', () => {
    const resetsAt = '2027-01-18T00:00:00.021680+00:00';
    function limit(kind: string, isActive: boolean, scope: unknown = null, percent: unknown = 100): Record<string, unknown> {
      return { kind, group: 'weekly', percent, severity: 'critical', resets_at: resetsAt, scope, is_active: isActive };
    }
    function sevenDayWith(limits: unknown): number | undefined {
      const state = loadState();
      state.cachedUsageUtilization.utilization.seven_day = { utilization: 99.4, resets_at: resetsAt };
      (state.cachedUsageUtilization.utilization as Record<string, unknown>).limits = limits;
      return windowsOf(state, state.cachedUsageUtilization.fetchedAtMs)?.find((window) => window.id === 'seven-day')?.usedPercentage;
    }

    it('reads an active account-wide weekly limit as full', () => {
      expect(sevenDayWith([limit('weekly_all', true)])).toBe(100);
    });

    it('leaves the percentage for an inactive limit and for one model\'s limit, which other models can still use', () => {
      expect(sevenDayWith([limit('weekly_all', false)])).toBe(99.4);
      expect(sevenDayWith([limit('weekly_scoped', true, { model: { id: null, display_name: 'Fable' }, surface: null })])).toBe(99.4);
    });

    it('reads the measured limits shape of a spent weekly allowance, with the weekly window full and the session one not', () => {
      const text = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-state-spent-weekly.json'), 'utf8');
      const state = JSON.parse(text) as CachedUsageState;
      const windows = windowsOf(state, state.cachedUsageUtilization.fetchedAtMs);
      expect(windows?.find((window) => window.id === 'seven-day')?.usedPercentage).toBe(100);
      expect(windows?.find((window) => window.id === 'five-hour')?.usedPercentage).toBe(12);
    });

    it('leaves the percentage when the active account-wide limit is itself under 100 or has no numeric percent', () => {
      expect(sevenDayWith([limit('weekly_all', true, null, 40)])).toBe(99.4);
      expect(sevenDayWith([limit('weekly_all', true, null, '100')])).toBe(99.4);
      expect(sevenDayWith([limit('weekly_all', true, null, null)])).toBe(99.4);
    });

    it('ignores a limits value it does not know', () => {
      expect(sevenDayWith('weekly_all')).toBe(99.4);
      expect(sevenDayWith([null, 7, { kind: 'weekly_all', is_active: 'yes', scope: null }])).toBe(99.4);
    });
  });

  it('names no-windows when utilization is null, the way Claude marks a window that does not apply', () => {
    const state = loadState();
    const fetchedAtMs = state.cachedUsageUtilization.fetchedAtMs;
    expect(readClaudeCachedUsage({ cachedUsageUtilization: { fetchedAtMs, utilization: null } }, fetchedAtMs)).toEqual({ empty: 'no-windows' });
  });

  // A renamed `utilization` field would empty every Claude account's reading, and Sentry
  // DESKTOP-4E could not tell that from a plan with no windows. The cache's keys name the new field.
  it.each([
    ['missing', { fetchedAtMs: 0, usage: {} }, 'fetchedAtMs,usage'],
    ['a string', { fetchedAtMs: 0, utilization: 'x' }, 'fetchedAtMs,utilization'],
    ['a list', { fetchedAtMs: 0, utilization: [] }, 'fetchedAtMs,utilization'],
  ])('throws unreadable with the cache\'s keys when utilization is %s', (_label, cache, keys) => {
    const failure = thrownBy(() => readClaudeCachedUsage({ cachedUsageUtilization: cache }, 0));
    expect(failure).toBeInstanceOf(UnreadableUsageError);
    expect((failure as UnreadableUsageError).keys).toBe(keys);
  });

  it('caps the keys on an unreadable report at 120 characters', () => {
    const unknownKeys = Array.from({ length: 12 }, (_unused, index) => `unknown_fiel_${String(index).padStart(2, '0')}`);
    expect(unknownKeys[0]).toHaveLength(15);
    const utilization = Object.fromEntries(unknownKeys.map((key) => [key, { utilization: 1, resets_at: 'x' }]));
    const failure = thrownBy(() => readClaudeCachedUsage({ cachedUsageUtilization: { fetchedAtMs: 0, utilization } }, 0));
    expect(failure).toBeInstanceOf(UnreadableUsageError);
    const keys = (failure as UnreadableUsageError).keys;
    expect(keys).toHaveLength(120);
    expect(keys).toBe([...unknownKeys].sort().join(',').slice(0, 120));
  });
});

describe('Claude home helpers', () => {
  const defaultHome = path.join(os.homedir(), '.claude');

  it('maps ~/.claude to ~/.claude.json', () => {
    expect(isDefaultClaudeHome(defaultHome)).toBe(true);
    expect(claudeStatePathForHome(defaultHome)).toBe(path.join(os.homedir(), '.claude.json'));
  });

  it('maps another folder to its own .claude.json', () => {
    const accountFolder = path.join(os.tmpdir(), 'kangentic-claude-account');
    expect(isDefaultClaudeHome(accountFolder)).toBe(false);
    expect(claudeStatePathForHome(accountFolder)).toBe(path.join(accountFolder, '.claude.json'));
  });

  it.runIf(process.platform === 'win32')('counts another letter case of ~/.claude as the default home on Windows', () => {
    const recased = defaultHome.toUpperCase();
    expect(isDefaultClaudeHome(recased)).toBe(true);
    expect(claudeStatePathForHome(recased)).toBe(path.join(os.homedir(), '.claude.json'));
  });
});
