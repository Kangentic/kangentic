/**
 * The trigger label of a holder that ends at its own time limit.
 *
 * `SessionTelemetry.endExpiredHolders` ends a held background shell once its
 * `expiresAfterMs` plus the one-minute grace has passed, and tells the engine
 * with `source: 'expired'`, so the audit log can tell that cause from a
 * transcript end notice or a watcher guess. The sibling
 * `session-telemetry-holder-end.test.ts` asserts the ledger and the engine's
 * sets; this one pins the label the transition carries.
 *
 * Test tier: Unit. Same rig as the sibling: a root-only process probe and
 * fake timers.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { ProcessInfo, ProcessTreeProbe } from '../../src/main/activity-engine/background-shell/process-tree';
import { EventType, type SessionEvent } from '../../src/shared/types';

const SESSION_ID = 'session-1';
const ROOT_PID = 4321;
const MINUTE = 60_000;

class RootOnlyProbe implements ProcessTreeProbe {
  isAlive(pid: number): boolean {
    return pid === ROOT_PID;
  }
  async listAllProcesses(): Promise<ProcessInfo[]> {
    return [{ pid: ROOT_PID, ppid: 1, comm: 'claude' }];
  }
  async listDescendants(): Promise<ProcessInfo[]> {
    return [];
  }
  dispose(): void {
    // Nothing long-lived to release.
  }
}

describe('SessionTelemetry: a holder that outlives its own time limit', () => {
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    telemetry = new SessionTelemetry(
      {
        onUsageChange: () => {},
        onActivityChange: () => {},
        onEvent: () => {},
        onIdleTimeout: () => {},
        onPlanExit: () => {},
        onPRCandidate: () => {},
        requestSuspend: () => {},
        isSessionRunning: () => true,
        getSessionRootPid: () => ROOT_PID,
        reportTerminatedBackgroundShells: () => [],
      },
      { processTreeProbe: new RootOnlyProbe() },
    );
    telemetry.initSession(SESSION_ID);
    telemetry.notifySessionSpawned(SESSION_ID);
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  function monitorLaunch(taskId: string, expiresAfterMs: number): SessionEvent[] {
    const now = Date.now();
    return [
      { ts: now, type: EventType.Prompt, detail: 'watch the build' },
      { ts: now, type: EventType.ToolStart, tool: 'Monitor', toolId: `toolu_${taskId}`, detail: 'tail -f build.log' },
      { ts: now, type: EventType.BackgroundShellStart, tool: 'Monitor', toolId: `toolu_${taskId}`, detail: taskId, expiresAfterMs },
      { ts: now, type: EventType.Idle },
    ];
  }

  const transitionTriggers = (): string[] =>
    telemetry.activityEngine.getStatsSnapshot(SESSION_ID)!.recentTransitions.map((record) => record.trigger);

  it('labels the engine transition event:bg-shell-ended:expired, and not before the limit plus the grace', async () => {
    telemetry.ingestEvents(SESSION_ID, monitorLaunch('bexpire01', 3 * MINUTE));
    expect(transitionTriggers()).not.toContain('event:bg-shell-ended:expired');

    // At the limit the grace has not passed: the holder is still open.
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(transitionTriggers()).not.toContain('event:bg-shell-ended:expired');

    await vi.advanceTimersByTimeAsync(MINUTE + 5_000);
    expect(telemetry.activityEngine.getState(SESSION_ID)!.activeBackgroundShellIds.size).toBe(0);
    expect(transitionTriggers()).toContain('event:bg-shell-ended:expired');
  });
});
