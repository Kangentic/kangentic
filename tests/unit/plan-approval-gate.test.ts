/**
 * The plan approval gate (src/main/activity-engine/plan-approval-gate.ts),
 * driven through the real SessionTelemetry ingest so every consumer it feeds
 * (the activity engine, the event log, the turn-start stamp) is the real one.
 *
 * The event order is the one measured on Claude Code 2.1.302 in a probe:
 * PreToolUse(ExitPlanMode), then the catch-all PermissionRequest's
 * permission idle 24 to 31 ms BEFORE the approver's marker, then the plan
 * exit's PostToolUse 130 to 170 ms after the marker. The marker-first order
 * was not observed but the two hooks run in parallel, so it is pinned too.
 * The same holds for a tool the hook approves (task #870), pinned below.
 *
 * `onActivityChange` is what the desktop notifier, the phone's push notifier
 * and the card all read, so "never enters permission" here is "no amber, no
 * Needs permission, no push".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import {
  PLAN_APPROVAL_HOLD_MS,
  TOOL_APPROVAL_HOLD_MS,
  TOOL_APPROVAL_MARKER_WINDOW_MS,
  TOOL_APPROVAL_WAIT_MS,
} from '../../src/main/activity-engine/plan-approval-gate';
import { mayApproveClaudePlanTool } from '../../src/main/agent/adapters/claude/plan-tool-approval';
import { AgentTool, EventType, IdleReason } from '../../src/shared/types';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

const SESSION = 'session-plan';

interface Harness {
  telemetry: SessionTelemetry;
  activities: ActivityState[];
  events: SessionEvent[];
  turnStarts: string[];
  setApproves(approves: boolean): void;
}

function makeHarness(): Harness {
  let approves = true;
  const activities: ActivityState[] = [];
  const events: SessionEvent[] = [];
  const turnStarts: string[] = [];
  const telemetry = new SessionTelemetry({
    onUsageChange: () => {},
    onActivityChange: (_sessionId, activity) => activities.push(activity),
    onEvent: (_sessionId, event) => events.push(event),
    onIdleTimeout: () => {},
    onPlanExit: () => {},
    onPRCandidate: () => {},
    requestSuspend: () => {},
    isSessionRunning: () => true,
    onTurnStarted: (_sessionId, _turnStartedAt, cause) => turnStarts.push(cause),
    approvesPlanAutomatically: () => approves,
    // The Claude adapter's own answer, as SessionManager reads it off the session.
    mayApprovePlanTool: (_sessionId, toolName) => mayApproveClaudePlanTool(toolName),
  }, {
    disableBgShellWatcher: true,
    activityEngineOptions: { idleStabilityWindowMs: 0, staleThinkingTimeoutMs: 600_000 },
  });
  telemetry.initSession(SESSION);
  return { telemetry, activities, events, turnStarts, setApproves: (value) => { approves = value; } };
}

const prompt: SessionEvent = { ts: 1, type: EventType.Prompt };
const planToolStart: SessionEvent = { ts: 2, type: EventType.ToolStart, tool: AgentTool.ExitPlanMode, toolId: 'toolu_plan' };
const planPermissionIdle: SessionEvent = { ts: 3, type: EventType.Idle, detail: IdleReason.Permission, tool: AgentTool.ExitPlanMode };
const marker: SessionEvent = { ts: 4, type: EventType.PlanApprovalSent, detail: 'Moved to Executing' };
const planToolEnd: SessionEvent = { ts: 5, type: EventType.ToolEnd, tool: AgentTool.ExitPlanMode, toolId: 'toolu_plan' };

let harness: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  harness = makeHarness();
  harness.telemetry.ingestEvents(SESSION, [prompt, planToolStart]);
});

afterEach(() => {
  harness.telemetry.dispose();
  vi.useRealTimers();
});

function ingest(...events: SessionEvent[]): void {
  for (const event of events) harness.telemetry.ingestEvents(SESSION, [event]);
}

describe('plan approval gate', () => {
  it('drops the plan prompt idle that arrives before the marker (the measured order)', () => {
    ingest(planPermissionIdle, marker, planToolEnd);
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS * 2);
    expect(harness.activities).not.toContain('permission');
    expect(harness.events.map((event) => event.type)).not.toContain(EventType.Idle);
  });

  it('drops the plan prompt idle that arrives after the marker', () => {
    ingest(marker, planPermissionIdle, planToolEnd);
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS * 2);
    expect(harness.activities).not.toContain('permission');
  });

  it('follows the approved plan exit with plan_auto_approved, carrying the marker detail', () => {
    ingest(planPermissionIdle, marker, planToolEnd);
    const types = harness.events.map((event) => event.type);
    expect(types.indexOf(EventType.PlanAutoApproved)).toBe(types.indexOf(EventType.ToolEnd) + 1);
    expect(harness.events.find((event) => event.type === EventType.PlanAutoApproved)?.detail).toBe('Moved to Executing');
  });

  it('re-stamps the turn start on the auto-approval, as a user approval does', () => {
    ingest(planPermissionIdle, marker, planToolEnd);
    expect(harness.turnStarts).toContain('plan-approval');
  });

  it('writes no plan_auto_approved for a marker the CLI never acted on', () => {
    ingest(planPermissionIdle, marker);
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS * 2);
    expect(harness.events.map((event) => event.type)).not.toContain(EventType.PlanAutoApproved);
  });

  it('lets a held idle through late when no marker arrives, so a failed approver shows the dialog as needs you', () => {
    ingest(planPermissionIdle);
    expect(harness.activities).not.toContain('permission');
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS + 1);
    expect(harness.activities.at(-1)).toBe('permission');
  });

  it('holds nothing for a session whose decision leaves plans to the user', () => {
    harness.setApproves(false);
    ingest(planPermissionIdle);
    expect(harness.activities.at(-1)).toBe('permission');
  });

  it('never holds a question the agent asks, even where plans are approved', () => {
    ingest(
      { ts: 6, type: EventType.ToolStart, tool: 'AskUserQuestion', toolId: 'toolu_question' },
      { ts: 7, type: EventType.Idle, detail: IdleReason.Permission, tool: 'AskUserQuestion' },
    );
    expect(harness.activities.at(-1)).toBe('permission');
  });

  it('drops a held idle when the plan exit ends before the marker is read', () => {
    ingest(planPermissionIdle, planToolEnd);
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS * 2);
    expect(harness.activities).not.toContain('permission');
  });

  it('drops a held idle with the session', () => {
    ingest(planPermissionIdle);
    harness.telemetry.removeSession(SESSION);
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS * 2);
    expect(harness.activities).not.toContain('permission');
  });

  describe('a tool the plan approval hook answers (task #870)', () => {
    // A third-party MCP tool with no read-only annotation: plan mode prompts
    // for it, and the hook answers when an allow rule names it. On Claude Code
    // 2.1.306 the approving hook started 5 to 114 ms after the catch-all one.
    const TOOL = 'mcp__docs__search';
    const toolStart = (toolId: string, subagentId?: string): SessionEvent =>
      ({ ts: 10, type: EventType.ToolStart, tool: TOOL, toolId, ...(subagentId ? { subagentId } : {}) });
    const toolEnd = (toolId: string, subagentId?: string): SessionEvent =>
      ({ ts: 12, type: EventType.ToolEnd, tool: TOOL, toolId, ...(subagentId ? { subagentId } : {}) });
    const toolIdle: SessionEvent = { ts: 11, type: EventType.Idle, detail: IdleReason.Permission, tool: TOOL };
    const toolMarker: SessionEvent = { ts: 11, type: EventType.ToolApprovalSent, tool: TOOL };

    it('drops the idle that arrives before the marker, once the tool ends', () => {
      ingest(toolStart('toolu_a'), toolIdle, toolMarker);
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS * 2);
      ingest(toolEnd('toolu_a'));
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS * 2);
      expect(harness.activities).not.toContain('permission');
      expect(harness.events.some((event) => event.type === EventType.Idle && event.detail === IdleReason.Permission)).toBe(false);
    });

    it('drops the idle that arrives after the marker', () => {
      ingest(toolStart('toolu_a'), toolMarker, toolIdle);
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS * 2);
      ingest(toolEnd('toolu_a'));
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS * 2);
      expect(harness.activities).not.toContain('permission');
    });

    it('drops an answered idle when the call fails, as the failure hook reports it', () => {
      ingest(toolStart('toolu_a'), toolIdle, toolMarker,
        { ts: 12, type: EventType.ToolEnd, tool: TOOL, toolId: 'toolu_a', detail: 'MCP error -32603: upstream timeout' });
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS * 2);
      expect(harness.activities).not.toContain('permission');
    });

    it('drops an answered idle when the call is interrupted', () => {
      ingest(toolStart('toolu_a'), toolIdle, toolMarker, { ts: 12, type: EventType.Interrupted, tool: TOOL, toolId: 'toolu_a' });
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS * 2);
      expect(harness.activities).not.toContain('permission');
    });

    it('lets the idle through after the wait when no marker comes, so a prompt the hook left alone shows', () => {
      ingest(toolStart('toolu_a'), toolIdle);
      expect(harness.activities).not.toContain('permission');
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS + 1);
      expect(harness.activities.at(-1)).toBe('permission');
    });

    it('lets an answered idle through within a minute when the tool never ends, as a prompt the CLI kept open', () => {
      ingest(toolStart('toolu_a'), toolIdle, toolMarker);
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS - 1);
      expect(harness.activities).not.toContain('permission');
      vi.advanceTimersByTime(2);
      expect(harness.activities.at(-1)).toBe('permission');
      expect(TOOL_APPROVAL_HOLD_MS).toBeLessThan(60_000);
    });

    it('pairs two waits on the same tool in order, a subagent\'s beside its parent\'s', () => {
      ingest(toolStart('toolu_main'), toolStart('toolu_sub', 'agent-1'), toolIdle, toolIdle, toolMarker, toolMarker);
      ingest(toolEnd('toolu_main'), toolEnd('toolu_sub', 'agent-1'));
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS * 2);
      expect(harness.activities).not.toContain('permission');
    });

    it('lets the second of two waits through when only the first is answered', () => {
      ingest(toolStart('toolu_main'), toolStart('toolu_sub', 'agent-1'), toolIdle, toolIdle, toolMarker);
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS + 1);
      expect(harness.activities.at(-1)).toBe('permission');
    });

    it('spends a marker that came before its idle only within its window', () => {
      ingest(toolStart('toolu_a'), toolMarker);
      vi.advanceTimersByTime(TOOL_APPROVAL_MARKER_WINDOW_MS + 1);
      ingest(toolIdle);
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS + 1);
      expect(harness.activities.at(-1)).toBe('permission');
    });

    it('holds nothing for a session whose decision leaves plans to the user', () => {
      harness.setApproves(false);
      ingest(toolStart('toolu_a'), toolIdle);
      expect(harness.activities.at(-1)).toBe('permission');
    });

    it('holds nothing for a tool the agent\'s hook never answers', () => {
      ingest(
        { ts: 10, type: EventType.ToolStart, tool: 'mcp__kangentic__kangentic_move_task', toolId: 'toolu_k' },
        { ts: 11, type: EventType.Idle, detail: IdleReason.Permission, tool: 'mcp__kangentic__kangentic_move_task' },
      );
      expect(harness.activities.at(-1)).toBe('permission');
    });

    it('drops a held tool idle with the agent\'s end, and holds nothing after it', () => {
      ingest(toolStart('toolu_a'), toolIdle);
      harness.telemetry.emitSessionEnd(SESSION);
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS * 2);
      expect(harness.activities).not.toContain('permission');
    });

    // Every permission idle that reached the rest of the pipeline. A held idle
    // is never in the log until it is released, so a late release shows here
    // even where the engine ignores it (an idle session, a removed one).
    const permissionIdles = (tool?: string): SessionEvent[] => harness.events.filter((event) =>
      event.type === EventType.Idle && event.detail === IdleReason.Permission && (tool === undefined || event.tool === tool));

    const OTHER_TOOL = 'mcp__docs__other';
    const otherToolStart: SessionEvent = { ts: 10, type: EventType.ToolStart, tool: OTHER_TOOL, toolId: 'toolu_other' };
    const otherToolIdle: SessionEvent = { ts: 11, type: EventType.Idle, detail: IdleReason.Permission, tool: OTHER_TOOL };

    const turnBoundaries: Array<[string, SessionEvent]> = [
      ['a Stop idle', { ts: 20, type: EventType.Idle }],
      ['a prompt', { ts: 20, type: EventType.Prompt }],
      ['a failed turn', { ts: 20, type: EventType.TurnFailed }],
      ['an interrupt that names no tool', { ts: 20, type: EventType.Interrupted }],
    ];

    it.each(turnBoundaries)('%s drops an idle the hook already answered', (_boundaryName, boundary) => {
      ingest(toolStart('toolu_a'), toolIdle, toolMarker, boundary);
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS * 2);
      expect(permissionIdles()).toHaveLength(0);
      expect(harness.activities).not.toContain('permission');
    });

    it.each(turnBoundaries)('%s drops an idle still waiting for its marker', (_boundaryName, boundary) => {
      ingest(toolStart('toolu_a'), toolIdle, boundary);
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS * 2);
      expect(permissionIdles()).toHaveLength(0);
      expect(harness.activities).not.toContain('permission');
    });

    it('drops a marker that came before its idle when the turn ends, so it cannot approve the next turn\'s idle', () => {
      ingest(toolStart('toolu_a'), toolMarker, { ts: 20, type: EventType.Idle });
      ingest({ ts: 21, type: EventType.Prompt }, toolStart('toolu_b'), toolIdle);
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS + 1);
      expect(permissionIdles(TOOL)).toHaveLength(1);
      expect(harness.activities.at(-1)).toBe('permission');
    });

    // Read lazily: `harness` is a fresh one per test.
    const sessionClears: Array<[string, () => void]> = [
      ['removing the session', () => harness.telemetry.removeSession(SESSION)],
      ['clearing its tracking', () => harness.telemetry.clearSessionTracking(SESSION)],
    ];

    it.each(sessionClears)('releases an idle still waiting for its marker nowhere after %s', (_clearName, clearSession) => {
      ingest(toolStart('toolu_a'), toolIdle);
      clearSession();
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS * 2);
      expect(permissionIdles()).toHaveLength(0);
      expect(harness.activities).not.toContain('permission');
    });

    it.each(sessionClears)('releases an answered idle nowhere after %s', (_clearName, clearSession) => {
      ingest(toolStart('toolu_a'), toolIdle, toolMarker);
      clearSession();
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS * 2);
      expect(permissionIdles()).toHaveLength(0);
      expect(harness.activities).not.toContain('permission');
    });

    it('holds an idle on a fresh marker even where the decision no longer approves plans', () => {
      ingest(toolStart('toolu_a'), toolMarker);
      harness.setApproves(false);
      ingest(toolIdle);
      // Past the marker wait: the idle waits for the ToolEnd, not for a marker.
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS * 2);
      expect(permissionIdles()).toHaveLength(0);
      ingest(toolEnd('toolu_a'));
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS * 2);
      expect(permissionIdles()).toHaveLength(0);
      expect(harness.activities).not.toContain('permission');
    });

    // Also pinned by 'holds nothing for a session whose decision leaves plans
    // to the user' above, here as the other half of the marker case.
    it('passes the idle at once where the decision does not approve plans and no marker came', () => {
      harness.setApproves(false);
      ingest(toolStart('toolu_a'), toolIdle);
      expect(permissionIdles(TOOL)).toHaveLength(1);
      expect(harness.activities.at(-1)).toBe('permission');
    });

    it('answers an idle of a tool with its own marker only, and keeps another tool\'s marker for its idle', () => {
      ingest(toolStart('toolu_a'), otherToolStart, toolMarker, otherToolIdle);
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS + 1);
      // The other tool's idle found no marker of its own: released after the wait.
      expect(permissionIdles(OTHER_TOOL)).toHaveLength(1);
      // The first tool's marker is still fresh, so its idle is held, not released.
      ingest(toolIdle);
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS * 2);
      expect(permissionIdles(TOOL)).toHaveLength(0);
      ingest(toolEnd('toolu_a'));
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS * 2);
      expect(permissionIdles(TOOL)).toHaveLength(0);
    });

    it('pairs two markers that came first with two idles of the same tool', () => {
      ingest(toolStart('toolu_main'), toolStart('toolu_sub', 'agent-1'), toolMarker, toolMarker, toolIdle, toolIdle);
      // Past the marker wait: neither idle waits for a marker any more.
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS * 2);
      expect(permissionIdles()).toHaveLength(0);
      ingest(toolEnd('toolu_main'), toolEnd('toolu_sub', 'agent-1'));
      vi.advanceTimersByTime(TOOL_APPROVAL_HOLD_MS * 2);
      expect(permissionIdles()).toHaveLength(0);
      expect(harness.activities).not.toContain('permission');
    });

    it('drops an idle whose prompt the user answered within the wait, with no marker', () => {
      ingest(toolStart('toolu_a'), toolIdle, toolEnd('toolu_a'));
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS * 2);
      expect(permissionIdles()).toHaveLength(0);
      expect(harness.activities).not.toContain('permission');
    });

    it('drops an idle still waiting for its marker when that tool\'s call is interrupted, and leaves another tool\'s wait alone', () => {
      ingest(toolStart('toolu_a'), otherToolStart, toolIdle, otherToolIdle);
      ingest({ ts: 12, type: EventType.Interrupted, tool: TOOL, toolId: 'toolu_a' });
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS + 1);
      // The interrupted tool's idle is gone; an interrupt that names a tool is
      // not a turn boundary, so the other tool's idle is still released late.
      expect(permissionIdles(TOOL)).toHaveLength(0);
      expect(permissionIdles(OTHER_TOOL)).toHaveLength(1);
    });

    it('passes a permission idle that names no tool at once', () => {
      ingest({ ts: 11, type: EventType.Idle, detail: IdleReason.Permission });
      expect(harness.activities.at(-1)).toBe('permission');
    });

    it('does not take a permission idle that names no tool for the end of a turn', () => {
      ingest(toolStart('toolu_a'), toolIdle, { ts: 12, type: EventType.Idle, detail: IdleReason.Permission });
      vi.advanceTimersByTime(TOOL_APPROVAL_WAIT_MS + 1);
      // The held idle is still held through it and is released after its wait.
      expect(permissionIdles(TOOL)).toHaveLength(1);
    });
  });

  // A real auto-approved plan, captured from a Claude Code 2.1.303 session in a
  // preview and sanitized: permission idle, marker 29 ms later, ExitPlanMode's
  // PostToolUse 143 ms after that. Replayed at its recorded gaps.
  it('replays a captured auto-approval without ever entering permission', () => {
    const replay = makeHarness();
    try {
      const captured = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'replay', 'session-033-plan-auto-approved.jsonl'), 'utf-8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SessionEvent);
      let previousTs = captured[0].ts;
      for (const event of captured) {
        vi.advanceTimersByTime(event.ts - previousTs);
        previousTs = event.ts;
        replay.telemetry.ingestEvents(SESSION, [event]);
      }
      vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS * 2);

      expect(captured.some((event) => event.type === EventType.Idle && event.detail === IdleReason.Permission)).toBe(true);
      expect(replay.activities).not.toContain('permission');
      const types = replay.events.map((event) => event.type);
      const planEnd = replay.events.findIndex((event) => event.type === EventType.ToolEnd && event.tool === AgentTool.ExitPlanMode);
      expect(types[planEnd + 1]).toBe(EventType.PlanAutoApproved);
      expect(replay.events[planEnd + 1].detail).toBe('Moved to Executing');
      expect(replay.turnStarts).toContain('plan-approval');
    } finally {
      replay.telemetry.dispose();
    }
  });
});
