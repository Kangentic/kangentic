/**
 * A session's rate-limit windows are stamped with the agent AND the account it runs on before
 * telemetry sees them (task #1057): two accounts' `five-hour` windows are different windows, never
 * one window reported twice. Three paths carry usage into telemetry and each stamps: the history
 * reader's `onUsageUpdate`, the status file's `onUsageParsed`, and the pty host's
 * `streamTelemetry` event.
 *
 * Red-green: dropping `session?.accountId` from any one `withRateLimitAgent` call fails that
 * path's case; a session with no account must carry no `accountId` key at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { SessionUsage } from '../../src/shared/types';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';

interface ManagerInternals {
  registry: { set(sessionId: string, session: unknown): void; delete(sessionId: string): boolean };
  telemetry: {
    processStatusUpdate(sessionId: string, usage: SessionUsage): void;
    setSessionUsage(sessionId: string, usage: Partial<SessionUsage>): void;
  };
  statusFileReader: { callbacks: { onUsageParsed(sessionId: string, usage: SessionUsage): void } };
  sessionHistoryReader: { callbacks: { onUsageUpdate(sessionId: string, usage: Partial<SessionUsage>): void } };
  handleHostEvent(event: unknown): void;
}

function makeUsage(): SessionUsage {
  return {
    contextWindow: { usedPercentage: 12, usedTokens: 24000, cacheTokens: 0, totalInputTokens: 24000, totalOutputTokens: 500, contextWindowSize: 200000 },
    cost: { totalCostUsd: 0.02, totalDurationMs: 5000 },
    model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    rateLimits: [
      { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 10, resetsAt: 1_800_000_000 },
      { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 40, resetsAt: 1_800_500_000 },
    ],
  };
}

describe('SessionManager: usage reaches telemetry stamped with the session\'s agent and account', () => {
  let manager: SessionManager;
  let internals: ManagerInternals;
  let processStatusUpdate: MockInstance<(sessionId: string, usage: SessionUsage) => void>;
  let setSessionUsage: MockInstance<(sessionId: string, usage: Partial<SessionUsage>) => void>;
  const registeredSessionIds: string[] = [];

  function registerSession(sessionId: string, accountId: string | null): void {
    internals.registry.set(sessionId, { id: sessionId, cliTarget: null, agentName: 'claude', accountId });
    registeredSessionIds.push(sessionId);
  }

  function windowsOf(call: unknown[]): Array<{ agent?: string; accountId?: string }> {
    return ((call[1] as SessionUsage).rateLimits ?? []) as Array<{ agent?: string; accountId?: string }>;
  }

  beforeEach(() => {
    manager = new SessionManager();
    internals = manager as unknown as ManagerInternals;
    processStatusUpdate = vi.spyOn(internals.telemetry, 'processStatusUpdate').mockImplementation(() => undefined);
    setSessionUsage = vi.spyOn(internals.telemetry, 'setSessionUsage').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const sessionId of registeredSessionIds.splice(0)) internals.registry.delete(sessionId);
    manager.dispose();
  });

  it('stamps the status file path', () => {
    registerSession('session-2', 'account-2');

    internals.statusFileReader.callbacks.onUsageParsed('session-2', makeUsage());

    const windows = windowsOf(processStatusUpdate.mock.calls[0]);
    expect(windows).toHaveLength(2);
    expect(windows.map((rateLimitWindow) => rateLimitWindow.accountId)).toEqual(['account-2', 'account-2']);
    expect(windows.map((rateLimitWindow) => rateLimitWindow.agent)).toEqual(['claude', 'claude']);
  });

  it('stamps the history reader path', () => {
    registerSession('session-2', 'account-2');

    internals.sessionHistoryReader.callbacks.onUsageUpdate('session-2', makeUsage());

    const windows = windowsOf(setSessionUsage.mock.calls[0]);
    expect(windows.map((rateLimitWindow) => rateLimitWindow.accountId)).toEqual(['account-2', 'account-2']);
    expect(windows.map((rateLimitWindow) => rateLimitWindow.agent)).toEqual(['claude', 'claude']);
  });

  it('stamps the host streamTelemetry path', () => {
    registerSession('session-2', 'account-2');

    internals.handleHostEvent({ type: 'streamTelemetry', sessionId: 'session-2', usage: makeUsage() });

    const windows = windowsOf(setSessionUsage.mock.calls[0]);
    expect(windows.map((rateLimitWindow) => rateLimitWindow.accountId)).toEqual(['account-2', 'account-2']);
    expect(windows.map((rateLimitWindow) => rateLimitWindow.agent)).toEqual(['claude', 'claude']);
  });

  it('adds no accountId for a session on the agent\'s own login, on every path', () => {
    registerSession('session-default', null);

    internals.statusFileReader.callbacks.onUsageParsed('session-default', makeUsage());
    internals.sessionHistoryReader.callbacks.onUsageUpdate('session-default', makeUsage());
    internals.handleHostEvent({ type: 'streamTelemetry', sessionId: 'session-default', usage: makeUsage() });

    for (const call of [processStatusUpdate.mock.calls[0], setSessionUsage.mock.calls[0], setSessionUsage.mock.calls[1]]) {
      for (const rateLimitWindow of windowsOf(call)) {
        expect(rateLimitWindow.agent).toBe('claude');
        expect(rateLimitWindow).not.toHaveProperty('accountId');
      }
    }
  });
});
