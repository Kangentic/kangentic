/**
 * How a background holder's end reaches the open-work ledger, through the real
 * SessionTelemetry: its activity engine, its ledger and its bg-shell watcher,
 * wired as production wires them (src/main/activity-engine/session-telemetry.ts).
 *
 * Two ends used to be lost, and a workflow's step check then read dead
 * holders as running work for hours:
 * - A holder the engine drained on a guess kept its ledger entry, and the
 *   transcript's own end notice for it never reached the ledger: the watcher
 *   asked only about ids the engine still tracked.
 * - A Monitor whose end notice the CLI reworded was never seen ending at all.
 *   Its own `timeoutMs` now bounds it.
 *
 * Test tier: Unit. The probe reports the CLI's root as alive with no
 * descendants, and the transcript is a scripted callback, so no OS process
 * and no file is involved.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { ProcessInfo, ProcessTreeProbe } from '../../src/main/activity-engine/background-shell/process-tree';
import { EventType, type SessionEvent } from '../../src/shared/types';

const SESSION_ID = 'session-1';
const ROOT_PID = 4321;
const MINUTE = 60_000;

/** The CLI's root process, alive, with nothing under it. */
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

describe('SessionTelemetry: a background holder\'s end reaches the open-work ledger', () => {
  let telemetry: SessionTelemetry;
  /** Shell ids whose end notice the transcript holds. */
  let endedInTranscript: Set<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    endedInTranscript = new Set();
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
        reportTerminatedBackgroundShells: (_sessionId, shellIds) => shellIds.filter((shellId) => endedInTranscript.has(shellId)),
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

  function monitorLaunch(taskId: string, expiresAfterMs?: number): SessionEvent[] {
    const now = Date.now();
    return [
      { ts: now, type: EventType.Prompt, detail: 'watch the build' },
      { ts: now, type: EventType.ToolStart, tool: 'Monitor', toolId: `toolu_${taskId}`, detail: 'tail -f build.log' },
      {
        ts: now,
        type: EventType.BackgroundShellStart,
        tool: 'Monitor',
        toolId: `toolu_${taskId}`,
        detail: taskId,
        ...(expiresAfterMs !== undefined ? { expiresAfterMs } : {}),
      },
      { ts: now, type: EventType.Idle },
    ];
  }

  const openShellIds = (): string[] => telemetry.getOpenWork(SESSION_ID).backgroundShells.map((shell) => shell.id);

  it('ends a Monitor at its own time limit, a grace past it, with no end notice the parser knows', async () => {
    telemetry.ingestEvents(SESSION_ID, monitorLaunch('b3mntbkwh', 3 * MINUTE));
    expect(openShellIds()).toEqual(['b3mntbkwh']);
    expect(telemetry.getOpenWork(SESSION_ID).backgroundShells[0].command).toBe('tail -f build.log');
    expect(telemetry.getSessionActivity(SESSION_ID)).toBe('thinking');

    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(openShellIds()).toEqual(['b3mntbkwh']);

    await vi.advanceTimersByTimeAsync(MINUTE + 5_000);
    expect(openShellIds()).toEqual([]);
    expect(telemetry.activityEngine.getState(SESSION_ID)!.activeBackgroundShellIds.size).toBe(0);
  });

  it('closes the ledger on the transcript\'s end notice even after the engine drained the shell on a guess', async () => {
    telemetry.ingestEvents(SESSION_ID, monitorLaunch('bguessed1'));
    // An engine-only drain, as the quiet-output reclaim does: the ledger keeps it.
    telemetry.activityEngine.markBackgroundShellEnded(SESSION_ID, 'bguessed1');
    expect(telemetry.activityEngine.getState(SESSION_ID)!.activeBackgroundShellIds.has('bguessed1')).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openShellIds()).toEqual(['bguessed1']);

    endedInTranscript.add('bguessed1');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(openShellIds()).toEqual([]);
  });
});
