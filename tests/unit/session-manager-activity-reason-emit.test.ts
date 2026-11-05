/**
 * Unit test for SessionManager's wiring of SessionTelemetry's onReasonChange
 * callback to a NEW EventEmitter event, 'activity-reason'
 * (src/main/pty/session-manager.ts):
 *
 *   onReasonChange: (sessionId, activity, reason) =>
 *     this.emit('activity-reason', sessionId, activity, reason),
 *
 * No other test in the suite reaches this line. activity-engine-reason-reporting
 * .test.ts and session-telemetry-activity-reasons.test.ts construct the engine
 * and telemetry directly, never a SessionManager. ipc-handler-wiring.test.ts
 * mocks context.sessionManager.on entirely and hand-invokes the captured
 * listener with a fabricated 'activity-reason' name, so it proves sessions.ts
 * reacts correctly to that emit but never proves the real SessionManager class
 * produces one. A renamed event, a dropped onReasonChange line, or a swapped
 * argument order in session-manager.ts would leave every one of those tests
 * green.
 *
 * Also asserts the negative: the same reason-only churn that fires
 * 'activity-reason' must not ALSO fire 'activity'. Nine other listeners on
 * 'activity' (mobile push notifier, desktop notifier, turn-completion
 * auto-move, the terminal submit scheduler, the interval recorder) read it as
 * "the state changed" - see the comment above the wiring in session-manager.ts.
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
  isUncPath: (p: string) => /^[\\/]{2}[^\\/]/.test(p),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';
import type { ActivityState, ActivityReason } from '../../src/shared/types';

/** Type-cast helper to reach the private telemetry field, matching the
 *  established pattern in session-manager-activity-reasons-cache.test.ts. */
