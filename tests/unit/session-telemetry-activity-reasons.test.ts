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

function makeCallbacks() {
  return {
    onUsageChange: (_sessionId: string, _usage: SessionUsage): void => {},
    onActivityChange: (_sessionId: string, _activity: ActivityState, _reason: ActivityReason): void => {},
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
