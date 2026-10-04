/**
 * The workflow engine's pure parts: a task's route, the start and completion
 * plan, the loop check, and the move lock. No database, no Electron.
 */
import { describe, it, expect } from 'vitest';
import {
  nextOnRoute,
  routeCandidates,
  routeColumns,
  startColumn,
  type RouteColumn,
  type RouteFields,
} from '../../src/shared/workflow-route';
import {
  blockersDone,
  inFlightKey,
  isComplete,
  planPass,
  readyTasks,
  wouldCreateCycle,
  type CoreTask,
  type CoreWorkflow,
} from '../../src/main/workflows/engine/workflow-engine-core';
import { workflowMoveRefusal, type WorkflowMoveCheck } from '../../src/shared/workflow-lock';

function column(id: string, position: number, role: RouteColumn['role'] = null, extra: Partial<RouteColumn> = {}): RouteColumn {
  return { id, position, role, is_archived: false, is_ghost: false, ...extra };
}

// To Do, Planning, Executing, Code Review, Testing, Done
const BOARD: RouteColumn[] = [
  column('todo', 0, 'todo'),
  column('planning', 1),
  column('executing', 2),
  column('review', 3),
  column('testing', 4),
  column('done', 5, 'done'),
];

const OPEN_ROUTE: RouteFields = { route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [] };

describe('a task route', () => {
  it('defaults to every column between To Do and Done', () => {
    expect(routeColumns(BOARD, OPEN_ROUTE).map((entry) => entry.id)).toEqual(['planning', 'executing', 'review', 'testing']);
  });

  it('leaves out archived and ghost columns', () => {
    const board = [...BOARD, column('ghost', 6, null, { is_ghost: true }), column('old', 7, null, { is_archived: true })];
    expect(routeCandidates(board).map((entry) => entry.id)).toEqual(['planning', 'executing', 'review', 'testing']);
  });

  it('starts, ends and skips where the task says', () => {
    const route: RouteFields = { route_start_swimlane_id: 'executing', route_last_swimlane_id: 'review', skipped_swimlane_ids: [] };
    expect(routeColumns(BOARD, route).map((entry) => entry.id)).toEqual(['executing', 'review']);
    const skipping: RouteFields = { ...OPEN_ROUTE, skipped_swimlane_ids: ['planning', 'review'] };
    expect(routeColumns(BOARD, skipping).map((entry) => entry.id)).toEqual(['executing', 'testing']);
  });

  it('falls back to the open end when a named start or last column is gone', () => {
    const route: RouteFields = { route_start_swimlane_id: 'deleted', route_last_swimlane_id: 'also-deleted', skipped_swimlane_ids: [] };
    expect(routeColumns(BOARD, route).map((entry) => entry.id)).toEqual(['planning', 'executing', 'review', 'testing']);
  });

  it('includes a column added inside the range later, by default', () => {
    const grown = [...BOARD, column('security', 3.5)];
    expect(routeColumns(grown, OPEN_ROUTE).map((entry) => entry.id)).toContain('security');
  });

  it('starts in the first route column, from To Do', () => {
    const skipping: RouteFields = { ...OPEN_ROUTE, skipped_swimlane_ids: ['planning'] };
    expect(startColumn(BOARD, skipping)?.id).toBe('executing');
    expect(nextOnRoute(BOARD, skipping, 'todo')?.id).toBe('executing');
  });

  it('moves on to the next route column, and to Done after the last', () => {
    const route: RouteFields = { ...OPEN_ROUTE, route_last_swimlane_id: 'review' };
    expect(nextOnRoute(BOARD, route, 'executing')?.id).toBe('review');
    expect(nextOnRoute(BOARD, route, 'review')?.id).toBe('done');
  });

  it('continues from a skipped column a task was moved into', () => {
    const skipping: RouteFields = { ...OPEN_ROUTE, skipped_swimlane_ids: ['review'] };
    expect(nextOnRoute(BOARD, skipping, 'review')?.id).toBe('testing');
  });

  it('starts an empty route in Done, and has nothing after Done', () => {
    const empty: RouteFields = { route_start_swimlane_id: 'testing', route_last_swimlane_id: 'planning', skipped_swimlane_ids: [] };
    expect(startColumn(BOARD, empty)?.id).toBe('done');
    expect(nextOnRoute(BOARD, OPEN_ROUTE, 'done')).toBeNull();
  });
});

function coreTask(taskId: string, place: CoreTask['place'], extra: Partial<CoreTask> = {}): CoreTask {
  return {
    projectId: 'home',
    taskId,
    displayId: Number(taskId.replace(/\D/g, '')) || 1,
    place,
    todoPosition: 0,
    startColumnId: 'executing',
    startTakesSlot: true,
    ...extra,
  };
}

function link(blocker: string, blocked: string) {
  return { blockerProjectId: 'home', blockerTaskId: blocker, blockedProjectId: 'home', blockedTaskId: blocked };
}

function workflow(tasks: CoreTask[], links = [] as ReturnType<typeof link>[], extra: Partial<CoreWorkflow> = {}): CoreWorkflow {
  return { workflowId: 'w1', homeProjectId: 'home', state: 'running', startedAt: '2026-10-04T00:00:00.000Z', tasks, links, ...extra };
}

