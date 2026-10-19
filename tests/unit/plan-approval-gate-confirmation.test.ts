/**
 * The plan approval gate's CONFIRMATION rules (src/main/activity-engine/plan-approval-gate.ts),
 * driven through the real SessionTelemetry ingest like plan-approval-gate.test.ts.
 *
 * That file pins the happy path (idle, marker, ToolEnd never reads as "needs
 * you"). This one pins what keeps a REFUSED answer visible and what ends the
 * gate's hold:
 *
 * - the marker proves only that the answer was SENT, so it never drops a held
 *   idle on its own; only the plan exit's ToolEnd does. The marker restarts the
 *   hold, because the CLI acts on the answer after it;
 * - a marker is spent by the ToolEnd that pairs with it, or by an expired hold,
 *   and is stale after PLAN_APPROVAL_MARKER_WINDOW_MS;
 * - a session end (`emitSessionEnd`) drops a held idle and stops the gate
 *   holding, until the session's tracking is cleared or it is removed.
 *
 * `activities` is what the card, the desktop notifier and the phone push read,
 * so "reaches permission" here is "amber, Needs permission, push".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import {
  PLAN_APPROVAL_HOLD_MS,
  PLAN_APPROVAL_MARKER_WINDOW_MS,
} from '../../src/main/activity-engine/plan-approval-gate';
import { AgentTool, EventType, IdleReason } from '../../src/shared/types';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

const SESSION = 'session-plan-confirmation';

interface Harness {
  telemetry: SessionTelemetry;
  activities: ActivityState[];
  events: SessionEvent[];
  setApproves(approves: boolean): void;
}

function makeHarness(): Harness {
  let approves = true;
  const activities: ActivityState[] = [];
  const events: SessionEvent[] = [];
  const telemetry = new SessionTelemetry({
    onUsageChange: () => {},
    onActivityChange: (_sessionId, activity) => activities.push(activity),
    onEvent: (_sessionId, event) => events.push(event),
    onIdleTimeout: () => {},
    onPlanExit: () => {},
    onPRCandidate: () => {},
    requestSuspend: () => {},
    isSessionRunning: () => true,
    approvesPlanAutomatically: () => approves,
  }, {
    disableBgShellWatcher: true,
    activityEngineOptions: { idleStabilityWindowMs: 0, staleThinkingTimeoutMs: 600_000 },
  });
  telemetry.initSession(SESSION);
  return { telemetry, activities, events, setApproves: (value) => { approves = value; } };
}

const prompt: SessionEvent = { ts: 1, type: EventType.Prompt };
const planToolStart: SessionEvent = { ts: 2, type: EventType.ToolStart, tool: AgentTool.ExitPlanMode, toolId: 'toolu_plan' };
const planPermissionIdle: SessionEvent = { ts: 3, type: EventType.Idle, detail: IdleReason.Permission, tool: AgentTool.ExitPlanMode };
const marker: SessionEvent = { ts: 4, type: EventType.PlanApprovalSent, detail: 'Moved to Executing' };
const planToolEnd: SessionEvent = { ts: 5, type: EventType.ToolEnd, tool: AgentTool.ExitPlanMode, toolId: 'toolu_plan' };
const secondPlanToolEnd: SessionEvent = { ts: 6, type: EventType.ToolEnd, tool: AgentTool.ExitPlanMode, toolId: 'toolu_plan_second' };

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

function eventTypes(): string[] {
  return harness.events.map((event) => event.type);
}

function countOf(type: string): number {
  return eventTypes().filter((candidate) => candidate === type).length;
}

describe('plan approval gate, confirmation by the plan exit ToolEnd', () => {
  it('does not drop a held idle on the marker alone: an answer the CLI refused shows the dialog as needs you', () => {
    ingest(planPermissionIdle, marker);
    // No ToolEnd ever arrives. The marker must not have dropped the idle.
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS - 1);
    expect(harness.activities).not.toContain('permission');
    vi.advanceTimersByTime(2);
    expect(harness.activities.at(-1)).toBe('permission');
    expect(eventTypes()).toContain(EventType.Idle);
  });

  it('restarts the hold at the marker, so a ToolEnd inside the new hold still drops the idle', () => {
    ingest(planPermissionIdle);
    vi.advanceTimersByTime(1_900);
    ingest(marker);
    // 2050 ms after the idle: past the ORIGINAL hold, inside the one the marker re-armed.
    vi.advanceTimersByTime(150);
    expect(harness.activities).not.toContain('permission');
    ingest(planToolEnd);
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS * 2);
    expect(harness.activities).not.toContain('permission');
    expect(eventTypes()).not.toContain(EventType.Idle);
  });

  it('holds an idle that arrives after a fresh marker, and lets it through late when no ToolEnd comes', () => {
    ingest(marker, planPermissionIdle);
    expect(harness.activities).not.toContain('permission');
    expect(eventTypes()).not.toContain(EventType.Idle);
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS + 1);
    expect(harness.activities.at(-1)).toBe('permission');
  });

  it('drops an idle that arrived after a fresh marker when the ToolEnd comes inside the hold', () => {
    ingest(marker, planPermissionIdle);
    vi.advanceTimersByTime(150);
    ingest(planToolEnd);
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS * 2);
    expect(harness.activities).not.toContain('permission');
    expect(eventTypes()).not.toContain(EventType.Idle);
    // The marker was still unspent at the ToolEnd, so the approval is logged.
    expect(countOf(EventType.PlanAutoApproved)).toBe(1);
  });

  it('spends the marker when the hold expires: a manual approval of the second prompt logs no plan_auto_approved', () => {
    ingest(planPermissionIdle, marker);
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS + 1);
    expect(harness.activities.at(-1)).toBe('permission');
    // The user answers the prompt the CLI refused to take from the approver.
    ingest(planToolEnd);
    expect(eventTypes()).toContain(EventType.ToolEnd);
    expect(eventTypes()).not.toContain(EventType.PlanAutoApproved);
  });
});

describe('plan approval gate, marker freshness and single use', () => {
  it('lets a plan-exit idle straight through once the marker is older than the window', () => {
    harness.setApproves(false);
    ingest(marker);
    vi.advanceTimersByTime(PLAN_APPROVAL_MARKER_WINDOW_MS + 1_000);
    ingest(planPermissionIdle);
    // At once, with no timer involved.
    expect(harness.activities.at(-1)).toBe('permission');
    expect(eventTypes()).toContain(EventType.Idle);
    ingest(planToolEnd);
    expect(eventTypes()).not.toContain(EventType.PlanAutoApproved);
  });

  it('writes no plan_auto_approved for a ToolEnd that arrives after the marker went stale', () => {
    ingest(marker);
    vi.advanceTimersByTime(PLAN_APPROVAL_MARKER_WINDOW_MS + 1_000);
    ingest(planToolEnd);
    expect(eventTypes()).toContain(EventType.ToolEnd);
    expect(eventTypes()).not.toContain(EventType.PlanAutoApproved);
  });

  it('still holds an idle when the marker is inside the window, even for a session that leaves plans to the user', () => {
    harness.setApproves(false);
    ingest(marker);
    vi.advanceTimersByTime(PLAN_APPROVAL_MARKER_WINDOW_MS - 1_000);
    ingest(planPermissionIdle);
    expect(harness.activities).not.toContain('permission');
  });

  it('consumes the marker once: a second plan exit ToolEnd logs no second plan_auto_approved', () => {
    ingest(marker, planToolEnd);
    expect(countOf(EventType.PlanAutoApproved)).toBe(1);
    ingest(secondPlanToolEnd);
    expect(countOf(EventType.ToolEnd)).toBe(2);
    expect(countOf(EventType.PlanAutoApproved)).toBe(1);
  });
});

describe('plan approval gate, session end', () => {
  it('drops a held idle when the session ends, so nothing is released after session_end', () => {
    ingest(planPermissionIdle);
    harness.telemetry.emitSessionEnd(SESSION);
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS * 2);
    expect(harness.activities).not.toContain('permission');
    expect(eventTypes()).toContain(EventType.SessionEnd);
    const sessionEndIndex = eventTypes().indexOf(EventType.SessionEnd);
    expect(eventTypes().slice(sessionEndIndex + 1)).not.toContain(EventType.Idle);
    expect(eventTypes()).not.toContain(EventType.Idle);
  });

  it('holds nothing after the session ended: the exit flush idle is processed at once, not two seconds later', () => {
    harness.telemetry.emitSessionEnd(SESSION);
    const eventsBeforeIdle = harness.events.length;
    ingest(planPermissionIdle);
    // Emitted by the ingest itself, with no timer advanced.
    expect(harness.events.slice(eventsBeforeIdle).map((event) => event.type)).toEqual([EventType.Idle]);
    // And no second, late copy from a timer.
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS * 2);
    expect(countOf(EventType.Idle)).toBe(1);
  });

  it('ends the gate even when the session_end event is already last in the log', () => {
    harness.telemetry.emitSessionEnd(SESSION);
    // Clearing tracking forgets the ended mark but keeps the event log, so the
    // log still ends in session_end and the next emitSessionEnd returns early.
    harness.telemetry.clearSessionTracking(SESSION);
    ingest(planPermissionIdle);
    expect(eventTypes().at(-1)).toBe(EventType.SessionEnd);
    harness.telemetry.emitSessionEnd(SESSION);
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS * 2);
    expect(countOf(EventType.SessionEnd)).toBe(1);
    expect(eventTypes()).not.toContain(EventType.Idle);
  });

  it('forgets the ended mark on clearSessionTracking: a resumed session holds a plan-exit idle again', () => {
    harness.telemetry.emitSessionEnd(SESSION);
    harness.telemetry.clearSessionTracking(SESSION);
    harness.telemetry.initSession(SESSION);
    ingest(prompt, planToolStart);
    harness.activities.length = 0;

    ingest(planPermissionIdle);
    expect(harness.activities).not.toContain('permission');
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS + 1);
    expect(harness.activities.at(-1)).toBe('permission');
  });

  it('forgets the ended mark on removeSession: a session recreated under the same id holds a plan-exit idle again', () => {
    harness.telemetry.emitSessionEnd(SESSION);
    harness.telemetry.removeSession(SESSION);
    harness.telemetry.initSession(SESSION);
    ingest(prompt, planToolStart);
    harness.activities.length = 0;

    ingest(planPermissionIdle);
    expect(harness.activities).not.toContain('permission');
    vi.advanceTimersByTime(PLAN_APPROVAL_HOLD_MS + 1);
    expect(harness.activities.at(-1)).toBe('permission');
  });
});
