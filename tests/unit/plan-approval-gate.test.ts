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
 *
 * `onActivityChange` is what the desktop notifier, the phone's push notifier
 * and the card all read, so "never enters permission" here is "no amber, no
 * Needs permission, no push".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { PLAN_APPROVAL_HOLD_MS } from '../../src/main/activity-engine/plan-approval-gate';
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
