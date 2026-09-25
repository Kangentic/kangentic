/**
 * Wiring tests for the permission-rejection poll (task #640):
 * `SessionTelemetry` lazily starts/stops a poll interval that asks the
 * agent adapter (via `reportRejectedPermissionTools`) whether a session's
 * awaited permission prompt was manually denied, and forwards a match into
 * `ActivityEngine.markPermissionRejected`.
 *
 * The interval is lazy - it must start the instant a session enters
 * `permission` and stop the instant none remain, matching the existing
 * "watcher polling stops entirely when the last session is cleared"
 * invariant in `session-telemetry-wiring.test.ts` (a flat always-on interval
 * was tried first and broke that `vi.getTimerCount()` assertion).
 *
 * Test tier: Unit (vitest, no browser, no Electron). The bg-shell watcher is
 * disabled throughout - it is unrelated to this feature and would add noise
 * to the timer-count assertions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType, IdleReason } from '../../src/shared/types';
import type { ActivityState, ActivityReason, SessionUsage, SessionEvent } from '../../src/shared/types';

const POLL_MS = 2_000;

interface CallbackLog {
  activityChanges: Array<{ sessionId: string; activity: ActivityState; reason: ActivityReason }>;
}

function makeTelemetry(options: {
  log: CallbackLog;
  reportRejectedPermissionTools?: (sessionId: string, toolIds: string[], sinceMs: number) => string[];
  isSessionRunning?: (sessionId: string) => boolean;
}): SessionTelemetry {
  return new SessionTelemetry(
    {
      onUsageChange: (_sessionId: string, _usage: SessionUsage): void => {},
      onActivityChange: (sessionId, activity, reason) => {
        options.log.activityChanges.push({ sessionId, activity, reason });
      },
      onEvent: (_sessionId: string, _event: SessionEvent): void => {},
      onIdleTimeout: (_sessionId: string): void => {},
      onPlanExit: (_sessionId: string): void => {},
      onPRCandidate: (_sessionId: string): void => {},
      requestSuspend: (_sessionId: string): void => {},
      isSessionRunning: options.isSessionRunning ?? ((_sessionId: string): boolean => true),
      reportRejectedPermissionTools: options.reportRejectedPermissionTools,
    },
    {
      disableBgShellWatcher: true,
      activityEngineOptions: {
        idleStabilityWindowMs: 0,
      },
    },
  );
}

/** Drive a session to `permission` with a tracked awaited toolId. */
function raisePermissionPrompt(telemetry: SessionTelemetry, sessionId: string, toolId: string): void {
  telemetry.initSession(sessionId);
  telemetry.ingestEvents(sessionId, [
    { ts: Date.now(), type: EventType.ToolStart, tool: 'Write', toolId },
    { ts: Date.now(), type: EventType.Idle, detail: IdleReason.Permission },
  ]);
}

