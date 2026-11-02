/**
 * Unit tests for the column agent limit, the queue's gate. Pure logic over
 * injected reads: who is in a limited column, when they entered it, and who
 * holds a slot.
 */
import { describe, it, expect, vi } from 'vitest';
import { createColumnCapacityGate } from '../../src/main/transition-engine/column-capacity';
import type { ColumnHolder } from '../../src/main/pty/session-queue';
import type { CappedColumnTask } from '../../src/main/db/repositories/task-move-repository';
import type { QueuedInput } from '../../src/main/pty/session-queue';

const PROJECT = 'project-a';

function capped(taskId: string, enteredAt: string, swimlaneId = 'merge', maxAgents = 1): CappedColumnTask {
  return { taskId, swimlaneId, swimlaneName: swimlaneId, maxAgents, enteredAt };
}

function queued(taskId: string, projectId = PROJECT): QueuedInput {
  return { id: `session-${taskId}`, taskId, projectId, command: 'mock', cwd: '/tmp' };
}

function holder(taskId: string, projectId = PROJECT): ColumnHolder {
  return { projectId, taskId, sessionId: 'session-' + taskId };
}

function gateOver(tasks: CappedColumnTask[], holders: ColumnHolder[] = []) {
  return createColumnCapacityGate({ listCappedTasks: () => tasks, listHolders: () => holders });
}

