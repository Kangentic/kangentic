/**
 * `SessionManager.markBackgroundShellsAsServices` (src/main/pty/session-manager.ts),
 * the manager half of the `kangentic_mark_background_service` MCP tool (task #857).
 *
 * The method answers only for a RUNNING session:
 *
 *   if (this.registry.get(sessionId)?.status !== 'running') return null;
 *
 * The status check, not the row's presence, is the guard. A natural PTY exit
 * sets the registry row's `status = 'exited'` but keeps the row AND the
 * activity engine's state for it (`session-spawn-flow.ts`, the PTY exit
 * callback); only suspend, remove and the respawn sibling drain delete engine
 * state. So an agent's late mark for a session that already exited used to
 * reach a live engine state, move its held shell to exempt, commit the held
 * turn idle and fire `turn-ended`, which runs the column's turn-end
 * automations for a dead session.
 *
 * Driven through the real SessionManager with its real telemetry and engine
 * (the `session-manager-turn-anchor.test.ts` harness), so the exited case
 * proves the engine was never reached rather than trusting a stub. The unit
 * tests of `ActivityEngine.markBackgroundShellsAsServices` and
 * `background-shell-tools.test.ts` cover the engine and the tool; neither
 * crosses this status check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidate: string) => /^[\\/]{2}[^\\/]/.test(candidate),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager, type TurnEndedPayload } from '../../src/main/pty/session-manager';
import type { SessionRegistry } from '../../src/main/pty/session-registry';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';
import type { SessionEvent, SessionStatus } from '../../src/shared/types';

const SHELL_ID = 'bserver01';

function getTelemetry(manager: SessionManager): SessionTelemetry {
  return (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
}

function getRegistry(manager: SessionManager): SessionRegistry {
  return (manager as unknown as { registry: SessionRegistry }).registry;
}

describe('SessionManager.markBackgroundShellsAsServices (task #857)', () => {
  let manager: SessionManager;
  let sessionId: string;
  let turnEnds: TurnEndedPayload[];
  let clock: number;

  function send(type: EventType, extra: Partial<SessionEvent> = {}): void {
    clock += 1;
    getTelemetry(manager).ingestEvents(sessionId, [{ ts: clock, type, ...extra }]);
  }

  /** The registry row's own status, which a natural PTY exit rewrites in place. */
  function setRowStatus(status: SessionStatus): void {
    const row = getRegistry(manager).get(sessionId);
    if (!row) throw new Error('The placeholder row is missing from the registry.');
    row.status = status;
  }

  /**
   * The agent started a named background server and its turn Stopped. The engine
   * holds the turn `thinking` until the shell exits or is marked a service.
   */
  function holdTurnOnNamedServer(): void {
    send(EventType.Prompt);
    send(EventType.BackgroundShellStart, { tool: 'Bash', toolId: 'toolu_server', detail: 'npm run dev' });
    send(EventType.BackgroundShellStart, { tool: 'Bash', toolId: 'toolu_server', detail: SHELL_ID });
    send(EventType.Idle);
  }

  function engineState() {
    return getTelemetry(manager).activityEngine.getState(sessionId);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager({
      activityEngineOptions: {
        bgShellEscapeHatchMs: 60_000,
        staleThinkingTimeoutMs: 60_000,
        idleStabilityWindowMs: 0,
      },
    });
    const session = manager.registerSuspendedPlaceholder({ taskId: 'task-mark-service', projectId: 'project-mark-service', cwd: '/mock/cwd' });
    if (!session) throw new Error('The placeholder was not registered.');
    sessionId = session.id;
    clock = Date.now();
    turnEnds = [];
    manager.on('turn-ended', (payload: TurnEndedPayload) => turnEnds.push(payload));
    getTelemetry(manager).initSession(sessionId);
    holdTurnOnNamedServer();
  });

  afterEach(() => {
    manager.dispose();
  });

  it('holds the turn on the named server before any mark (the control)', () => {
    expect(engineState()?.activity).toBe('thinking');
    expect(engineState()?.activeBackgroundShellIds.has(SHELL_ID)).toBe(true);
    expect(turnEnds).toHaveLength(0);
  });

  it('forwards a running session\'s mark to the engine, reports the outcome, and ends the held turn', () => {
    setRowStatus('running');
    const markThroughTelemetry = vi.spyOn(getTelemetry(manager), 'markBackgroundShellsAsServices');

    const outcomes = manager.markBackgroundShellsAsServices(sessionId, [SHELL_ID]);

    expect(outcomes).toEqual([{ shellId: SHELL_ID, outcome: 'marked' }]);
    expect(markThroughTelemetry).toHaveBeenCalledWith(sessionId, [SHELL_ID]);
    expect(engineState()?.activeBackgroundShellIds.has(SHELL_ID)).toBe(false);
    expect(engineState()?.exemptBackgroundShellIds.has(SHELL_ID)).toBe(true);
    expect(engineState()?.activity).toBe('idle');
    expect(turnEnds).toHaveLength(1);
  });

  it('answers null for an exited row and never reaches the engine, so a dead session\'s turn does not end', () => {
    // A natural PTY exit rewrites the row's status in place, emits a synthetic
    // session_end, and keeps both the row and the engine state (the PTY exit
    // callback in session-spawn-flow.ts). That is exactly what the guard must survive.
    setRowStatus('exited');
    getTelemetry(manager).emitSessionEnd(sessionId);
    expect(getRegistry(manager).has(sessionId)).toBe(true);
    expect(engineState()).toBeDefined();
    const markThroughTelemetry = vi.spyOn(getTelemetry(manager), 'markBackgroundShellsAsServices');

    const outcomes = manager.markBackgroundShellsAsServices(sessionId, [SHELL_ID]);

    expect(outcomes).toBeNull();
    expect(markThroughTelemetry).not.toHaveBeenCalled();
    // The engine is untouched: the shell still holds, nothing moved to exempt,
    // no turn ended, and nothing was remembered as a pending service.
    expect(engineState()?.activeBackgroundShellIds.has(SHELL_ID)).toBe(true);
    expect(engineState()?.exemptBackgroundShellIds.size).toBe(0);
    expect(engineState()?.pendingServiceShellIds.size).toBe(0);
    expect(engineState()?.activity).toBe('thinking');
    expect(turnEnds).toHaveLength(0);
  });

  it('answers null for a suspended row too, which is not running either', () => {
    // The placeholder is registered suspended; the guard is "running", not "not exited".
    const markThroughTelemetry = vi.spyOn(getTelemetry(manager), 'markBackgroundShellsAsServices');

    expect(manager.markBackgroundShellsAsServices(sessionId, [SHELL_ID])).toBeNull();
    expect(markThroughTelemetry).not.toHaveBeenCalled();
    expect(turnEnds).toHaveLength(0);
  });

  it('answers null for an id the registry does not hold', () => {
    const markThroughTelemetry = vi.spyOn(getTelemetry(manager), 'markBackgroundShellsAsServices');

    expect(manager.markBackgroundShellsAsServices('unknown-session', [SHELL_ID])).toBeNull();
    expect(markThroughTelemetry).not.toHaveBeenCalled();
  });
});
