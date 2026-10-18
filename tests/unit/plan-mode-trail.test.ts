/**
 * The plan-mode trail (src/main/activity-engine/plan-mode-trail.ts): what a
 * session's agent last reported about plan mode at a past moment.
 *
 * The turn-end runner asks it about the moment a task was dragged into its
 * column's plan exit target (kangentic-mobile #119). A drag made once the agent had left plan
 * mode is the plan exit and the turn's rows run; a drag made while it was still
 * planning, or by a session that never reported a mode, stays carried in. So
 * "left by" needs a plan report, then an out-of-plan report, at or before the
 * moment, and an unknown mode answers no.
 *
 * The pure trail first, then its wiring through `SessionTelemetry.ingestEvents`,
 * which stamps the ingest clock (the app's, which the move's own stamp is on)
 * and never `event.ts` (the agent host's, which a WSL guest lets drift).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlanModeTrail } from '../../src/main/activity-engine/plan-mode-trail';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

const SESSION_ID = 'session-1';

function report(planMode: boolean | undefined, type: EventType = EventType.Prompt): SessionEvent {
  return planMode === undefined ? { ts: 0, type } : { ts: 0, type, planMode };
}

describe('PlanModeTrail', () => {
  let trail: PlanModeTrail;

  beforeEach(() => {
    trail = new PlanModeTrail();
  });

  it('reports left by a moment after a plan report and then an out-of-plan one', () => {
    trail.note(SESSION_ID, report(true), 1_000);
    trail.note(SESSION_ID, report(false, EventType.Idle), 2_000);

    expect(trail.hadLeftPlanModeBy(SESSION_ID, 2_000)).toBe(true);
    expect(trail.hadLeftPlanModeBy(SESSION_ID, 5_000)).toBe(true);
  });

  it('does not report left by a moment before the out-of-plan report', () => {
    trail.note(SESSION_ID, report(true), 1_000);
    trail.note(SESSION_ID, report(false), 2_000);

    expect(trail.hadLeftPlanModeBy(SESSION_ID, 1_999)).toBe(false);
    expect(trail.hadLeftPlanModeBy(SESSION_ID, 500)).toBe(false);
  });

  it('does not report left for a session never reported in plan mode', () => {
    trail.note(SESSION_ID, report(false), 1_000);
    trail.note(SESSION_ID, report(false), 2_000);

    expect(trail.hadLeftPlanModeBy(SESSION_ID, 5_000)).toBe(false);
  });

  it('does not report left for a session that reported no mode at all', () => {
    trail.note(SESSION_ID, report(undefined), 1_000);

    expect(trail.hadLeftPlanModeBy(SESSION_ID, 5_000)).toBe(false);
    expect(trail.hadLeftPlanModeBy('unknown-session', 5_000)).toBe(false);
  });

  it('does not report left once plan mode was entered again by the moment', () => {
    trail.note(SESSION_ID, report(true), 1_000);
    trail.note(SESSION_ID, report(false), 2_000);
    trail.note(SESSION_ID, report(true), 3_000);

    expect(trail.hadLeftPlanModeBy(SESSION_ID, 2_500)).toBe(true);
    expect(trail.hadLeftPlanModeBy(SESSION_ID, 3_500)).toBe(false);
  });

  it('keeps the first report of a run of equal ones, so a repeat does not move the change', () => {
    trail.note(SESSION_ID, report(true), 1_000);
    trail.note(SESSION_ID, report(false), 2_000);
    trail.note(SESSION_ID, report(false), 9_000);

    expect(trail.hadLeftPlanModeBy(SESSION_ID, 2_500)).toBe(true);
  });

  it('still answers after a long run of changes is cut to its newest', () => {
    for (let index = 0; index < 100; index += 1) trail.note(SESSION_ID, report(index % 2 === 0), index * 1_000);

    // The last change, at 99 s, left plan mode.
    expect(trail.hadLeftPlanModeBy(SESSION_ID, 99_500)).toBe(true);
    expect(trail.hadLeftPlanModeBy(SESSION_ID, 98_500)).toBe(false);
  });

  it('keeps only the newest changes, so a moment before the oldest one kept answers no', () => {
    for (let index = 0; index < 100; index += 1) trail.note(SESSION_ID, report(index % 2 === 0), index * 1_000);

    // The full history would say yes: by 11 s the last report (index 11) is out of plan mode,
    // after the plan report at index 10. The cap of 32 cuts everything before the change at 68 s,
    // so no kept change is at or before 11.5 s and the trail has nothing to answer from.
    expect(trail.hadLeftPlanModeBy(SESSION_ID, 11_500)).toBe(false);
    expect(trail.hadLeftPlanModeBy(SESSION_ID, 67_500)).toBe(false);
    // The newest changes are all kept: the one at 99 s left plan mode after the plan report at 98 s.
    expect(trail.hadLeftPlanModeBy(SESSION_ID, 99_500)).toBe(true);
  });

  it('forgets a removed session', () => {
    trail.note(SESSION_ID, report(true), 1_000);
    trail.note(SESSION_ID, report(false), 2_000);

    trail.removeSession(SESSION_ID);

    expect(trail.hadLeftPlanModeBy(SESSION_ID, 5_000)).toBe(false);
  });
});

describe('SessionTelemetry and the plan-mode trail', () => {
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    telemetry = new SessionTelemetry(
      {
        onUsageChange: (): void => {},
        onActivityChange: (): void => {},
        onEvent: (): void => {},
        onIdleTimeout: (): void => {},
        onPlanExit: (): void => {},
        onPRCandidate: (): void => {},
        requestSuspend: (): void => {},
        isSessionRunning: (): boolean => true,
      },
      { disableBgShellWatcher: true },
    );
    telemetry.initSession(SESSION_ID);
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('stamps each report with the ingest clock, never the event\'s own ts', () => {
    vi.setSystemTime(10_000);
    // A host clock minutes ahead of the app's, as a WSL guest's can be.
    telemetry.ingestEvents(SESSION_ID, [{ ts: 10_000 + 600_000, type: EventType.Prompt, planMode: true }]);
    vi.setSystemTime(20_000);
    telemetry.ingestEvents(SESSION_ID, [{ ts: 20_000 + 600_000, type: EventType.Idle, planMode: false }]);

    expect(telemetry.hadLeftPlanModeBy(SESSION_ID, 20_000)).toBe(true);
    expect(telemetry.hadLeftPlanModeBy(SESSION_ID, 19_999)).toBe(false);
  });

  it('drops the trail when the session is suspended, so a resume reports afresh', () => {
    vi.setSystemTime(10_000);
    telemetry.ingestEvents(SESSION_ID, [{ ts: 0, type: EventType.Prompt, planMode: true }]);
    telemetry.ingestEvents(SESSION_ID, [{ ts: 0, type: EventType.Idle, planMode: false }]);
    expect(telemetry.hadLeftPlanModeBy(SESSION_ID, 10_000)).toBe(true);

    telemetry.clearSessionTracking(SESSION_ID);

    expect(telemetry.hadLeftPlanModeBy(SESSION_ID, 10_000)).toBe(false);
  });

  it('drops the trail when the session is removed', () => {
    vi.setSystemTime(10_000);
    telemetry.ingestEvents(SESSION_ID, [{ ts: 0, type: EventType.Prompt, planMode: true }]);
    telemetry.ingestEvents(SESSION_ID, [{ ts: 0, type: EventType.Idle, planMode: false }]);

    telemetry.removeSession(SESSION_ID);

    expect(telemetry.hadLeftPlanModeBy(SESSION_ID, 10_000)).toBe(false);
  });
});

describe('SessionTelemetry and the plan-mode trail', () => {
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    telemetry = new SessionTelemetry(
      {
        onUsageChange: (): void => {},
        onActivityChange: (): void => {},
        onEvent: (): void => {},
        onIdleTimeout: (): void => {},
        onPlanExit: (): void => {},
        onPRCandidate: (): void => {},
        requestSuspend: (): void => {},
        isSessionRunning: (): boolean => true,
      },
      { disableBgShellWatcher: true },
    );
    telemetry.initSession(SESSION_ID);
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('stamps each report with the ingest clock, never the event\'s own ts', () => {
    vi.setSystemTime(10_000);
    // A host clock minutes ahead of the app's, as a WSL guest's can be.
    telemetry.ingestEvents(SESSION_ID, [{ ts: 10_000 + 600_000, type: EventType.Prompt, planMode: true }]);
    vi.setSystemTime(20_000);
    telemetry.ingestEvents(SESSION_ID, [{ ts: 20_000 + 600_000, type: EventType.Idle, planMode: false }]);

    expect(telemetry.hadLeftPlanModeBy(SESSION_ID, 20_000)).toBe(true);
    expect(telemetry.hadLeftPlanModeBy(SESSION_ID, 19_999)).toBe(false);
  });

  it('drops the trail when the session is suspended, so a resume reports afresh', () => {
    vi.setSystemTime(10_000);
    telemetry.ingestEvents(SESSION_ID, [{ ts: 0, type: EventType.Prompt, planMode: true }]);
    telemetry.ingestEvents(SESSION_ID, [{ ts: 0, type: EventType.Idle, planMode: false }]);
    expect(telemetry.hadLeftPlanModeBy(SESSION_ID, 10_000)).toBe(true);

    telemetry.clearSessionTracking(SESSION_ID);

    expect(telemetry.hadLeftPlanModeBy(SESSION_ID, 10_000)).toBe(false);
  });

  it('drops the trail when the session is removed', () => {
    vi.setSystemTime(10_000);
    telemetry.ingestEvents(SESSION_ID, [{ ts: 0, type: EventType.Prompt, planMode: true }]);
    telemetry.ingestEvents(SESSION_ID, [{ ts: 0, type: EventType.Idle, planMode: false }]);

    telemetry.removeSession(SESSION_ID);

    expect(telemetry.hadLeftPlanModeBy(SESSION_ID, 10_000)).toBe(false);
  });
});
