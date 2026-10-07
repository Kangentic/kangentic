/**
 * Wiring test for `SessionManager.getFirstReportedEffort`.
 *
 * The getter is a facade over the manager's SessionTelemetry, which has its own
 * test (session-telemetry-first-reported-effort.test.ts). This file crosses the
 * REAL SessionManager so a getter that stops delegating, or a removal path that
 * stops clearing the telemetry's per-session state, goes red here.
 *
 * Red-green: making `getFirstReportedEffort` return null, or dropping
 * `this.telemetry.removeSession` from `clearSessionCaches`, fails the matching
 * assertion below.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

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

describe('SessionManager.getFirstReportedEffort', () => {
  let manager: SessionManager;

  afterEach(() => {
    manager.dispose();
  });

  it('returns the first effort a session reported, not a later one', () => {
    manager = new SessionManager();
    manager.setSessionUsage('session-a', { model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effort: 'high' } });
    manager.setSessionUsage('session-a', { model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effort: 'low' } });

    expect(manager.getFirstReportedEffort('session-a')).toBe('high');
    // The live level moved; the first report did not.
    expect(manager.getUsageCache()['session-a'].model.effort).toBe('low');
  });

  it('returns null for a session that never reported an effort', () => {
    manager = new SessionManager();
    manager.setSessionUsage('session-a', { model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effort: 'high' } });

    expect(manager.getFirstReportedEffort('unknown-session')).toBeNull();
  });

  it('returns null again after remove(), so a reused id does not inherit the old first level', () => {
    manager = new SessionManager();
    manager.setSessionUsage('session-a', { model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effort: 'high' } });
    expect(manager.getFirstReportedEffort('session-a')).toBe('high');

    manager.remove('session-a');

    expect(manager.getFirstReportedEffort('session-a')).toBeNull();
  });
});
