/**
 * Unit test for SessionManager's wiring of SessionTelemetry's onReasonChange
 * callback to a NEW EventEmitter event, 'activity-reason'
 * (src/main/pty/session-manager.ts):
 *
 *   onReasonChange: (sessionId, activity, reason) =>
 *     this.emit('activity-reason', sessionId, activity, reason),
 *
 * No other test in the suite reaches this line. activity-engine-reason-reporting
 * .test.ts and session-telemetry-activity-reasons.test.ts construct the engine
 * and telemetry directly, never a SessionManager. ipc-handler-wiring.test.ts
 * mocks context.sessionManager.on entirely and hand-invokes the captured
 * listener with a fabricated 'activity-reason' name, so it proves sessions.ts
 * reacts correctly to that emit but never proves the real SessionManager class
 * produces one. A renamed event, a dropped onReasonChange line, or a swapped
 * argument order in session-manager.ts would leave every one of those tests
 * green.
 *
 * Also asserts the negative: the same reason-only churn that fires
 * 'activity-reason' must not ALSO fire 'activity'. Nine other listeners on
 * 'activity' (mobile push notifier, desktop notifier, turn-completion
 * auto-move, the terminal submit scheduler, the interval recorder) read it as
 * "the state changed" - see the comment above the wiring in session-manager.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (p: string) => /^[\\/]{2}[^\\/]/.test(p),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';
import type { ActivityState, ActivityReason } from '../../src/shared/types';

/** Type-cast helper to reach the private telemetry field, matching the
 *  established pattern in session-manager-activity-reasons-cache.test.ts. */
function getTelemetry(manager: SessionManager): SessionTelemetry {
  return (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
}

interface ActivityReasonEmission {
  sessionId: string;
  activity: ActivityState;
  reason: ActivityReason;
}

describe('SessionManager: onReasonChange forwards to a separate activity-reason event', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager({
      activityEngineOptions: {
        bgShellEscapeHatchMs: 60_000,
        staleThinkingTimeoutMs: 60_000,
        idleStabilityWindowMs: 0,
      },
    });
  });

  afterEach(() => {
    manager.dispose();
  });

  it('emits activity-reason with the session id, the unchanged activity, and the moved reason kind, without also emitting activity', () => {
    const session = manager.registerSuspendedPlaceholder({
      taskId: 'task-reason-emit',
      projectId: 'project-reason-emit',
      cwd: '/mock/cwd',
    });
    expect(session).not.toBeNull();
    const sessionId = session!.id;

    const telemetry = getTelemetry(manager);
    telemetry.initSession(sessionId);

    const reasonEmissions: ActivityReasonEmission[] = [];
    manager.on('activity-reason', (id: string, activity: ActivityState, reason: ActivityReason) => {
      reasonEmissions.push({ sessionId: id, activity, reason });
    });
    const activityEmissions: ActivityState[] = [];
    manager.on('activity', (_id: string, activity: ActivityState) => {
      activityEmissions.push(activity);
    });

    const now = Date.now();
    // idle -> thinking: a real transition. Fires 'activity', not
    // 'activity-reason'.
    telemetry.ingestEvents(sessionId, [{ ts: now, type: EventType.Prompt }]);
    expect(activityEmissions).toEqual(['thinking']);
    expect(reasonEmissions).toEqual([]);

    // Still thinking throughout: the derived reason kind moves
    // turn-active -> tool -> turn-active -> subagent. Each kind move is a
    // reason-only report (the same sequence proven in
    // session-telemetry-activity-reasons.test.ts).
    telemetry.ingestEvents(sessionId, [
      { ts: now + 1, type: EventType.ToolStart, tool: 'Read', toolId: 't1' },
      { ts: now + 2, type: EventType.ToolEnd, tool: 'Read', toolId: 't1' },
      { ts: now + 3, type: EventType.SubagentStart, detail: 'review-finder' },
    ]);

    // The negative assertion: none of that churn fired 'activity'. If
    // session-manager.ts's onReasonChange wiring routed onto 'activity'
    // instead of 'activity-reason', this would fail - and so would every
    // listener downstream that treats 'activity' as a real transition.
    expect(activityEmissions).toEqual(['thinking']);

    expect(reasonEmissions.length).toBeGreaterThan(0);
    const kinds = reasonEmissions.map((emission) => emission.reason.kind);
    expect(kinds).toContain('tool');
    expect(kinds).toContain('subagent');
    for (const emission of reasonEmissions) {
      expect(emission.sessionId).toBe(sessionId);
      expect(emission.activity).toBe('thinking');
    }
  });
});
