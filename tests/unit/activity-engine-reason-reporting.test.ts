/**
 * Coverage for two holes in the activity engine's reason-reporting path
 * (`SessionEngineState.lastPushedReason` and `ActivityEngineCallbacks.onReasonChange`).
 *
 * Hole 1 pins that `commitTransition`'s real-transition branch writes
 * `state.lastPushedReason` (`src/main/activity-engine/engine/activity-engine.ts`),
 * not just `reportReasonIfChanged`'s own no-transition branch. Without that write,
 * the very next reason-only check compares against a stale baseline and re-reports
 * a reason kind that `onActivityChange` just delivered.
 *
 * Hole 2 pins that a reason-only refresh (`SessionTelemetry`'s `onReasonChange`
 * wiring, `src/main/activity-engine/session-telemetry.ts`) skips the synchronous
 * debug-snapshot write that a real activity transition performs. See that file's
 * `onReasonChange` handler comment for why the omission is deliberate.
 *
 * Deliberately a NEW file, not an extension of `activity-engine-replay.test.ts` or
 * `session-telemetry-activity-reasons.test.ts`: both hold another agent's
 * uncommitted in-flight work in this worktree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';
import type { ActivityState, ActivityReason, SessionUsage, SessionEvent } from '../../src/shared/types';

const SESSION_ID = 'reason-reporting-session';

describe('ActivityEngine: commitTransition seeds lastPushedReason for the reason-only path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never re-reports the kind a real transition just delivered, and reports the kind that later genuinely changes', () => {
    const activityChanges: ActivityState[] = [];
    const reasonReportKinds: Array<ActivityReason['kind']> = [];

    const engine = new ActivityEngine(
      {
        onActivityChange(_sessionId, activity) {
          activityChanges.push(activity);
        },
        onReasonChange(_sessionId, _activity, reason) {
          reasonReportKinds.push(reason.kind);
        },
      },
      {
        idleStabilityWindowMs: 0,
        staleThinkingTimeoutMs: 60_000,
        bgShellEscapeHatchMs: 60_000,
      },
    );

    engine.initSession(SESSION_ID);
    const startTimestamp = Date.now();

    // Real transition idle -> thinking, delivered via onActivityChange with
    // reason kind 'tool' (one pending tool). This is where commitTransition's
    // real-transition branch must seed lastPushedReason.
    engine.processEvent(SESSION_ID, {
      ts: startTimestamp,
      type: EventType.ToolStart,
      tool: 'Read',
      toolId: 'toolCallOne',
    });

    // A second concurrent tool: no activity transition (already thinking), and
    // the derived reason kind stays 'tool' (still pendingToolCount > 0). If
    // lastPushedReason was not seeded by the transition above, this compares
    // against the stale pre-transition baseline and wrongly re-reports 'tool'.
    engine.processEvent(SESSION_ID, {
      ts: startTimestamp + 1,
      type: EventType.ToolStart,
      tool: 'Grep',
      toolId: 'toolCallTwo',
    });

    // First tool completes: pendingToolCount drops to 1, reason kind stays
    // 'tool'. Still no report expected.
    engine.processEvent(SESSION_ID, {
      ts: startTimestamp + 2,
      type: EventType.ToolEnd,
      tool: 'Read',
      toolId: 'toolCallOne',
    });

    // Second tool completes: pendingToolCount drops to 0, so the reason kind
    // genuinely moves from 'tool' to 'turn-active' (turnActive is now the sole
    // holder). This is the one legitimate report in the whole sequence.
    engine.processEvent(SESSION_ID, {
      ts: startTimestamp + 3,
      type: EventType.ToolEnd,
      tool: 'Grep',
      toolId: 'toolCallTwo',
    });

    engine.dispose();

    // Only the seeded idle activity and the single real transition to
    // thinking occurred; nothing else changed activity.
    expect(activityChanges).toEqual(['idle', 'thinking']);
    // Exactly one reason-only report, and it is the genuinely new kind - not a
    // duplicate of the 'tool' kind the transition above already delivered.
    expect(reasonReportKinds).toEqual(['turn-active']);
  });
});

interface ReasonOnlyLog {
  reasonReports: ActivityReason[];
}

function makeTelemetryCallbacks(log: ReasonOnlyLog) {
  return {
    onUsageChange: (_sessionId: string, _usage: SessionUsage): void => {},
    onActivityChange: (_sessionId: string, _activity: ActivityState, _reason: ActivityReason): void => {},
    onReasonChange: (_sessionId: string, _activity: ActivityState, reason: ActivityReason): void => {
      log.reasonReports.push(reason);
    },
    onEvent: (_sessionId: string, _event: SessionEvent): void => {},
    onIdleTimeout: (_sessionId: string): void => {},
    onPlanExit: (_sessionId: string): void => {},
    onPRCandidate: (_sessionId: string): void => {},
    requestSuspend: (_sessionId: string): void => {},
    isSessionRunning: (_sessionId: string): boolean => true,
  };
}

describe('SessionTelemetry: a reason-only refresh skips the debug-snapshot write', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not resolve the debug-dump directory for reason-only reports, but does for a real transition', () => {
    let debugDumpDirResolverCallCount = 0;
    const log: ReasonOnlyLog = { reasonReports: [] };

    const telemetry = new SessionTelemetry(makeTelemetryCallbacks(log), {
      disableBgShellWatcher: true,
      // `writeDebugSnapshot` (private, called only from the onActivityChange
      // wrapper) resolves this exactly once per invocation, before checking
      // whether a writer exists - so counting resolver calls counts
      // writeDebugSnapshot calls without touching the filesystem or reaching
      // into private internals. Returning undefined keeps this a pure counter:
      // no directory is ever configured, so no disk write happens either way.
      debugDumpDir: () => {
        debugDumpDirResolverCallCount += 1;
        return undefined;
      },
      activityEngineOptions: {
        bgShellEscapeHatchMs: 60_000,
        staleThinkingTimeoutMs: 60_000,
        idleStabilityWindowMs: 0,
      },
    });

    telemetry.initSession('s-reason-only-cost');
    const baselineResolverCallCount = debugDumpDirResolverCallCount;

    const startTimestamp = Date.now();

    // A real activity transition (idle -> thinking): must perform the
    // debug-snapshot write.
    telemetry.ingestEvents('s-reason-only-cost', [
      { ts: startTimestamp, type: EventType.Prompt },
    ]);
    expect(debugDumpDirResolverCallCount).toBe(baselineResolverCallCount + 1);

    const resolverCallCountAfterTransition = debugDumpDirResolverCallCount;

    // Three reason-only churns while the activity stays 'thinking' the whole
    // time (turn-active -> tool -> turn-active -> subagent). None of these is
    // an activity transition.
    telemetry.ingestEvents('s-reason-only-cost', [
      { ts: startTimestamp + 1, type: EventType.ToolStart, tool: 'Read', toolId: 'toolCallOne' },
      { ts: startTimestamp + 2, type: EventType.ToolEnd, tool: 'Read', toolId: 'toolCallOne' },
      { ts: startTimestamp + 3, type: EventType.SubagentStart, detail: 'review-finder' },
    ]);

    // The reason-only path did fire (otherwise the count-stayed-flat assertion
    // below would be vacuously true).
    expect(log.reasonReports.length).toBeGreaterThan(0);
    // But none of those reports resolved the debug-dump directory: the
    // snapshot write is onActivityChange's cost alone.
    expect(debugDumpDirResolverCallCount).toBe(resolverCallCountAfterTransition);

    telemetry.dispose();
  });
});

/**
 * The permission-poll bookkeeping half of Hole 2 (`SessionTelemetry`'s
 * `permissionPendingSessions` add/delete and poll start/stop, also gated on
 * `onActivityChange` alone) has no equivalent test here. It is not merely hard
 * to reach - it is unreachable by construction, so no assertion could ever
 * observe a regression:
 *
 * `deriveReasonForActivity` (`src/main/activity-engine/engine/predicate.ts`)
 * returns `{ kind: 'permission' }` UNCONDITIONALLY whenever `activity ===
 * 'permission'`. `reportReasonIfChanged` only invokes `onReasonChange` when the
 * derived kind differs from `lastPushedReason.kind`. Since 'permission' is the
 * only kind `activity === 'permission'` can ever produce, the first time
 * `lastPushedReason.kind` becomes 'permission' (always via a real transition,
 * through `onActivityChange`), every later same-activity check for that
 * session derives the same 'permission' kind and the comparison always shorts
 * out before the callback fires. So `onReasonChange` can never be called with
 * `activity === 'permission'` - even a mutation that copies the permission
 * add/delete bookkeeping verbatim into the `onReasonChange` wrapper would be
 * dead code with no reachable input to trigger it. A test asserting "this
 * never happens" here would pass unconditionally and prove nothing.
 */
