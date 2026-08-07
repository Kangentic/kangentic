/**
 * Unit tests for src/main/ipc/helpers/auto-command-outcome.ts.
 *
 * Two sinks with deliberately different rules: the DB row records EVERY
 * outcome so the state survives a restart and stays inspectable, while the
 * push event is rationed to the outcomes a user can act on.
 *
 * The rationing is the part worth pinning. Only Claude implements a
 * `command-injection` verifier, so on every other agent a delivery can only
 * ever land on `unconfirmed`. Toasting that would fire on every column move
 * for most users and would say nothing actionable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportAutoCommandOutcome } from '../../src/main/ipc/helpers/auto-command-outcome';
import { IPC } from '../../src/shared/ipc-channels';
import type { InjectionReport } from '../../src/main/transition-engine/terminal-submit-scheduler';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { TaskRepository } from '../../src/main/db/repositories/task-repository';

const TASK = { id: 'task-1', title: 'Rebuild injection' };

function makeReport(overrides: Partial<InjectionReport> = {}): InjectionReport {
  return {
    taskId: TASK.id,
    sessionId: 'sess-1',
    commands: ['/code-review'],
    outcome: 'confirmed',
    unconfirmedCommands: [],
    discardedDraft: null,
    interruptedTurn: false,
    escalated: false,
    ...overrides,
  };
}

function makeHarness(): {
  context: IpcContext;
  send: ReturnType<typeof vi.fn>;
  recordAutoCommandOutcome: ReturnType<typeof vi.fn>;
  tasks: TaskRepository;
} {
  const send = vi.fn();
  const context = {
    mainWindow: { isDestroyed: () => false, webContents: { send } },
    currentProjectId: 'proj-1',
  } as unknown as IpcContext;
  const recordAutoCommandOutcome = vi.fn();
  const tasks = { recordAutoCommandOutcome } as unknown as TaskRepository;
  return { context, send, recordAutoCommandOutcome, tasks };
}

describe('reportAutoCommandOutcome', () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  describe('durable record', () => {
    it('records every outcome, including the silent ones', () => {
      for (const outcome of ['confirmed', 'unconfirmed', 'failed', 'cancelled'] as const) {
        reportAutoCommandOutcome(
          harness.context,
          harness.tasks,
          TASK,
          makeReport({ outcome }),
          'proj-1',
        );
      }

      expect(harness.recordAutoCommandOutcome).toHaveBeenCalledTimes(4);
      const states = harness.recordAutoCommandOutcome.mock.calls.map((call) => call[1].state);
      expect(states).toEqual(['confirmed', 'unconfirmed', 'failed', 'cancelled']);
    });

    it('maps the byte layer\'s "aborted" onto the persisted "cancelled"', () => {
      reportAutoCommandOutcome(
        harness.context,
        harness.tasks,
        TASK,
        makeReport({ outcome: 'aborted' }),
        'proj-1',
      );

      expect(harness.recordAutoCommandOutcome.mock.calls[0][1].state).toBe('cancelled');
    });

    it('still notifies when the DB write throws', () => {
      // Persistence is best-effort; the notice is the part the user sees.
      harness.recordAutoCommandOutcome.mockImplementation(() => {
        throw new Error('db is gone');
      });

      expect(() => reportAutoCommandOutcome(
        harness.context,
        harness.tasks,
        TASK,
        makeReport({ outcome: 'failed', reason: 'could not confirm' }),
        'proj-1',
      )).not.toThrow();

      expect(harness.send).toHaveBeenCalled();
    });
  });

  describe('notification rationing', () => {
    it('notifies on a failure', () => {
      reportAutoCommandOutcome(
        harness.context,
        harness.tasks,
        TASK,
        makeReport({ outcome: 'failed', reason: 'could not confirm' }),
        'proj-1',
      );

      expect(harness.send).toHaveBeenCalledTimes(1);
      const [channel, notice] = harness.send.mock.calls[0];
      expect(channel).toBe(IPC.TASK_AUTO_COMMAND_RESULT);
      expect(notice).toMatchObject({
        taskId: TASK.id,
        taskTitle: TASK.title,
        state: 'failed',
        command: '/code-review',
        reason: 'could not confirm',
      });
    });

    it('stays silent on a clean confirmed delivery', () => {
      reportAutoCommandOutcome(harness.context, harness.tasks, TASK, makeReport(), 'proj-1');

      expect(harness.send).not.toHaveBeenCalled();
    });

    it('stays silent on unconfirmed', () => {
      // 11 of 12 adapters can only ever land here. Treating it as noteworthy
      // would make the notice constant and meaningless off Claude.
      reportAutoCommandOutcome(
        harness.context,
        harness.tasks,
        TASK,
        makeReport({ outcome: 'unconfirmed' }),
        'proj-1',
      );

      expect(harness.send).not.toHaveBeenCalled();
    });

    it('stays silent on cancelled', () => {
      // Usually the user moving the task again or stopping the session.
      // Reporting their own action back to them is noise.
      reportAutoCommandOutcome(
        harness.context,
        harness.tasks,
        TASK,
        makeReport({ outcome: 'cancelled' }),
        'proj-1',
      );

      expect(harness.send).not.toHaveBeenCalled();
    });

    it('notifies when a successful delivery discarded typed text', () => {
      reportAutoCommandOutcome(
        harness.context,
        harness.tasks,
        TASK,
        makeReport({ discardedDraft: 'instead can we' }),
        'proj-1',
      );

      expect(harness.send).toHaveBeenCalledTimes(1);
      expect(harness.send.mock.calls[0][1]).toMatchObject({
        state: 'confirmed',
        discardedDraft: 'instead can we',
      });
    });

    it('notifies when a successful delivery interrupted a live turn', () => {
      reportAutoCommandOutcome(
        harness.context,
        harness.tasks,
        TASK,
        makeReport({ interruptedTurn: true }),
        'proj-1',
      );

      expect(harness.send).toHaveBeenCalledTimes(1);
      expect(harness.send.mock.calls[0][1]).toMatchObject({ interruptedTurn: true });
    });

    it('records an escalated delivery as its own state, never as confirmed', () => {
      // The restart was issued; no verifier saw the command land. Persisting
      // `confirmed` here would be the silent success this work removes.
      reportAutoCommandOutcome(
        harness.context,
        harness.tasks,
        TASK,
        makeReport({ outcome: 'failed', escalated: true }),
        'proj-1',
      );

      expect(harness.recordAutoCommandOutcome.mock.calls[0][1].state).toBe('escalated');
      expect(harness.send).toHaveBeenCalledTimes(1);
      expect(harness.send.mock.calls[0][1]).toMatchObject({ state: 'escalated', escalated: true });
    });

    it('does not send when the window is gone', () => {
      const context = {
        mainWindow: { isDestroyed: () => true, webContents: { send: harness.send } },
        currentProjectId: 'proj-1',
      } as unknown as IpcContext;

      reportAutoCommandOutcome(
        context,
        harness.tasks,
        TASK,
        makeReport({ outcome: 'failed' }),
        'proj-1',
      );

      expect(harness.send).not.toHaveBeenCalled();
    });
  });
});
