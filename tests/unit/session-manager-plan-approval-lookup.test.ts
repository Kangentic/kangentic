/**
 * Wiring test for `SessionManager.setPlanApprovalLookup`.
 *
 * The plan approval gate (plan-approval-gate.ts) holds a plan-exit permission
 * idle only for a session whose decision approves plans, and it learns that
 * from `approvesPlanAutomatically`, which SessionManager builds from the lookup
 * the PlanApprovalWriter hands it:
 *
 *   approvesPlanAutomatically: (sessionId) => this.planApprovalLookup?.(sessionId) ?? false
 *
 * plan-approval-gate*.test.ts drive SessionTelemetry with a hand-written
 * `approvesPlanAutomatically`, and plan-approval-writer*.test.ts drive a fake
 * session manager, so nothing else crosses the REAL SessionManager and its real
 * telemetry: a lookup set on the manager must decide whether a plan-exit
 * permission idle reaches the card ('permission' activity) at once or waits.
 *
 * Red-green: replacing the `approvesPlanAutomatically` line in session-manager.ts
 * with `false` fails the "holds" test (the idle reaches 'permission' at once),
 * and replacing it with `true` fails the "passes through" and "no lookup" tests.
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

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { PLAN_APPROVAL_HOLD_MS } from '../../src/main/activity-engine/plan-approval-gate';
import { AgentTool, EventType, IdleReason } from '../../src/shared/types';
import type { ActivityState } from '../../src/shared/types';

/** Type-cast helper to reach the private telemetry field, as the sibling suites do. */
function getTelemetry(manager: SessionManager): SessionTelemetry {
  return (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
}

describe('SessionManager.setPlanApprovalLookup', () => {
  let manager: SessionManager;
  let activities: ActivityState[];
  let sessionId: string;

  beforeEach(() => {
    // Faked before the manager exists so every timer it and the gate create is fake.
    vi.useFakeTimers();
    manager = new SessionManager({
      activityEngineOptions: {
        bgShellEscapeHatchMs: 60_000,
        staleThinkingTimeoutMs: 60_000,
        // No stability delay: without this a plain idle would also wait, and
        // "held" could pass with no gate at all.
        idleStabilityWindowMs: 0,
      },
    });
    const session = manager.registerSuspendedPlaceholder({ taskId: 'task-1', projectId: 'project-1', cwd: '/mock' });
    if (!session) throw new Error('The suspended placeholder was not registered');
    sessionId = session.id;
    getTelemetry(manager).initSession(sessionId);
    activities = [];
    manager.on('activity', (_id: string, activity: ActivityState) => activities.push(activity));

    // The agent plans: a prompt, then the plan exit tool starts.
    getTelemetry(manager).ingestEvents(sessionId, [
      { ts: 1, type: EventType.Prompt },
      { ts: 2, type: EventType.ToolStart, tool: AgentTool.ExitPlanMode, toolId: 'toolu_plan' },
    ]);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  /** The permission idle the agent raises for the plan approval prompt. */
  function raisePlanPermissionIdle(): void {
    getTelemetry(manager).ingestEvents(sessionId, [
      { ts: 3, type: EventType.Idle, detail: IdleReason.Permission, tool: AgentTool.ExitPlanMode },
    ]);
  }

  it('passes a plan-exit permission idle through at once when the lookup says the plan is not approved', () => {
    const lookup = vi.fn(() => false);
    manager.setPlanApprovalLookup(lookup);

    raisePlanPermissionIdle();

    // Not held: the user has to answer this prompt, so it reads as needs-you now.
    expect(activities.at(-1)).toBe('permission');
    // And the gate asked about this very session.
    expect(lookup).toHaveBeenCalledWith(sessionId);
  });

  it('holds a plan-exit permission idle while the lookup says the plan is approved, then lets it through late', () => {
    const lookup = vi.fn(() => true);
    manager.setPlanApprovalLookup(lookup);

    raisePlanPermissionIdle();

    expect(activities).not.toContain('permission');
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS - 1);
    expect(activities).not.toContain('permission');

    // No plan exit ToolEnd came, so the approval did not happen: the prompt
    // shows as needs-you after all.
    vi.advanceTimersByTime(2);
    expect(activities.at(-1)).toBe('permission');
    expect(lookup).toHaveBeenCalledWith(sessionId);
  });

  it('holds nothing when no lookup was ever set', () => {
    raisePlanPermissionIdle();

    expect(activities.at(-1)).toBe('permission');
  });
});
