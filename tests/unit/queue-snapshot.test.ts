/**
 * The line for an agent slot, as the cards and the task detail read it.
 */
import { describe, it, expect, vi } from 'vitest';
import { queuePlaceOf } from '../../src/shared/queue-place';
import type { QueuedInput } from '../../src/main/pty/session-queue';
import type { CappedColumnTask } from '../../src/main/db/repositories/task-move-repository';

vi.mock('../../src/main/db/database', () => ({ getOpenProjectDb: vi.fn(() => null) }));

const { buildQueueSnapshot, readQueueSnapshot, EMPTY_QUEUE_SNAPSHOT } = await import('../../src/main/ipc/helpers/queue-snapshot');

const PROJECT = 'project-a';

function entry(taskId: string, overrides: Partial<QueuedInput> = {}): QueuedInput {
  return { id: `session-${taskId}`, taskId, projectId: PROJECT, command: 'mock', cwd: '/tmp', ...overrides };
}

function capped(taskId: string, enteredAt: string, swimlaneId = 'merge', maxAgents = 1): CappedColumnTask {
  return { taskId, swimlaneId, swimlaneName: 'Merge', maxAgents, enteredAt };
}

function holder(taskId: string) {
  return { projectId: PROJECT, taskId, sessionId: `session-${taskId}` };
}

function reads(cappedTasks: CappedColumnTask[]) {
  return () => ({
    name: 'Sample app',
    cappedTasks,
    task: (taskId: string) => ({ title: `Title ${taskId}`, displayId: 7 }),
  });
}

describe('buildQueueSnapshot', () => {
  it('orders a column by entry, and keeps the global line in queue order', () => {
    const snapshot = buildQueueSnapshot(
      [entry('second'), entry('first')],
      [],
      reads([capped('second', '2026-01-02'), capped('first', '2026-01-01')]),
    );

    expect(snapshot.columns[0].waiting.map((task) => task.taskId)).toEqual(['first', 'second']);
    expect(snapshot.global.map((task) => task.taskId)).toEqual(['second', 'first']);
  });

  it('names the agents holding the column, and only that column\'s', () => {
    const snapshot = buildQueueSnapshot(
      [entry('waiting')],
      [holder('running'), holder('elsewhere')],
      reads([capped('running', '2026-01-01'), capped('waiting', '2026-01-02'), capped('elsewhere', '2026-01-01', 'testing')]),
    );

    expect(snapshot.columns[0].holders.map((task) => task.taskId)).toEqual(['running']);
    expect(snapshot.columns[0].columnName).toBe('Merge');
  });

  it('puts a task in no limited column in the global line only', () => {
    const snapshot = buildQueueSnapshot([entry('free')], [], reads([]));

    expect(snapshot.columns).toEqual([]);
    expect(snapshot.global.map((task) => task.title)).toEqual(['Title free']);
  });

  it('never puts a Command Terminal in a column', () => {
    const snapshot = buildQueueSnapshot([entry('terminal', { transient: true })], [], reads([capped('terminal', '2026-01-01')]));
    expect(snapshot.columns).toEqual([]);
  });

  it('keeps the place of a task whose project cannot be read', () => {
    const snapshot = buildQueueSnapshot([entry('gone')], [], () => null);
    expect(snapshot.global).toEqual([expect.objectContaining({ taskId: 'gone', title: null, displayId: null })]);
  });

  it('carries the column\'s limit on its line', () => {
    const snapshot = buildQueueSnapshot(
      [entry('waiting')],
      [holder('running')],
      reads([capped('running', '2026-01-01', 'merge', 3), capped('waiting', '2026-01-02', 'merge', 3)]),
    );

    expect(snapshot.columns[0].maxAgents).toBe(3);
  });

  it('reads each task once per snapshot, in its column and in the global line', () => {
    const task = vi.fn((taskId: string) => ({ title: `Title ${taskId}`, displayId: 7 }));
    const snapshot = buildQueueSnapshot(
      [entry('waiting')],
      [holder('running')],
      () => ({
        name: 'Sample app',
        cappedTasks: [capped('running', '2026-01-01'), capped('waiting', '2026-01-02')],
        task,
      }),
    );

    // The task sits in a limited column and in the global line, and is read for both.
    expect(snapshot.columns[0].waiting.map((waiting) => waiting.taskId)).toEqual(['waiting']);
    expect(snapshot.global.map((waiting) => waiting.taskId)).toEqual(['waiting']);
    expect(task.mock.calls.filter(([taskId]) => taskId === 'waiting')).toHaveLength(1);
    expect(task.mock.calls.filter(([taskId]) => taskId === 'running')).toHaveLength(1);
  });

  it('reads no database with an empty queue', () => {
    const listQueuedInputs = vi.fn(() => []);
    const listColumnHolders = vi.fn();
    const snapshot = readQueueSnapshot({ sessionManager: { listQueuedInputs, listColumnHolders } } as never);

    expect(snapshot).toBe(EMPTY_QUEUE_SNAPSHOT);
    expect(listColumnHolders).not.toHaveBeenCalled();
  });
});

