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
 *
 * The second describe pins the line beside it, which feeds the same gate the
 * answer to "may this session's agent hook answer a prompt for this tool":
 *
 *   mayApprovePlanTool: (sessionId, toolName) =>
 *     this.registry.get(sessionId)?.agentParser?.mayApprovePlanTool?.(toolName) === true
 *
 * While the plan decision approves and the registry row's parser names the tool,
 * a tool's permission idle waits for the hook's `tool_approval_sent` marker.
 * Red-green: making the callback return `false` fails the "holds" tests (the idle
 * reaches 'permission' at once), and making it return `true` fails every "passes
 * at once" test (a parser that names nothing, a Kangentic tool, a row that is gone).
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
import {
  PLAN_APPROVAL_HOLD_MS,
  TOOL_APPROVAL_HOLD_MS,
  TOOL_APPROVAL_WAIT_MS,
} from '../../src/main/activity-engine/plan-approval-gate';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import type { ManagedSession } from '../../src/main/pty/session-registry';
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

describe('SessionManager mayApprovePlanTool wiring', () => {
  /** An MCP tool the session's allow rules can name, so Claude's hook may answer its prompt. */
  const ANSWERABLE_TOOL = 'mcp__docs__search';
  /** Kangentic's own tool: its mutating tools must keep prompting, so the adapter refuses it. */
  const KANGENTIC_TOOL = 'mcp__kangentic__kangentic_move_task';
  const TOOL_ID = 'toolu_tool';

  let manager: SessionManager;
  let activities: ActivityState[];
  let sessionId: string;

  /** The registry is private; the wiring under test reads the row from it. */
  function registryOf(target: SessionManager): {
    get(id: string): ManagedSession | undefined;
    delete(id: string): boolean;
  } {
    return (target as unknown as {
      registry: { get(id: string): ManagedSession | undefined; delete(id: string): boolean };
    }).registry;
  }

  /** What `performSpawn` sets on the row: the session's adapter instance. */
  function setSessionParser(parser: ManagedSession['agentParser']): void {
    const row = registryOf(manager).get(sessionId);
    if (!row) throw new Error('The placeholder row is not in the registry');
    row.agentParser = parser;
  }

  /** The agent is mid-turn, running the tool. */
  function startTool(tool: string): void {
    getTelemetry(manager).ingestEvents(sessionId, [
      { ts: 1, type: EventType.Prompt },
      { ts: 2, type: EventType.ToolStart, tool, toolId: TOOL_ID },
    ]);
  }

  /** The permission idle the catch-all hook reports for that tool's prompt. */
  function raiseToolPermissionIdle(tool: string): void {
    getTelemetry(manager).ingestEvents(sessionId, [
      { ts: 3, type: EventType.Idle, detail: IdleReason.Permission, tool },
    ]);
  }

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
    // The session's plan decision approves, so only the parser can still say no.
    manager.setPlanApprovalLookup(() => true);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  describe('when the session\'s agent parser names the tool', () => {
    it('holds the permission idle for the hook\'s marker, and a marker then the tool\'s end keep it from ever reaching permission', () => {
      setSessionParser(new ClaudeAdapter());
      startTool(ANSWERABLE_TOOL);

      raiseToolPermissionIdle(ANSWERABLE_TOOL);

      expect(activities).not.toContain('permission');
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS - 1);
      expect(activities).not.toContain('permission');

      // The hook answered the prompt, then the tool ran and ended.
      const telemetry = getTelemetry(manager);
      telemetry.ingestEvents(sessionId, [{ ts: 4, type: EventType.ToolApprovalSent, tool: ANSWERABLE_TOOL }]);
      telemetry.ingestEvents(sessionId, [{ ts: 5, type: EventType.ToolEnd, tool: ANSWERABLE_TOOL, toolId: TOOL_ID }]);
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS + TOOL_APPROVAL_WAIT_MS);

      expect(activities).not.toContain('permission');
    });

    it('lets the idle through late when no marker comes, so a prompt the hook left alone still reads as needs-you', () => {
      setSessionParser(new ClaudeAdapter());
      startTool(ANSWERABLE_TOOL);

      raiseToolPermissionIdle(ANSWERABLE_TOOL);

      expect(activities).not.toContain('permission');
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS - 1);
      expect(activities).not.toContain('permission');
      vi.advanceTimersByTime(2);
      expect(activities.at(-1)).toBe('permission');
    });

    it('asks the parser on the session\'s row about the tool the idle names', () => {
      const mayApprovePlanTool = vi.fn(() => true);
      setSessionParser({ mayApprovePlanTool } as unknown as ManagedSession['agentParser']);
      startTool(ANSWERABLE_TOOL);

      raiseToolPermissionIdle(ANSWERABLE_TOOL);

      expect(mayApprovePlanTool).toHaveBeenCalledWith(ANSWERABLE_TOOL);
      expect(activities).not.toContain('permission');
    });
  });

  describe('when nothing says the hook may answer the tool', () => {
    it('passes the idle through at once for a parser with no mayApprovePlanTool', () => {
      setSessionParser({} as unknown as ManagedSession['agentParser']);
      startTool(ANSWERABLE_TOOL);

      raiseToolPermissionIdle(ANSWERABLE_TOOL);

      expect(activities.at(-1)).toBe('permission');
    });

    it('passes the idle through at once for a tool the parser refuses (Claude and a Kangentic tool)', () => {
      setSessionParser(new ClaudeAdapter());
      startTool(KANGENTIC_TOOL);

      raiseToolPermissionIdle(KANGENTIC_TOOL);

      expect(activities.at(-1)).toBe('permission');
    });

    it('passes the idle through at once when the session\'s row is gone from the registry', () => {
      setSessionParser(new ClaudeAdapter());
      startTool(ANSWERABLE_TOOL);
      registryOf(manager).delete(sessionId);

      raiseToolPermissionIdle(ANSWERABLE_TOOL);

      expect(activities.at(-1)).toBe('permission');
    });
  });
});
