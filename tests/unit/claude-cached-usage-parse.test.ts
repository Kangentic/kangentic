/**
 * `parseClaudeCachedUsage` reads Claude's own state file (`cachedUsageUtilization`), and the home
 * helpers that locate that file. The fixture keeps the real key names and nesting with made-up
 * values (tests/fixtures/claude-state-cached-usage.json).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeCachedUsage } from '../../src/main/agent/adapters/claude/accounts';
import { claudeStatePathForHome, isDefaultClaudeHome } from '../../src/main/agent/adapters/claude/claude-json-lock';

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

const TEN_MINUTES_MS = 10 * 60 * 1000;

describe('parseClaudeCachedUsage', () => {
  it('reads both windows of a real-shape cache, with resets_at as epoch seconds', () => {
    const state = loadState();
    const windows = parseClaudeCachedUsage(state, state.cachedUsageUtilization.fetchedAtMs + 1000);
    expect(windows?.map((window) => window.id)).toEqual(['five-hour', 'seven-day']);
    expect(windows?.[0].usedPercentage).toBe(37);
    expect(windows?.[0].resetsAt).toBe(Date.UTC(2027, 0, 15, 8, 30, 0) / 1000);
    expect(windows?.[1].usedPercentage).toBe(21);
    expect(windows?.[1].resetsAt).toBe(Date.UTC(2027, 0, 18, 0, 0, 0) / 1000);
  });

  it('accepts a cache exactly ten minutes old and rejects one a millisecond older', () => {
    const state = loadState();
    const fetchedAtMs = state.cachedUsageUtilization.fetchedAtMs;
    expect(parseClaudeCachedUsage(state, fetchedAtMs + TEN_MINUTES_MS)).not.toBeNull();
    expect(parseClaudeCachedUsage(state, fetchedAtMs + TEN_MINUTES_MS + 1)).toBeNull();
  });

  it('skips a null window, as a plan with no 5h window has', () => {
    const state = loadState();
    state.cachedUsageUtilization.utilization.five_hour = null;
    const windows = parseClaudeCachedUsage(state, state.cachedUsageUtilization.fetchedAtMs);
    expect(windows?.map((window) => window.id)).toEqual(['seven-day']);
  });

  it('clamps utilization to 0..100', () => {
    const state = loadState();
    state.cachedUsageUtilization.utilization.five_hour = { utilization: 140, resets_at: '2027-01-15T08:30:00+00:00' };
    state.cachedUsageUtilization.utilization.seven_day = { utilization: -5, resets_at: '2027-01-18T00:00:00+00:00' };
    const windows = parseClaudeCachedUsage(state, state.cachedUsageUtilization.fetchedAtMs);
    expect(windows?.map((window) => window.usedPercentage)).toEqual([100, 0]);
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
