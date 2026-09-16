/**
 * Unit tests for `SessionTelemetry.getActivityReasonsCache()`.
 *
 * The method iterates `activityEngine.forEachState` and calls
 * `engine.getActivityReason(sessionId)` per session, building a
 * `Record<string, ActivityReason>` for the renderer's HMR / full-reload
 * reconcile path. Tests verify:
 *   - Empty engine returns `{}`.
 *   - Sessions with null reasons are excluded.
 *   - Multi-session snapshots round-trip distinct reason kinds.
 *
 * Drives the real SessionTelemetry + ActivityEngine via `processEvent` so
 * the integration between them is exercised end-to-end. The bg-shell
 * watcher is disabled so we don't need a process-tree probe here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { SessionTelemetryOptions } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';
import type { ActivityState, ActivityReason, SessionUsage, SessionEvent } from '../../src/shared/types';

interface PushLog {
  activityChanges: Array<{ activity: ActivityState; reason: ActivityReason }>;
  reasonChanges: Array<{ activity: ActivityState; reason: ActivityReason }>;
}

function makeCallbacks(log?: PushLog) {
  return {
    onUsageChange: (_sessionId: string, _usage: SessionUsage): void => {},
    onActivityChange: (_sessionId: string, activity: ActivityState, reason: ActivityReason): void => {
      log?.activityChanges.push({ activity, reason });
    },
    onReasonChange: (_sessionId: string, activity: ActivityState, reason: ActivityReason): void => {
      log?.reasonChanges.push({ activity, reason });
    },
    onEvent: (_sessionId: string, _event: SessionEvent): void => {},
    onIdleTimeout: (_sessionId: string): void => {},
    onPlanExit: (_sessionId: string): void => {},
    onPRCandidate: (_sessionId: string): void => {},
    requestSuspend: (_sessionId: string): void => {},
    isSessionRunning: (_sessionId: string): boolean => true,
  };
}

let telemetry: SessionTelemetry;

beforeEach(() => {
  const options: SessionTelemetryOptions = {
    disableBgShellWatcher: true,
    activityEngineOptions: {
      bgShellEscapeHatchMs: 60_000,
      staleThinkingTimeoutMs: 60_000,
      idleStabilityWindowMs: 0,
    },
  };
  telemetry = new SessionTelemetry(makeCallbacks(), options);
});

afterEach(() => {
  telemetry.dispose();
});

describe('SessionTelemetry.getActivityReasonsCache', () => {
  it('returns an empty object when the engine has no sessions', () => {
    expect(telemetry.getActivityReasonsCache()).toEqual({});
  });

  it('returns the reason for a single initialized session (kind: idle)', () => {
    telemetry.initSession('s1');
    const cache = telemetry.getActivityReasonsCache();
    expect(cache['s1']).toBeDefined();
    expect(cache['s1'].kind).toBe('idle');
  });

  it('reflects turn-active state after a thinking event', () => {
    telemetry.initSession('s1');
    telemetry.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Prompt }]);
    const cache = telemetry.getActivityReasonsCache();
    expect(cache['s1']).toBeDefined();
    expect(cache['s1'].kind).toBe('turn-active');
  });

  it('reflects tool reason while a tool is in flight', () => {
    telemetry.initSession('s1');
    telemetry.ingestEvents('s1', [
      { ts: Date.now(), type: EventType.ToolStart, tool: 'Read', detail: 'file.ts' },
    ]);
    const cache = telemetry.getActivityReasonsCache();
    expect(cache['s1']).toBeDefined();
    expect(cache['s1'].kind).toBe('tool');
  });

  it('reflects background-shell reason while a bg shell is tracked', () => {
    telemetry.initSession('s1');
    telemetry.ingestEvents('s1', [
      { ts: Date.now(), type: EventType.BackgroundShellStart, detail: 'bash_1' },
    ]);
    const cache = telemetry.getActivityReasonsCache();
    expect(cache['s1']).toBeDefined();
    expect(cache['s1'].kind).toBe('background-shell');
  });

  it('round-trips three sessions with distinct reason kinds', () => {
    telemetry.initSession('s-tool');
    telemetry.initSession('s-bg');
    telemetry.initSession('s-idle');

    telemetry.ingestEvents('s-tool', [
      { ts: Date.now(), type: EventType.ToolStart, tool: 'Read', detail: 'file.ts' },
    ]);
    telemetry.ingestEvents('s-bg', [
      { ts: Date.now(), type: EventType.BackgroundShellStart, detail: 'bash_x' },
    ]);
    // s-idle stays in the default idle state.

    const cache = telemetry.getActivityReasonsCache();
    expect(Object.keys(cache).sort()).toEqual(['s-bg', 's-idle', 's-tool']);
    expect(cache['s-tool'].kind).toBe('tool');
    expect(cache['s-bg'].kind).toBe('background-shell');
    expect(cache['s-idle'].kind).toBe('idle');
  });

  it('excludes sessions removed via removeSession', () => {
    telemetry.initSession('s1');
    telemetry.initSession('s2');
    expect(Object.keys(telemetry.getActivityReasonsCache()).sort()).toEqual(['s1', 's2']);

    telemetry.removeSession('s1');
    expect(Object.keys(telemetry.getActivityReasonsCache())).toEqual(['s2']);
  });
});

describe('SessionTelemetry forwards a reason-only refresh', () => {
  // The engine's own replay coverage proves it DERIVES the right reason; this
  // proves the derived reason survives the hop out of telemetry, which is the
  // link that decides whether anything downstream ever sees it. It also pins the
  // split: a reason refresh must not arrive as an activity change, because the
  // interval recorder and the desktop notifier both read that as a transition.
  let log: PushLog;
  let instance: SessionTelemetry;

  beforeEach(() => {
    log = { activityChanges: [], reasonChanges: [] };
    instance = new SessionTelemetry(makeCallbacks(log), {
      disableBgShellWatcher: true,
      activityEngineOptions: {
        bgShellEscapeHatchMs: 60_000,
        staleThinkingTimeoutMs: 60_000,
        idleStabilityWindowMs: 0,
      },
    });
  });

  afterEach(() => {
    instance.dispose();
  });

  it('reports a reason that moves mid-turn, with the activity unchanged', () => {
    instance.initSession('s-turn');
    log.activityChanges.length = 0;
    log.reasonChanges.length = 0;

    const now = Date.now();
    instance.ingestEvents('s-turn', [
      { ts: now, type: EventType.Prompt },
      { ts: now + 1, type: EventType.ToolStart, tool: 'Read', toolId: 't1' },
      { ts: now + 2, type: EventType.ToolEnd, tool: 'Read', toolId: 't1' },
      { ts: now + 3, type: EventType.SubagentStart, detail: 'review-finder' },
    ]);

    const kinds = log.reasonChanges.map((entry) => entry.reason.kind);
    expect(kinds).toContain('tool');
    expect(kinds).toContain('subagent');
    // The session never left `thinking`, so nothing here is an activity change:
    // before this existed, the whole turn reported one 'turn-active' and stopped.
    expect(log.activityChanges.map((entry) => entry.activity)).toEqual(['thinking']);
    expect(log.reasonChanges.every((entry) => entry.activity === 'thinking')).toBe(true);
  });

  it('does not report again when only the tool churns under an unchanged kind', () => {
    instance.initSession('s-churn');
    const now = Date.now();
    instance.ingestEvents('s-churn', [
      { ts: now, type: EventType.Prompt },
      { ts: now + 1, type: EventType.ToolStart, tool: 'Read', toolId: 'a' },
    ]);
    const settled = log.reasonChanges.length;

    // Three more tools in flight. Each moves `currentTool` and `pendingCount`
    // and nothing else, so a deep-equal gate would report on all three.
    instance.ingestEvents('s-churn', [
      { ts: now + 2, type: EventType.ToolStart, tool: 'Grep', toolId: 'b' },
      { ts: now + 3, type: EventType.ToolStart, tool: 'Glob', toolId: 'c' },
      { ts: now + 4, type: EventType.ToolStart, tool: 'Bash', toolId: 'd' },
    ]);

    expect(log.reasonChanges.length - settled).toBe(0);
  });
});
