/**
 * `applyAutomationsHoldChange` (src/main/workflows/workflow-task-hold.ts): what a
 * flip of a workflow task's automations switch does after the write.
 *
 * The switch is the task's own hold: while it is on, the workflow neither judges,
 * nudges, moves nor starts the task, so a person can work it by hand. The write
 * itself is pinned with its two callers (the task update IPC, `update_task`);
 * here the module's decisions are pinned with its collaborators mocked at the
 * boundary: the board's repositories, the turn-end supersede, the recovery
 * start-over and the workflow change push. The whole path on real recovery state
 * is in workflow-recovery.test.ts ("a workflow task whose automations are paused
 * and resumed").
 *
 * - Pausing stops the task's turn-end work (a step check or a nudge in flight,
 *   and the recovery it armed), and tells the workflow's views.
 * - Resuming in a working column starts the task's recovery over, so a task held
 *   while it was stalled comes back with a fresh schedule and notice rather than
 *   a spent one, and then, with a live idle agent, asks the turn-end runner to
 *   judge the reply the visit's last turn left (the resume catch-up, shared with
 *   the workflow's own Resume), at the session's own work serial. A working,
 *   suspended or missing agent is not caught up: its own turn end or resume
 *   does that. To Do, Done, an archived task and a missing column get
 *   neither.
 * - A write that left the flag as it was, or a task in no workflow, does nothing
 *   at all.
 *
 * Every "does nothing" case asserts the sibling case that does something first,
 * from the same fixture with one fact changed, so a negative cannot pass because
 * a mock was wired wrong.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Swimlane, Task } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { SessionResumedPayload } from '../../src/main/pty/session-manager';

const hoisted = vi.hoisted(() => ({
  getProjectRepos: vi.fn(),
  supersedeTurnEndWork: vi.fn(),
  startWorkflowRecoveryOver: vi.fn(),
  notifyWorkflowOfTask: vi.fn(),
}));

vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: hoisted.getProjectRepos }));
vi.mock('../../src/main/automations/turn-end/turn-end-passes', () => ({ supersedeTurnEndWork: hoisted.supersedeTurnEndWork }));
vi.mock('../../src/main/workflows/workflow-changed', () => ({ notifyWorkflowOfTask: hoisted.notifyWorkflowOfTask }));

const {
  applyAutomationsHoldChange,
  setHoldReleaseRecoveryStart,
  HOLD_RELEASE_RECOVERY_DETAIL,
} = await import('../../src/main/workflows/workflow-task-hold');
// The catch-up hook a hold's release shares with the workflow's own Resume.
const { setWorkflowCatchUp } = await import('../../src/main/workflows/workflow-catch-up');

const PROJECT_ID = 'project-1';
const WORKING_COLUMN: Pick<Swimlane, 'id' | 'role'> = { id: 'column-executing', role: null };

interface FakeSession {
  id: string;
  taskId?: string;
  projectId?: string;
  status: string;
  agentSessionId?: string;
  isolatedSwimlaneId?: string;
}

function taskRow(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    display_id: 414,
    workflow_id: 'workflow-1',
    workflow_project_id: null,
    swimlane_id: WORKING_COLUMN.id,
    session_id: 'session-1',
    archived_at: null,
    automations_disabled: false,
    ...overrides,
  } as Task;
}

describe('applyAutomationsHoldChange', () => {
  let session: FakeSession | undefined;
  let currentWorkSerial: number | undefined;
  let activity: string;
  let column: Pick<Swimlane, 'id' | 'role'> | null;
  let context: IpcContext;
  let catchUp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getProjectRepos.mockReset();
    session = { id: 'session-1', taskId: 'task-1', projectId: PROJECT_ID, status: 'running', agentSessionId: 'agent-session-1', isolatedSwimlaneId: 'column-isolated' };
    currentWorkSerial = 41;
    activity = 'idle';
    column = WORKING_COLUMN;
    hoisted.getProjectRepos.mockImplementation(() => ({ swimlanes: { getById: () => column } }));
    context = {
      sessionManager: {
        getSession: vi.fn((sessionId: string) => (session && session.id === sessionId ? session : undefined)),
        currentWorkSerial: vi.fn(() => currentWorkSerial),
        getActivityCache: vi.fn(() => ({ 'session-1': activity })),
      },
    } as unknown as IpcContext;
    catchUp = vi.fn();
    setWorkflowCatchUp(catchUp as unknown as (resumed: SessionResumedPayload) => void);
    // The turn-end runner registers the real one; the module imports neither.
    setHoldReleaseRecoveryStart(hoisted.startWorkflowRecoveryOver);
  });

  afterEach(() => {
    // Module state: a registered hook outlives the test that set it.
    setWorkflowCatchUp(null);
    setHoldReleaseRecoveryStart(null);
  });

  const pause = (task: Task = taskRow({ automations_disabled: true })) =>
    applyAutomationsHoldChange(context, PROJECT_ID, taskRow({ automations_disabled: false, workflow_id: task.workflow_id }), task);
  const resume = (task: Task = taskRow({ automations_disabled: false })) =>
    applyAutomationsHoldChange(context, PROJECT_ID, taskRow({ automations_disabled: true, workflow_id: task.workflow_id }), task);

  function expectNothingDone(): void {
    expect(hoisted.notifyWorkflowOfTask).not.toHaveBeenCalled();
    expect(hoisted.supersedeTurnEndWork).not.toHaveBeenCalled();
    expect(hoisted.startWorkflowRecoveryOver).not.toHaveBeenCalled();
    expect(catchUp).not.toHaveBeenCalled();
    expect(hoisted.getProjectRepos).not.toHaveBeenCalled();
  }

  describe('a flip that is no change, or a task in no workflow', () => {
    it('does nothing when the flag was off and stays off, after a pause (the control) that does something', () => {
      pause();
      expect(hoisted.supersedeTurnEndWork).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();

      applyAutomationsHoldChange(context, PROJECT_ID, taskRow({ automations_disabled: false }), taskRow({ automations_disabled: false }));

      expectNothingDone();
    });

    it('does nothing when the flag was on and stays on, after a resume (the control) that does something', () => {
      resume();
      expect(hoisted.startWorkflowRecoveryOver).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();

      applyAutomationsHoldChange(context, PROJECT_ID, taskRow({ automations_disabled: true }), taskRow({ automations_disabled: true }));

      expectNothingDone();
    });

    it('does nothing for a task in no workflow, though its flag changed, after the same flip in a workflow (the control)', () => {
      pause();
      expect(hoisted.supersedeTurnEndWork).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();

      pause(taskRow({ automations_disabled: true, workflow_id: null }));
      expectNothingDone();

      resume(taskRow({ automations_disabled: false, workflow_id: null }));
      expectNothingDone();
    });

    it('reads the flag through the shared gate: 0 and 1 from a raw row count as off and on', () => {
      // SQLite hands the switch back as 0 or 1 before the repository maps it.
      applyAutomationsHoldChange(
        context,
        PROJECT_ID,
        taskRow({ automations_disabled: 0 as unknown as boolean }),
        taskRow({ automations_disabled: 1 as unknown as boolean }),
      );

      expect(hoisted.supersedeTurnEndWork).toHaveBeenCalledWith('task-1');
    });
  });

  describe('pausing a workflow task\'s automations', () => {
    it('stops the task\'s turn-end work and tells the workflow\'s views, once each', () => {
      const held = taskRow({ automations_disabled: true });

      applyAutomationsHoldChange(context, PROJECT_ID, taskRow({ automations_disabled: false }), held);

      expect(hoisted.supersedeTurnEndWork).toHaveBeenCalledTimes(1);
      expect(hoisted.supersedeTurnEndWork).toHaveBeenCalledWith('task-1');
      expect(hoisted.notifyWorkflowOfTask).toHaveBeenCalledTimes(1);
      expect(hoisted.notifyWorkflowOfTask).toHaveBeenCalledWith(held, PROJECT_ID);
    });

    it('starts no recovery and catches up no agent, whatever the column and session', () => {
      pause();

      expect(hoisted.startWorkflowRecoveryOver).not.toHaveBeenCalled();
      expect(catchUp).not.toHaveBeenCalled();
      // It does not even read the column: nothing about a pause depends on it.
      expect(hoisted.getProjectRepos).not.toHaveBeenCalled();
    });

    it('stops the turn-end work of a held task in To Do or Done too, which has none to stop', () => {
      column = { id: 'column-todo', role: 'todo' };
      pause(taskRow({ automations_disabled: true, swimlane_id: 'column-todo' }));
      column = { id: 'column-done', role: 'done' };
      pause(taskRow({ automations_disabled: true, swimlane_id: 'column-done' }));

      expect(hoisted.supersedeTurnEndWork).toHaveBeenCalledTimes(2);
    });
  });

  describe('resuming a workflow task\'s automations in a working column', () => {
    it('starts the task\'s recovery over, on its column and workflow, with the release detail', () => {
      resume();

      expect(hoisted.startWorkflowRecoveryOver).toHaveBeenCalledTimes(1);
      expect(hoisted.startWorkflowRecoveryOver).toHaveBeenCalledWith(
        context,
        { projectId: PROJECT_ID, taskId: 'task-1', columnId: WORKING_COLUMN.id, workflowId: 'workflow-1' },
        { detail: HOLD_RELEASE_RECOVERY_DETAIL },
      );
      expect(HOLD_RELEASE_RECOVERY_DETAIL).toBe('Recovery starts over: automations resumed.');
    });

    it('tells the workflow\'s views, and stops nothing that was already stopped by the pause', () => {
      const released = taskRow({ automations_disabled: false });

      resume(released);

      expect(hoisted.notifyWorkflowOfTask).toHaveBeenCalledTimes(1);
      expect(hoisted.notifyWorkflowOfTask).toHaveBeenCalledWith(released, PROJECT_ID);
      expect(hoisted.supersedeTurnEndWork).not.toHaveBeenCalled();
    });

    it('catches up a live agent at the session\'s own work serial, after the recovery started over', () => {
      resume();

      expect(catchUp).toHaveBeenCalledTimes(1);
      expect(catchUp).toHaveBeenCalledWith({
        sessionId: 'session-1',
        taskId: 'task-1',
        projectId: PROJECT_ID,
        agentSessionId: 'agent-session-1',
        isolatedSwimlaneId: 'column-isolated',
        workSerial: 41,
        resumedBy: 'user',
      });
      expect(context.sessionManager.currentWorkSerial).toHaveBeenCalledWith('session-1');
      // The recovery's start row first: the catch-up's verdict rebuilds from it.
      const recoveryOrder = hoisted.startWorkflowRecoveryOver.mock.invocationCallOrder[0];
      const catchUpOrder = catchUp.mock.invocationCallOrder[0];
      expect(recoveryOrder).toBeLessThan(catchUpOrder);
    });

    it('catches up at whatever serial the session is on, so a turn the user started meanwhile reads as newer', () => {
      currentWorkSerial = 97;

      resume();

      expect(catchUp.mock.calls[0][0]).toMatchObject({ workSerial: 97 });
    });

    it('carries null for an agent session id and an isolated column the session does not have', () => {
      session = { id: 'session-1', taskId: 'task-1', projectId: PROJECT_ID, status: 'running' };

      resume();

      expect(catchUp).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: null, isolatedSwimlaneId: null }));
    });

    it('catches up no agent whose session is suspended, though its recovery starts over', () => {
      // The control: the same fixture with the session running catches up.
      resume();
      expect(catchUp).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();

      session = { id: 'session-1', status: 'suspended' };
      resume();

      expect(hoisted.startWorkflowRecoveryOver).toHaveBeenCalledTimes(1);
      expect(catchUp).not.toHaveBeenCalled();
    });

    it.each(['exited', 'queued', 'starting'])('catches up no agent whose session is %s', (status) => {
      session = { id: 'session-1', status };

      resume();

      expect(hoisted.startWorkflowRecoveryOver).toHaveBeenCalledTimes(1);
      expect(catchUp).not.toHaveBeenCalled();
    });

    it('catches up no agent when the task has no session, without looking for one', () => {
      resume(taskRow({ automations_disabled: false, session_id: null }));

      expect(hoisted.startWorkflowRecoveryOver).toHaveBeenCalledTimes(1);
      expect(catchUp).not.toHaveBeenCalled();
      expect(context.sessionManager.getSession).not.toHaveBeenCalled();
    });

    it('catches up no agent when the session manager no longer holds the session', () => {
      session = undefined;

      resume();

      expect(hoisted.startWorkflowRecoveryOver).toHaveBeenCalledTimes(1);
      expect(catchUp).not.toHaveBeenCalled();
    });

    it('catches up no agent whose work serial is unknown', () => {
      currentWorkSerial = undefined;

      resume();

      expect(hoisted.startWorkflowRecoveryOver).toHaveBeenCalledTimes(1);
      expect(catchUp).not.toHaveBeenCalled();
    });

    it('catches up no agent that is working, since its own turn end judges that turn', () => {
      // The control: the same fixture with the agent idle catches up.
      resume();
      expect(catchUp).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();

      activity = 'thinking';
      resume();

      expect(hoisted.startWorkflowRecoveryOver).toHaveBeenCalledTimes(1);
      expect(catchUp).not.toHaveBeenCalled();
    });

    it('starts the recovery over and does not throw when the turn-end runner never registered its hook', () => {
      setWorkflowCatchUp(null);

      expect(() => resume()).not.toThrow();

      expect(hoisted.startWorkflowRecoveryOver).toHaveBeenCalledTimes(1);
      expect(catchUp).not.toHaveBeenCalled();
    });
  });

  describe('resuming where the workflow has nothing to restart', () => {
    // Each case differs from the working-column fixture in one fact, and the
    // working-column fixture is asserted first so a "nothing" cannot come from a
    // mock that was never wired.
    function expectRestartedHere(): void {
      resume();
      expect(hoisted.startWorkflowRecoveryOver).toHaveBeenCalledTimes(1);
      expect(catchUp).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();
    }

    it.each([
      ['To Do', { id: 'column-todo', role: 'todo' as const }],
      ['Done', { id: 'column-done', role: 'done' as const }],
    ])('starts no recovery and catches up no agent in %s', (_label, otherColumn) => {
      expectRestartedHere();
      column = otherColumn;

      resume(taskRow({ automations_disabled: false, swimlane_id: otherColumn.id }));

      expect(hoisted.startWorkflowRecoveryOver).not.toHaveBeenCalled();
      expect(catchUp).not.toHaveBeenCalled();
      // The views still re-read: the card's strip and the inspector follow the flag.
      expect(hoisted.notifyWorkflowOfTask).toHaveBeenCalledTimes(1);
    });

    it('starts no recovery and catches up no agent for an archived task', () => {
      expectRestartedHere();

      resume(taskRow({ automations_disabled: false, archived_at: '2026-10-25T06:00:00.000Z' }));

      expect(hoisted.startWorkflowRecoveryOver).not.toHaveBeenCalled();
      expect(catchUp).not.toHaveBeenCalled();
      expect(hoisted.notifyWorkflowOfTask).toHaveBeenCalledTimes(1);
    });

    it('starts no recovery and catches up no agent when the board no longer has the task\'s column', () => {
      expectRestartedHere();
      column = null;

      resume();

      expect(hoisted.startWorkflowRecoveryOver).not.toHaveBeenCalled();
      expect(catchUp).not.toHaveBeenCalled();
    });
  });

  describe('a failure inside the hold', () => {
    it('is logged and never thrown at the write\'s caller, which has already written the row', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        hoisted.startWorkflowRecoveryOver.mockImplementationOnce(() => {
          throw new Error('run log unavailable');
        });

        expect(() => resume()).not.toThrow();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not apply the automations switch on task task-1'), expect.any(Error));
      } finally {
        warn.mockRestore();
      }
    });

    it('is logged when the pause\'s supersede throws, and the views were already told', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        hoisted.supersedeTurnEndWork.mockImplementationOnce(() => {
          throw new Error('controller gone');
        });

        expect(() => pause()).not.toThrow();

        expect(hoisted.notifyWorkflowOfTask).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