describe('SessionTelemetry: permission-rejection poll (task #640)', () => {
  let log: CallbackLog;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    log = { activityChanges: [] };
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  it('does not start any timer while no session is awaiting a decision', () => {
    telemetry = makeTelemetry({ log, reportRejectedPermissionTools: () => [] });
    telemetry.initSession('s1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the poll interval the moment a session enters permission', () => {
    telemetry = makeTelemetry({ log, reportRejectedPermissionTools: () => [] });
    raisePermissionPrompt(telemetry, 's1', 'tool-awaited');
    expect(telemetry.activityEngine.getState('s1')?.activity).toBe('permission');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops asking about a session once it leaves permission via the normal approved-tool path', () => {
    // Once 's1' resumes to 'thinking' the engine arms its OWN internal
    // stale-thinking watchdog timer for that live session (unrelated to this
    // feature), so a global vi.getTimerCount() check would not isolate the
    // permission-poll interval here. Assert the functional behavior instead:
    // no further reportRejectedPermissionTools calls for a session that is
    // no longer awaiting anything.
    const calls: string[] = [];
    telemetry = makeTelemetry({
      log,
      reportRejectedPermissionTools: (sessionId) => {
        calls.push(sessionId);
        return [];
      },
    });
    raisePermissionPrompt(telemetry, 's1', 'tool-awaited');

    telemetry.ingestEvents('s1', [{ ts: Date.now(), type: EventType.ToolEnd, tool: 'Write', toolId: 'tool-awaited' }]);
    expect(telemetry.activityEngine.getState('s1')?.activity).toBe('thinking');

    vi.advanceTimersByTime(POLL_MS * 5);
    expect(calls).toEqual([]);
  });

  it('calls reportRejectedPermissionTools with the awaited toolId and needsUserSince on each tick', () => {
    const calls: Array<{ sessionId: string; toolIds: string[]; sinceMs: number }> = [];
    telemetry = makeTelemetry({
      log,
      reportRejectedPermissionTools: (sessionId, toolIds, sinceMs) => {
        calls.push({ sessionId, toolIds, sinceMs });
        return [];
      },
    });
    raisePermissionPrompt(telemetry, 's1', 'tool-awaited');
    const sinceMs = telemetry.activityEngine.getState('s1')?.needsUserSince;
    expect(sinceMs).not.toBeNull();

    vi.advanceTimersByTime(POLL_MS);

    expect(calls).toEqual([{ sessionId: 's1', toolIds: ['tool-awaited'], sinceMs }]);
  });

  it('clears the flag and commits idle when the callback reports the awaited toolId rejected', () => {
    telemetry = makeTelemetry({
      log,
      reportRejectedPermissionTools: (_sessionId, toolIds) => toolIds,
    });
    raisePermissionPrompt(telemetry, 's1', 'tool-awaited');
    log.activityChanges.length = 0;

    vi.advanceTimersByTime(POLL_MS);

    const state = telemetry.activityEngine.getState('s1')!;
    expect(state.permissionPending).toBe(false);
    expect(state.activity).toBe('idle');
    expect(log.activityChanges).toEqual([
      { sessionId: 's1', activity: 'idle', reason: expect.objectContaining({ kind: 'idle' }) },
    ]);
    // The session left permission - the interval must have stopped itself.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps polling (and stays in permission) when the callback reports no rejection', () => {
    telemetry = makeTelemetry({ log, reportRejectedPermissionTools: () => [] });
    raisePermissionPrompt(telemetry, 's1', 'tool-awaited');

    vi.advanceTimersByTime(POLL_MS * 5);

    expect(telemetry.activityEngine.getState('s1')?.activity).toBe('permission');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not call the callback for a session with no correlation id (permissionAwaitedToolId null)', () => {
    const calls: string[] = [];
    telemetry = makeTelemetry({
      log,
      reportRejectedPermissionTools: (sessionId) => {
        calls.push(sessionId);
        return [];
      },
    });
    telemetry.initSession('s1');
    // No ToolStart before the permission idle - the pending stack is empty,
    // so permissionAwaitedToolId is null.
    telemetry.ingestEvents('s1', [{ ts: Date.now(), type: EventType.Idle, detail: IdleReason.Permission }]);
    expect(telemetry.activityEngine.getState('s1')?.permissionAwaitedToolId).toBeNull();

    vi.advanceTimersByTime(POLL_MS);

    expect(calls).toEqual([]);
  });

  it('skips a session that is no longer running (isSessionRunning false), without stopping the interval for others', () => {
    const calls: string[] = [];
    telemetry = makeTelemetry({
      log,
      isSessionRunning: (sessionId) => sessionId !== 'stopped',
      reportRejectedPermissionTools: (sessionId, toolIds) => {
        calls.push(sessionId);
        return toolIds;
      },
    });
    raisePermissionPrompt(telemetry, 'stopped', 'tool-a');
    raisePermissionPrompt(telemetry, 'running', 'tool-b');

    vi.advanceTimersByTime(POLL_MS);

    expect(calls).toEqual(['running']);
    // The stopped session's flag is untouched (never asked about).
    expect(telemetry.activityEngine.getState('stopped')?.permissionPending).toBe(true);
    expect(telemetry.activityEngine.getState('running')?.permissionPending).toBe(false);
  });

  it('keeps the interval running for a second session after the first is cleared mid-poll', () => {
    telemetry = makeTelemetry({
      log,
      reportRejectedPermissionTools: (sessionId, toolIds) => (sessionId === 's1' ? toolIds : []),
    });
    raisePermissionPrompt(telemetry, 's1', 'tool-a');
    raisePermissionPrompt(telemetry, 's2', 'tool-b');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(POLL_MS);

    expect(telemetry.activityEngine.getState('s1')?.activity).toBe('idle');
    expect(telemetry.activityEngine.getState('s2')?.activity).toBe('permission');
    // s2 is still pending - the interval must not have been torn down.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops the interval when a permission-pending session is cleared via clearSessionTracking (suspend)', () => {
    telemetry = makeTelemetry({ log, reportRejectedPermissionTools: () => [] });
    raisePermissionPrompt(telemetry, 's1', 'tool-awaited');
    expect(vi.getTimerCount()).toBe(1);

    telemetry.clearSessionTracking('s1');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the interval when a permission-pending session is cleared via removeSession', () => {
    telemetry = makeTelemetry({ log, reportRejectedPermissionTools: () => [] });
    raisePermissionPrompt(telemetry, 's1', 'tool-awaited');
    expect(vi.getTimerCount()).toBe(1);

    telemetry.removeSession('s1');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('never throws and does nothing when the adapter declares no reportRejectedPermissionTools callback', () => {
    telemetry = makeTelemetry({ log, reportRejectedPermissionTools: undefined });
    raisePermissionPrompt(telemetry, 's1', 'tool-awaited');

    expect(() => vi.advanceTimersByTime(POLL_MS * 3)).not.toThrow();
    expect(telemetry.activityEngine.getState('s1')?.activity).toBe('permission');
  });

  it('clears the permission-rejection poll interval on dispose(), even while a session is still pending', () => {
    // Every other test here only ever calls dispose() from afterEach, so
    // deleting SessionTelemetry.dispose()'s
    // `clearInterval(this.permissionRejectionPollInterval)` line would fail
    // nothing in this file. Call dispose() explicitly, mid-test, while a
    // session is still armed, and assert the timer count reaches zero
    // BEFORE afterEach's own (now redundant) dispose() runs.
    telemetry = makeTelemetry({ log, reportRejectedPermissionTools: () => [] });
    raisePermissionPrompt(telemetry, 's1', 'tool-awaited');
    expect(vi.getTimerCount()).toBe(1);

    telemetry.dispose();

    expect(vi.getTimerCount()).toBe(0);
  });
});
