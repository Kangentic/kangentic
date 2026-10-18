/**
 * Wiring test for `SessionManager.hadLeftPlanModeBy`.
 *
 * The method is a facade over the manager's SessionTelemetry, whose plan-mode
 * trail has its own tests (plan-mode-trail.test.ts). The turn-end runner reads
 * the answer through the manager, so this file crosses the REAL SessionManager
 * and its real telemetry: events fed to the session's telemetry must come back
 * out of the manager's own method.
 *
 * Red-green: making `hadLeftPlanModeBy` return false (or forward the wrong
 * session id) fails the first assertion below.
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
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';

/** Type-cast helper to reach the private telemetry field, as the sibling suites do. */
function getTelemetry(manager: SessionManager): SessionTelemetry {
  return (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
}

describe('SessionManager.hadLeftPlanModeBy', () => {
  let manager: SessionManager;

  afterEach(() => {
    manager.dispose();
  });

  it('answers from the plan mode the session\'s agent reported', () => {
    manager = new SessionManager();
    const session = manager.registerSuspendedPlaceholder({ taskId: 'task-1', projectId: 'project-1', cwd: '/mock' });
    const telemetry = getTelemetry(manager);
    telemetry.initSession(session.id);

    // In plan mode first, then out of it: the agent left plan mode.
    telemetry.ingestEvents(session.id, [{ ts: 0, type: EventType.Prompt, planMode: true }]);
    telemetry.ingestEvents(session.id, [{ ts: 0, type: EventType.Idle, planMode: false }]);

    // Both reports were stamped on the ingest clock, at or before now.
    expect(manager.hadLeftPlanModeBy(session.id, Date.now())).toBe(true);
  });

  it('answers no for a session still in plan mode', () => {
    manager = new SessionManager();
    const session = manager.registerSuspendedPlaceholder({ taskId: 'task-1', projectId: 'project-1', cwd: '/mock' });
    const telemetry = getTelemetry(manager);
    telemetry.initSession(session.id);

    telemetry.ingestEvents(session.id, [{ ts: 0, type: EventType.Prompt, planMode: true }]);

    expect(manager.hadLeftPlanModeBy(session.id, Date.now())).toBe(false);
  });

  it('answers no for an unknown session', () => {
    manager = new SessionManager();

    expect(manager.hadLeftPlanModeBy('unknown-session', Date.now())).toBe(false);
  });
});