function getTelemetry(manager: SessionManager): SessionTelemetry {
  return (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
}

interface ActivityReasonEmission {
  sessionId: string;
  activity: ActivityState;
  reason: ActivityReason;
}

describe('SessionManager: onReasonChange forwards to a separate activity-reason event', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager({
      activityEngineOptions: {
        bgShellEscapeHatchMs: 60_000,
        staleThinkingTimeoutMs: 60_000,
        idleStabilityWindowMs: 0,
      },
    });
  });

  afterEach(() => {
    manager.dispose();
  });

  it('emits activity-reason with the session id, the unchanged activity, and the moved reason kind, without also emitting activity', () => {
    const session = manager.registerSuspendedPlaceholder({
      taskId: 'task-reason-emit',
      projectId: 'project-reason-emit',
      cwd: '/mock/cwd',
    });
    expect(session).not.toBeNull();
    const sessionId = session!.id;

    const telemetry = getTelemetry(manager);
    telemetry.initSession(sessionId);

    const reasonEmissions: ActivityReasonEmission[] = [];
    manager.on('activity-reason', (id: string, activity: ActivityState, reason: ActivityReason) => {
      reasonEmissions.push({ sessionId: id, activity, reason });
    });
    const activityEmissions: ActivityState[] = [];
    manager.on('activity', (_id: string, activity: ActivityState) => {
      activityEmissions.push(activity);
    });

    const now = Date.now();
    // idle -> thinking: a real transition. Fires 'activity', not
    // 'activity-reason'.
    telemetry.ingestEvents(sessionId, [{ ts: now, type: EventType.Prompt }]);
    expect(activityEmissions).toEqual(['thinking']);
    expect(reasonEmissions).toEqual([]);

    // Still thinking throughout: the derived reason kind moves
    // turn-active -> tool -> turn-active -> subagent. Each kind move is a
    // reason-only report (the same sequence proven in
    // session-telemetry-activity-reasons.test.ts).
    telemetry.ingestEvents(sessionId, [
      { ts: now + 1, type: EventType.ToolStart, tool: 'Read', toolId: 't1' },
      { ts: now + 2, type: EventType.ToolEnd, tool: 'Read', toolId: 't1' },
      { ts: now + 3, type: EventType.SubagentStart, detail: 'review-finder' },
    ]);

    // The negative assertion: none of that churn fired 'activity'. If
    // session-manager.ts's onReasonChange wiring routed onto 'activity'
    // instead of 'activity-reason', this would fail - and so would every
    // listener downstream that treats 'activity' as a real transition.
    expect(activityEmissions).toEqual(['thinking']);

    expect(reasonEmissions.length).toBeGreaterThan(0);
    const kinds = reasonEmissions.map((emission) => emission.reason.kind);
    expect(kinds).toContain('tool');
    expect(kinds).toContain('subagent');
    for (const emission of reasonEmissions) {
      expect(emission.sessionId).toBe(sessionId);
      expect(emission.activity).toBe('thinking');
    }
  });

  describe('a task the board has stopped', () => {
    const TASK_ID = 'task-stopped';
    let sessionId: string;
    let reasonEmissions: ActivityReasonEmission[];
    let activityEmissions: ActivityState[];

    /** A real turn: thinking, then idle, so the engine holds a real idle reason. */
    function finishTurn(): void {
      const telemetry = getTelemetry(manager);
      const now = Date.now();
      telemetry.ingestEvents(sessionId, [{ ts: now, type: EventType.Prompt }]);
      telemetry.ingestEvents(sessionId, [{ ts: now + 1, type: EventType.Idle }]);
    }

    beforeEach(() => {
      sessionId = manager.registerSuspendedPlaceholder({ taskId: TASK_ID, projectId: 'project-stopped', cwd: '/mock/cwd' })!.id;
      getTelemetry(manager).initSession(sessionId);
      finishTurn();
      reasonEmissions = [];
      activityEmissions = [];
      manager.on('activity-reason', (id: string, activity: ActivityState, reason: ActivityReason) => {
        reasonEmissions.push({ sessionId: id, activity, reason });
      });
      manager.on('activity', (_id: string, activity: ActivityState) => {
        activityEmissions.push(activity);
      });
    });

    it('reaches the renderer as a reason-only refresh, since the idle push left before the rows ran', () => {
      manager.setTaskStopped(TASK_ID, 'visit');
      expect(reasonEmissions).toHaveLength(1);
      expect(reasonEmissions[0]).toMatchObject({ sessionId, activity: 'idle', reason: { kind: 'idle', stopped: true } });
      // 'activity' would raise a second idle notice for one finished turn.
      expect(activityEmissions).toEqual([]);
    });

    it('holds in every read a sync or the Agent Monitor makes', () => {
      manager.setTaskStopped(TASK_ID, 'visit');
      expect(manager.getActivityReason(sessionId)).toMatchObject({ kind: 'idle', stopped: true });
      expect(manager.getActivityReasonsCache()[sessionId]).toMatchObject({ kind: 'idle', stopped: true });
    });

    it('sends nothing when nothing changed', () => {
      manager.setTaskStopped(TASK_ID, null);
      manager.setTaskStopped(TASK_ID, 'visit');
      manager.setTaskStopped(TASK_ID, 'visit');
      expect(reasonEmissions).toHaveLength(1);
    });

    it('takes the flag back off, with its own refresh', () => {
      manager.setTaskStopped(TASK_ID, 'visit');
      manager.setTaskStopped(TASK_ID, null);
      expect(reasonEmissions).toHaveLength(2);
      expect(reasonEmissions[1].reason).not.toHaveProperty('stopped');
      expect(manager.getActivityReason(sessionId)).not.toHaveProperty('stopped');
    });

    it('drops a stop from the agent\'s words as its next turn begins, since that turn\'s idle lands before it is judged', () => {
      manager.setTaskStopped(TASK_ID, 'turn');
      getTelemetry(manager).ingestEvents(sessionId, [{ ts: Date.now(), type: EventType.Prompt }]);
      getTelemetry(manager).ingestEvents(sessionId, [{ ts: Date.now() + 1, type: EventType.Idle }]);
      expect(manager.getActivityReason(sessionId)).not.toHaveProperty('stopped');
    });

    it('sets the flag again at the next idle, after the agent worked', () => {
      manager.setTaskStopped(TASK_ID, 'visit');
      getTelemetry(manager).ingestEvents(sessionId, [{ ts: Date.now(), type: EventType.Prompt }]);
      expect(manager.getActivityReason(sessionId)).not.toHaveProperty('stopped');
      getTelemetry(manager).ingestEvents(sessionId, [{ ts: Date.now() + 1, type: EventType.Idle }]);
      expect(manager.getActivityReason(sessionId)).toMatchObject({ kind: 'idle', stopped: true });
    });

    it('counts a stop from the agent\'s words set while a turn runs for nothing, since that turn is not judged yet', () => {
      const telemetry = getTelemetry(manager);
      telemetry.ingestEvents(sessionId, [{ ts: Date.now(), type: EventType.Prompt }]);
      expect(manager.getActivityCache()[sessionId]).toBe('thinking');
      manager.setTaskStopped(TASK_ID, 'turn');
      telemetry.ingestEvents(sessionId, [{ ts: Date.now() + 1, type: EventType.Idle }]);
      expect(manager.getActivityReason(sessionId)).toMatchObject({ kind: 'idle' });
      expect(manager.getActivityReason(sessionId)).not.toHaveProperty('stopped');
    });

    it('still shows a spent row\'s stop set while a turn runs, at that turn\'s idle', () => {
      const telemetry = getTelemetry(manager);
      telemetry.ingestEvents(sessionId, [{ ts: Date.now(), type: EventType.Prompt }]);
      manager.setTaskStopped(TASK_ID, 'visit');
      telemetry.ingestEvents(sessionId, [{ ts: Date.now() + 1, type: EventType.Idle }]);
      expect(manager.getActivityReason(sessionId)).toMatchObject({ kind: 'idle', stopped: true });
    });

    it('forgets the stop when the task\'s sessions are removed, so a later session of it starts unmarked', async () => {
      manager.setTaskStopped(TASK_ID, 'visit');
      await manager.removeByTaskId(TASK_ID);
      const nextId = manager.registerSuspendedPlaceholder({ taskId: TASK_ID, projectId: 'project-stopped', cwd: '/mock/cwd' })!.id;
      getTelemetry(manager).initSession(nextId);
      const now = Date.now();
      getTelemetry(manager).ingestEvents(nextId, [{ ts: now, type: EventType.Prompt }]);
      getTelemetry(manager).ingestEvents(nextId, [{ ts: now + 1, type: EventType.Idle }]);
      expect(manager.getActivityReason(nextId)).toMatchObject({ kind: 'idle' });
      expect(manager.getActivityReason(nextId)).not.toHaveProperty('stopped');
    });
  });

  describe('a stopped task whose session is hidden until adopted', () => {
    const HIDDEN_TASK_ID = 'task-stopped-hidden';
    const HIDDEN_SESSION_ID = 'sess-stopped-hidden';

    function seedHiddenIdleSession(): void {
      const registry = (manager as unknown as { registry: SessionRegistry }).registry;
      registry.set(HIDDEN_SESSION_ID, {
        id: HIDDEN_SESSION_ID,
        taskId: HIDDEN_TASK_ID,
        projectId: 'project-stopped',
        pty: { sealUserInput: vi.fn() } as unknown as ManagedSession['pty'],
        status: 'running',
        shell: '',
        cwd: '/mock/cwd',
        startedAt: new Date().toISOString(),
        exitCode: null,
        resuming: false,
        transient: false,
        exitSequence: ['\x03'],
      } as ManagedSession);
      (manager as unknown as { hiddenUntilAdopted: Set<string> }).hiddenUntilAdopted.add(HIDDEN_SESSION_ID);
      const telemetry = getTelemetry(manager);
      telemetry.initSession(HIDDEN_SESSION_ID);
      const now = Date.now();
      telemetry.ingestEvents(HIDDEN_SESSION_ID, [{ ts: now, type: EventType.Prompt }]);
      telemetry.ingestEvents(HIDDEN_SESSION_ID, [{ ts: now + 1, type: EventType.Idle }]);
    }

    it('sends no refresh for it, since nothing has told the renderer it exists', () => {
      seedHiddenIdleSession();
      const emitSpy = vi.spyOn(manager, 'emit');
      manager.setTaskStopped(HIDDEN_TASK_ID, 'visit');
      expect(emitSpy.mock.calls.filter(([eventName]) => eventName === 'activity-reason')).toEqual([]);
    });

    it('carries the stop in the activity push adoption makes when the idle clock could not restart', () => {
      seedHiddenIdleSession();
      manager.setTaskStopped(HIDDEN_TASK_ID, 'visit');
      vi.spyOn(getTelemetry(manager), 'restartIdleClock').mockReturnValue(false);
      const pushes: Array<{ activity: ActivityState; reason: ActivityReason }> = [];
      manager.on('activity', (_id: string, activity: ActivityState, reason: ActivityReason) => pushes.push({ activity, reason }));

      expect(manager.adoptSession(HIDDEN_SESSION_ID)).toBe(true);

      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ activity: 'idle', reason: { kind: 'idle', stopped: true } });
    });
  });
});