describe('column capacity gate', () => {
  describe('mustWait', () => {
    it('admits a task in a column with no limit', () => {
      expect(gateOver([]).mustWait(queued('free'), [])).toBe(false);
    });

    it('holds a task when another agent fills its column', () => {
      const gate = gateOver([capped('running', '2026-01-01'), capped('next', '2026-01-02')], [holder('running')]);
      expect(gate.mustWait(queued('next'), [])).toBe(true);
    });

    it('does not count the task against itself', () => {
      const gate = gateOver([capped('restarting', '2026-01-01')], [holder('restarting')]);
      expect(gate.mustWait(queued('restarting'), [])).toBe(false);
    });

    it('a holder in another column of the same board takes no slot here', () => {
      const gate = gateOver([capped('elsewhere', '2026-01-01', 'testing'), capped('next', '2026-01-02')], [holder('elsewhere')]);
      expect(gate.mustWait(queued('next'), [])).toBe(false);
    });

    it('a column over its limit still holds a new start', () => {
      const gate = gateOver(
        [capped('first', '2026-01-01'), capped('second', '2026-01-02'), capped('third', '2026-01-03')],
        [holder('first'), holder('second')],
      );
      expect(gate.mustWait(queued('third'), [])).toBe(true);
    });

    it('does not let a later task past one already waiting', () => {
      const gate = gateOver([capped('earlier', '2026-01-01'), capped('later', '2026-01-02')]);
      expect(gate.mustWait(queued('later'), [queued('earlier')])).toBe(true);
    });

    it('lets an earlier task start ahead of a later one still waiting', () => {
      const gate = gateOver([capped('earlier', '2026-01-01'), capped('later', '2026-01-02')]);
      expect(gate.mustWait(queued('earlier'), [queued('later')])).toBe(false);
    });

    describe('a restart keeping its slot', () => {
      // The suspend of an in-place restart would hand its slot to the next task
      // in line, so the manager holds it under a null session id. The respawn
      // is that task's own slot coming back, not a new arrival.
      const restartHold: ColumnHolder = { projectId: PROJECT, taskId: 'T', sessionId: null };

      it('is not held behind an earlier task queued for the column', () => {
        const gate = gateOver([capped('U', '2026-01-01'), capped('T', '2026-01-02')], [restartHold]);
        expect(gate.mustWait(queued('T'), [queued('U')])).toBe(false);
      });

      it('is not held when another agent already fills the column past its limit', () => {
        // V is running in a limit of 1 that was turned on after both entered.
        const gate = gateOver(
          [capped('V', '2026-01-01'), capped('U', '2026-01-02'), capped('T', '2026-01-03')],
          [holder('V'), restartHold],
        );
        expect(gate.mustWait(queued('T'), [queued('U')])).toBe(false);
      });

      it('gets no pass from an ordinary running holder row', () => {
        const gate = gateOver([capped('U', '2026-01-01'), capped('T', '2026-01-02')], [holder('T')]);
        expect(gate.mustWait(queued('T'), [queued('U')])).toBe(true);
      });

      it('gets no pass from an ordinary running holder row in a full column either', () => {
        const gate = gateOver(
          [capped('V', '2026-01-01'), capped('T', '2026-01-02')],
          [holder('V'), holder('T')],
        );
        expect(gate.mustWait(queued('T'), [])).toBe(true);
      });

      it('is assumed from no holder: without the hold, T waits behind an earlier U', () => {
        const gate = gateOver([capped('U', '2026-01-01'), capped('T', '2026-01-02')]);
        expect(gate.mustWait(queued('T'), [queued('U')])).toBe(true);
      });

      it('passes only the task holding it, not another asking for the same column', () => {
        const gate = gateOver([capped('U', '2026-01-01'), capped('T', '2026-01-02'), capped('W', '2026-01-03')], [restartHold]);
        expect(gate.mustWait(queued('W'), [queued('U')])).toBe(true);
      });

      it('passes only the project holding it', () => {
        const gate = createColumnCapacityGate({
          listCappedTasks: () => [capped('U', '2026-01-01'), capped('T', '2026-01-02')],
          listHolders: () => [{ projectId: 'project-b', taskId: 'T', sessionId: null }],
        });
        expect(gate.mustWait(queued('T'), [queued('U')])).toBe(true);
      });
    });

    it('exempts a Command Terminal and a workflow agent', () => {
      const gate = gateOver([capped('running', '2026-01-01'), capped('next', '2026-01-02')], [holder('running')]);
      expect(gate.mustWait({ ...queued('next'), transient: true }, [])).toBe(false);
      expect(gate.mustWait({ ...queued('next'), workflowId: 'workflow-1' }, [])).toBe(false);
    });

    it('admits a task whose project database is closed', () => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const gate = createColumnCapacityGate({ listCappedTasks: () => null, listHolders: () => [] });
      expect(gate.mustWait(queued('task'), [])).toBe(false);
      warning.mockRestore();
    });
  });

  describe('pick', () => {
    it('takes the column\'s earliest entry, not the queue\'s', () => {
      const gate = gateOver([capped('entered-second', '2026-01-02'), capped('entered-first', '2026-01-01')]);
      expect(gate.pick([queued('entered-second'), queued('entered-first')])).toBe(1);
    });

    it('skips a full column and takes what can start', () => {
      const gate = gateOver([capped('running', '2026-01-01'), capped('blocked', '2026-01-02')], [holder('running')]);
      expect(gate.pick([queued('blocked'), queued('uncapped')])).toBe(1);
    });

    it('reports nothing can start', () => {
      const gate = gateOver([capped('running', '2026-01-01'), capped('blocked', '2026-01-02')], [holder('running')]);
      expect(gate.pick([queued('blocked')])).toBe(-1);
    });

    it('keeps two columns independent', () => {
      const gate = gateOver([
        capped('running', '2026-01-01', 'merge'),
        capped('blocked', '2026-01-02', 'merge'),
        capped('other', '2026-01-03', 'testing'),
      ], [holder('running')]);
      expect(gate.pick([queued('blocked'), queued('other')])).toBe(1);
    });

    it('breaks a tie by queue order', () => {
      const gate = gateOver([capped('one', '2026-01-01'), capped('two', '2026-01-01')]);
      expect(gate.pick([queued('one'), queued('two')])).toBe(0);
    });

    it('treats a same-named column in another project as its own', () => {
      const gate = createColumnCapacityGate({
        listCappedTasks: (projectId) => (projectId === PROJECT
          ? [capped('running', '2026-01-01'), capped('blocked', '2026-01-02')]
          : [capped('other-project', '2026-01-03')]),
        listHolders: () => [holder('running')],
      });
      expect(gate.pick([queued('blocked'), queued('other-project', 'project-b')])).toBe(1);
    });

    it('reads each project once in a pass', () => {
      const listCappedTasks = vi.fn(() => [capped('one', '2026-01-01'), capped('two', '2026-01-02')]);
      const gate = createColumnCapacityGate({ listCappedTasks, listHolders: () => [] });
      gate.pick([queued('one'), queued('two')]);
      expect(listCappedTasks).toHaveBeenCalledTimes(1);
    });
  });

  describe('countBlocked', () => {
    it('counts nothing for tasks with no limit', () => {
      expect(gateOver([]).countBlocked([queued('a'), queued('b')])).toBe(0);
    });

    it('leaves one start free in an empty limited column', () => {
      const gate = gateOver([capped('a', '2026-01-01'), capped('b', '2026-01-02'), capped('c', '2026-01-03')]);
      expect(gate.countBlocked([queued('a'), queued('b'), queued('c')])).toBe(2);
    });

    it('counts every entry of a full column', () => {
      const gate = gateOver([capped('running', '2026-01-01'), capped('a', '2026-01-02'), capped('b', '2026-01-03')], [holder('running')]);
      expect(gate.countBlocked([queued('a'), queued('b')])).toBe(2);
    });
  });
});