describe('the start and completion plan', () => {
  it('starts a task only when every blocker is in Done', () => {
    const plan = workflow(
      [coreTask('t1', 'done'), coreTask('t2', 'working'), coreTask('t3', 'todo'), coreTask('t4', 'todo')],
      [link('t1', 't3'), link('t1', 't4'), link('t2', 't4')],
    );
    expect(readyTasks(plan).map((task) => task.taskId)).toEqual(['t3']);
  });

  it('never counts a blocker that is gone as done', () => {
    const plan = workflow([coreTask('t2', 'todo')], [link('deleted', 't2')]);
    expect(blockersDone(plan, plan.tasks[0])).toBe(false);
    expect(readyTasks(plan)).toEqual([]);
  });

  it('starts in To Do order, up to the free slots', () => {
    const plan = workflow([
      coreTask('t1', 'todo', { todoPosition: 2 }),
      coreTask('t2', 'todo', { todoPosition: 0 }),
      coreTask('t3', 'todo', { todoPosition: 1 }),
    ]);
    const intents = planPass([plan], 2, new Set());
    expect(intents.map((intent) => intent.kind === 'start' ? intent.taskId : intent.kind)).toEqual(['t2', 't3']);
  });

  it('lets a start into a column that runs no agent take no slot', () => {
    const plan = workflow([
      coreTask('t1', 'todo', { todoPosition: 0 }),
      coreTask('t2', 'todo', { todoPosition: 1, startTakesSlot: false }),
    ]);
    const intents = planPass([plan], 0, new Set());
    expect(intents.map((intent) => intent.kind === 'start' ? intent.taskId : intent.kind)).toEqual(['t2']);
  });

  it('does not issue a start already in flight', () => {
    const plan = workflow([coreTask('t1', 'todo')]);
    expect(planPass([plan], 4, new Set([inFlightKey('home', 't1')]))).toEqual([]);
  });

  it('starts nothing in a paused workflow, and completes one whose tasks are all done', () => {
    const paused = workflow([coreTask('t1', 'todo')], [], { state: 'paused' });
    expect(planPass([paused], 4, new Set())).toEqual([]);
    const finished = workflow([coreTask('t1', 'done'), coreTask('t2', 'done')], [], { state: 'paused' });
    expect(planPass([finished], 4, new Set())).toEqual([{ kind: 'complete', workflowId: 'w1', homeProjectId: 'home' }]);
  });

  it('never calls an empty workflow complete', () => {
    expect(isComplete(workflow([]))).toBe(false);
  });

  it('serves the workflow started first when slots are short', () => {
    const later = workflow([coreTask('late', 'todo')], [], { workflowId: 'w2', startedAt: '2026-10-04T02:00:00.000Z' });
    const earlier = workflow([coreTask('early', 'todo')], [], { workflowId: 'w1', startedAt: '2026-10-04T01:00:00.000Z' });
    const intents = planPass([later, earlier], 1, new Set());
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: 'start', taskId: 'early' });
  });
});

describe('the loop check', () => {
  const links = [
    { blockerTaskId: 'a', blockedTaskId: 'b' },
    { blockerTaskId: 'b', blockedTaskId: 'c' },
  ];

  it('refuses a link that would close a loop, or link a task to itself', () => {
    expect(wouldCreateCycle(links, 'c', 'a')).toBe(true);
    expect(wouldCreateCycle(links, 'a', 'a')).toBe(true);
  });

  it('allows a link that adds no loop', () => {
    expect(wouldCreateCycle(links, 'a', 'c')).toBe(false);
    expect(wouldCreateCycle(links, 'd', 'a')).toBe(false);
  });
});

describe('the move lock', () => {
  function check(extra: Partial<WorkflowMoveCheck>): WorkflowMoveCheck {
    return {
      displayId: 414,
      workflowTitle: 'Usage budgets',
      workflowState: 'running',
      origin: 'renderer',
      fromSwimlaneId: 'executing',
      toSwimlaneId: 'review',
      toRole: null,
      moverIsTaskAgent: false,
      humanGateTargetId: null,
      ...extra,
    };
  }

  it('refuses a drag of a running workflow task, naming the workflow', () => {
    expect(workflowMoveRefusal(check({}))).toBe('#414 is locked while Usage budgets runs.');
  });

  it('lets the workflow, its automations, plan exit and the task\'s own agent move it', () => {
    expect(workflowMoveRefusal(check({ origin: 'workflow' }))).toBeNull();
    expect(workflowMoveRefusal(check({ origin: 'automation' }))).toBeNull();
    expect(workflowMoveRefusal(check({ origin: 'auto-move' }))).toBeNull();
    expect(workflowMoveRefusal(check({ origin: 'agent', moverIsTaskAgent: true }))).toBeNull();
  });

  it('refuses another agent and the phone while it runs', () => {
    expect(workflowMoveRefusal(check({ origin: 'agent' }))).not.toBeNull();
    expect(workflowMoveRefusal(check({ origin: 'mobile' }))).not.toBeNull();
  });

  it('lets a person drag a card out of a human gate, only to the next column on its route', () => {
    expect(workflowMoveRefusal(check({ humanGateTargetId: 'review' }))).toBeNull();
    expect(workflowMoveRefusal(check({ humanGateTargetId: 'testing' }))).not.toBeNull();
  });

  it('lets a paused workflow\'s cards move by hand, but never into To Do', () => {
    expect(workflowMoveRefusal(check({ workflowState: 'paused' }))).toBeNull();
    expect(workflowMoveRefusal(check({ workflowState: 'paused', toSwimlaneId: 'todo', toRole: 'todo' })))
      .toBe('#414 is in Usage budgets. Remove it from the workflow to move it to To Do.');
  });

  it('refuses To Do even for the task\'s own agent', () => {
    expect(workflowMoveRefusal(check({ origin: 'agent', moverIsTaskAgent: true, toSwimlaneId: 'todo', toRole: 'todo' }))).not.toBeNull();
  });

  it('never refuses a reorder, or a task in a finished workflow', () => {
    expect(workflowMoveRefusal(check({ toSwimlaneId: 'executing' }))).toBeNull();
    expect(workflowMoveRefusal(check({ workflowState: 'done' }))).toBeNull();
  });
});