describe('queuePlaceOf', () => {
  const snapshotWith = (holders: string[], waiting: string[], global: string[]) => buildQueueSnapshot(
    global.map((taskId) => entry(taskId)),
    holders.map(holder),
    reads([...holders, ...waiting].map((taskId, index) => capped(taskId, `2026-01-0${index + 1}`))),
  );

  it('counts the running agent first in a column, so the numbers match the column', () => {
    const snapshot = snapshotWith(['running'], ['second', 'third'], ['second', 'third']);

    expect(queuePlaceOf(snapshot, 'session-second')).toMatchObject({ kind: 'column', position: 2, total: 3 });
    expect(queuePlaceOf(snapshot, 'session-third')).toMatchObject({ kind: 'column', position: 3, total: 3 });
  });

  it('counts every agent over a limit that was turned on late', () => {
    const snapshot = snapshotWith(['one', 'two'], ['waiting'], ['waiting']);
    expect(queuePlaceOf(snapshot, 'session-waiting')).toMatchObject({ kind: 'column', position: 3, total: 3 });
  });

  it('reads a task its column does not hold back as waiting for a free agent slot', () => {
    const snapshot = snapshotWith([], ['first'], ['other', 'first']);
    expect(queuePlaceOf(snapshot, 'session-first')).toEqual({ kind: 'global', position: 2, total: 2 });
  });

  it('holds the second in an idle column to its column', () => {
    const snapshot = snapshotWith([], ['first', 'second'], ['first', 'second']);
    expect(queuePlaceOf(snapshot, 'session-second')).toMatchObject({ kind: 'column', position: 2, total: 2 });
  });

  describe('a column with room for more than one agent', () => {
    // Limit 2 with one agent running: the first waiter fits in the column and
    // waits only for a free agent slot, the second is what the column holds back.
    const snapshotOfLimitTwo = () => buildQueueSnapshot(
      [entry('first'), entry('second')],
      [holder('running')],
      reads([
        capped('running', '2026-01-01', 'merge', 2),
        capped('first', '2026-01-02', 'merge', 2),
        capped('second', '2026-01-03', 'merge', 2),
      ]),
    );

    it('reads a waiter the column has room for as waiting for a free agent slot', () => {
      expect(queuePlaceOf(snapshotOfLimitTwo(), 'session-first')).toEqual({ kind: 'global', position: 1, total: 2 });
    });

    it('holds the waiter past the limit to its column', () => {
      expect(queuePlaceOf(snapshotOfLimitTwo(), 'session-second')).toMatchObject({
        kind: 'column',
        position: 3,
        total: 3,
        line: { maxAgents: 2 },
      });
    });

    it('reads a lone waiter at the limit as its column, since no room is left', () => {
      const snapshot = buildQueueSnapshot(
        [entry('first')],
        [holder('one'), holder('two')],
        reads([
          capped('one', '2026-01-01', 'merge', 2),
          capped('two', '2026-01-02', 'merge', 2),
          capped('first', '2026-01-03', 'merge', 2),
        ]),
      );
      expect(queuePlaceOf(snapshot, 'session-first')).toMatchObject({ kind: 'column', position: 3, total: 3 });
    });
  });

  it('counts a task in no limited column among all queued tasks', () => {
    const snapshot = buildQueueSnapshot([entry('a'), entry('b'), entry('c')], [], reads([]));
    expect(queuePlaceOf(snapshot, 'session-b')).toEqual({ kind: 'global', position: 2, total: 3 });
  });

  it('is null for a session not in the line', () => {
    expect(queuePlaceOf({ columns: [], global: [] }, 'session-x')).toBeNull();
  });
});
