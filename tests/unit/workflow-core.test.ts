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
import { workflowMoveRefusal, workflowMoveRefusalMessage, type WorkflowMoveCheck } from '../../src/shared/workflow-lock';
import { englishText } from '../../src/shared/i18n/english';
import { translateText } from '../../src/renderer/i18n/translate';

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
    held: false,
    ...extra,
  };
}

function link(blocker: string, blocked: string) {
  return { blockerProjectId: 'home', blockerTaskId: blocker, blockedProjectId: 'home', blockedTaskId: blocked };
}

function workflow(tasks: CoreTask[], links = [] as ReturnType<typeof link>[], extra: Partial<CoreWorkflow> = {}): CoreWorkflow {
  return { workflowId: 'w1', homeProjectId: 'home', state: 'running', startedAt: '2026-10-04T00:00:00.000Z', tasks, links, goneLinks: [], ...extra };
}

describe('the start and completion plan', () => {
  it('starts a task only when every blocker is in Done', () => {
    const plan = workflow(
      [coreTask('t1', 'done'), coreTask('t2', 'working'), coreTask('t3', 'todo'), coreTask('t4', 'todo')],
      [link('t1', 't3'), link('t1', 't4'), link('t2', 't4')],
    );
    expect(readyTasks(plan).map((task) => task.taskId)).toEqual(['t3']);
  });

  describe('a task whose own automations are paused', () => {
    // A held task stays in To Do for a person to work by hand, and what waits
    // for it keeps waiting, since only Done frees a blocker. Each case pairs
    // with the same plan for a task that is not held.
    it('is not ready, where the same task not held is', () => {
      expect(readyTasks(workflow([coreTask('t1', 'todo', { held: false })])).map((task) => task.taskId)).toEqual(['t1']);
      expect(readyTasks(workflow([coreTask('t1', 'todo', { held: true })]))).toEqual([]);
    });

    it('is passed over while the tasks after it in To Do order still start', () => {
      const plan = workflow([
        coreTask('t1', 'todo', { todoPosition: 0, held: true }),
        coreTask('t2', 'todo', { todoPosition: 1 }),
      ]);
      expect(readyTasks(plan).map((task) => task.taskId)).toEqual(['t2']);
      expect(planPass([plan], 4, new Set()).map((intent) => intent.kind === 'start' ? intent.taskId : intent.kind)).toEqual(['t2']);
    });

    it('takes no slot, so a free slot goes to the next task', () => {
      const plan = workflow([
        coreTask('t1', 'todo', { todoPosition: 0, held: true }),
        coreTask('t2', 'todo', { todoPosition: 1 }),
        coreTask('t3', 'todo', { todoPosition: 2 }),
      ]);
      const intents = planPass([plan], 1, new Set());
      expect(intents.map((intent) => intent.kind === 'start' ? intent.taskId : intent.kind)).toEqual(['t2']);
    });

    it('keeps what waits for it blocked, and leaves that task unstarted', () => {
      const heldBlocker = workflow(
        [coreTask('t1', 'todo', { held: true }), coreTask('t2', 'todo', { todoPosition: 1 })],
        [link('t1', 't2')],
      );
      expect(readyTasks(heldBlocker)).toEqual([]);
      expect(planPass([heldBlocker], 4, new Set())).toEqual([]);
      const freeBlocker = workflow(
        [coreTask('t1', 'todo', { held: false }), coreTask('t2', 'todo', { todoPosition: 1 })],
        [link('t1', 't2')],
      );
      // The blocker starts; its dependent waits for it to reach Done.
      expect(readyTasks(freeBlocker).map((task) => task.taskId)).toEqual(['t1']);
    });

    it('does not change blockersDone for a held blocker already in Done', () => {
      const plan = workflow(
        [coreTask('t1', 'done', { held: true }), coreTask('t2', 'todo')],
        [link('t1', 't2')],
      );
      expect(blockersDone(plan, plan.tasks[1])).toBe(true);
      expect(readyTasks(plan).map((task) => task.taskId)).toEqual(['t2']);
    });

    it('does not stop a workflow of held and finished tasks from completing', () => {
      const plan = workflow([coreTask('t1', 'done'), coreTask('t2', 'done', { held: true })]);
      expect(planPass([plan], 4, new Set())).toEqual([{ kind: 'complete', workflowId: 'w1', homeProjectId: 'home' }]);
    });
  });

  it('never counts a blocker missing from the snapshot as done', () => {
    // What is left missing in `links` is a blocker the host could not read: its
    // project's database may be failing to open for a moment.
    const plan = workflow([coreTask('t2', 'todo')], [link('unread', 't2')]);
    expect(blockersDone(plan, plan.tasks[0])).toBe(false);
    expect(readyTasks(plan)).toEqual([]);
    expect(planPass([plan], 4, new Set())).toEqual([]);
  });

  it('drops a link whose end is provably gone, and starts its task in the same pass', () => {
    const plan = workflow([coreTask('t2', 'todo')], [], { goneLinks: [link('deleted', 't2')] });
    expect(planPass([plan], 1, new Set())).toEqual([
      { kind: 'drop-links', workflowId: 'w1', homeProjectId: 'home', links: [link('deleted', 't2')] },
      { kind: 'start', workflowId: 'w1', homeProjectId: 'home', projectId: 'home', taskId: 't2', toSwimlaneId: 'executing', takesSlot: true },
    ]);
  });

  it('drops gone links of a paused workflow too, and starts nothing there', () => {
    const plan = workflow([coreTask('t2', 'todo')], [], { state: 'paused', goneLinks: [link('deleted', 't2')] });
    expect(planPass([plan], 1, new Set()).map((intent) => intent.kind)).toEqual(['drop-links']);
  });

  it('keeps a task waiting on a live blocker after its gone link is dropped', () => {
    const plan = workflow(
      [coreTask('t1', 'working'), coreTask('t2', 'todo')],
      [link('t1', 't2')],
      { goneLinks: [link('deleted', 't2')] },
    );
    expect(planPass([plan], 4, new Set()).map((intent) => intent.kind)).toEqual(['drop-links']);
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

  it('says on each start whether it spends an agent slot, so the host can hold one back while it is in flight', () => {
    const plan = workflow([
      coreTask('t1', 'todo', { todoPosition: 0 }),
      coreTask('t2', 'todo', { todoPosition: 1, startTakesSlot: false, startColumnId: 'testing' }),
    ]);
    expect(planPass([plan], 4, new Set())).toEqual([
      { kind: 'start', workflowId: 'w1', homeProjectId: 'home', projectId: 'home', taskId: 't1', toSwimlaneId: 'executing', takesSlot: true },
      { kind: 'start', workflowId: 'w1', homeProjectId: 'home', projectId: 'home', taskId: 't2', toSwimlaneId: 'testing', takesSlot: false },
    ]);
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
      taskHeld: false,
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
    expect(workflowMoveRefusal(check({ workflowState: 'paused', origin: 'mobile' }))).toBeNull();
    expect(workflowMoveRefusal(check({ workflowState: 'paused', toSwimlaneId: 'todo', toRole: 'todo' })))
      .toBe('#414 is in Usage budgets. Remove it from the workflow to move it to To Do.');
  });

  it('refuses the paused workflow\'s own move, a step move or a start that raced the Pause', () => {
    expect(workflowMoveRefusal(check({ workflowState: 'paused', origin: 'workflow' })))
      .toBe('#414 is in Usage budgets, which is paused. Resume it to move its tasks.');
  });

  it('lets a card a person works while paused move as any card does: its automations, plan exit and its own agent', () => {
    // Decided 2026-10-27 (#925): a card a person touches during a pause is an
    // ordinary card, and may run on through its board.
    expect(workflowMoveRefusal(check({ workflowState: 'paused', origin: 'automation' }))).toBeNull();
    expect(workflowMoveRefusal(check({ workflowState: 'paused', origin: 'auto-move' }))).toBeNull();
    expect(workflowMoveRefusal(check({ workflowState: 'paused', origin: 'agent', moverIsTaskAgent: true }))).toBeNull();
  });

  it('refuses another task\'s agent while paused', () => {
    expect(workflowMoveRefusal(check({ workflowState: 'paused', origin: 'agent' })))
      .toBe('#414 is in Usage budgets, which is paused. Resume it to move its tasks.');
  });

  it('refuses To Do even for the task\'s own agent', () => {
    expect(workflowMoveRefusal(check({ origin: 'agent', moverIsTaskAgent: true, toSwimlaneId: 'todo', toRole: 'todo' }))).not.toBeNull();
  });

  it('says the lock for a person moving a running card to To Do, and the To Do sentence to an agent', () => {
    const toDo = { toSwimlaneId: 'todo', toRole: 'todo' as const };
    expect(workflowMoveRefusal(check(toDo))).toBe('#414 is locked while Usage budgets runs.');
    expect(workflowMoveRefusal(check({ ...toDo, origin: 'mobile' }))).toBe('#414 is locked while Usage budgets runs.');
    expect(workflowMoveRefusal(check({ ...toDo, origin: 'agent', moverIsTaskAgent: true })))
      .toBe('#414 is in Usage budgets. Remove it from the workflow to move it to To Do.');
    expect(workflowMoveRefusal(check({ ...toDo, origin: 'workflow' })))
      .toBe('#414 is in Usage budgets. Remove it from the workflow to move it to To Do.');
  });

  it('never refuses a reorder, or a task in a finished workflow', () => {
    expect(workflowMoveRefusal(check({ toSwimlaneId: 'executing' }))).toBeNull();
    expect(workflowMoveRefusal(check({ workflowState: 'done' }))).toBeNull();
  });

  describe('as a message, for the board to show in the session language', () => {
    const LOCKED = '#414 is locked while Usage budgets runs.';
    const TO_DO_NEEDS_REMOVE = '#414 is in Usage budgets. Remove it from the workflow to move it to To Do.';
    const PAUSED_FOR_AGENTS = '#414 is in Usage budgets, which is paused. Resume it to move its tasks.';
    const toDo = { toSwimlaneId: 'todo', toRole: 'todo' as const };

    // The three sentences are typed out, not read back: they are the pre-change literals of
    // `WORKFLOW_REFUSALS.locked`, `.toDoNeedsRemove` and `.pausedForAgents` (`git show
    // HEAD:src/shared/workflow-refusals.ts`), which the module before this change returned.
    // The rows cover every refusing branch of `workflowMoveRefusalMessage`.
    const REFUSING: Array<[string, Partial<WorkflowMoveCheck>, string]> = [
      ['a person dragging a running workflow task', {}, LOCKED],
      ['the phone moving a running workflow task', { origin: 'mobile' }, LOCKED],
      ['another agent moving a running workflow task', { origin: 'agent' }, LOCKED],
      ['a person dragging out of a human gate to a column that is not the next one', { humanGateTargetId: 'testing' }, LOCKED],
      ['a person moving a running workflow task to To Do', toDo, LOCKED],
      ['the phone moving a running workflow task to To Do', { ...toDo, origin: 'mobile' }, LOCKED],
      ['an agent moving a running workflow task to To Do', { ...toDo, origin: 'agent' }, TO_DO_NEEDS_REMOVE],
      ['the task\'s own agent moving a running workflow task to To Do', { ...toDo, origin: 'agent', moverIsTaskAgent: true }, TO_DO_NEEDS_REMOVE],
      ['the workflow moving a task to To Do', { ...toDo, origin: 'workflow' }, TO_DO_NEEDS_REMOVE],
      ['a person moving a paused workflow task to To Do', { ...toDo, workflowState: 'paused' }, TO_DO_NEEDS_REMOVE],
      ['another agent moving a paused workflow task', { workflowState: 'paused', origin: 'agent' }, PAUSED_FOR_AGENTS],
    ];

    const ALLOWED: Array<[string, Partial<WorkflowMoveCheck>]> = [
      ['a reorder within one column', { toSwimlaneId: 'executing' }],
      ['a draft workflow', { workflowState: 'draft' }],
      ['a finished workflow', { workflowState: 'done' }],
      ['the workflow itself', { origin: 'workflow' }],
      ['an automation', { origin: 'automation' }],
      ['an auto-move', { origin: 'auto-move' }],
      ['the task\'s own agent', { origin: 'agent', moverIsTaskAgent: true }],
      ['a person moving a paused workflow task by hand', { workflowState: 'paused' }],
      ['the phone moving a paused workflow task by hand', { workflowState: 'paused', origin: 'mobile' }],
      ['a person dragging out of a human gate to the next column', { humanGateTargetId: 'review' }],
    ];

    it.each(REFUSING)('%s is refused with its sentence', (_name, extra, expected) => {
      const message = workflowMoveRefusalMessage(check(extra));
      expect(message).not.toBeNull();
      // The message resolves to the sentence in English, and in an English session on the board...
      expect(englishText(message ?? '')).toBe(expected);
      expect(translateText(message ?? '')).toBe(expected);
      // ...and the thrown form is that same English.
      expect(workflowMoveRefusal(check(extra))).toBe(expected);
    });

    it.each(ALLOWED)('is null for %s', (_name, extra) => {
      expect(workflowMoveRefusalMessage(check(extra))).toBeNull();
      expect(workflowMoveRefusal(check(extra))).toBeNull();
    });
  });

  describe('a card whose own automations are paused', () => {
    // The task's hold: the rest of its workflow runs, and the person working the
    // task moves it. Each case is paired with the same move for a card that is
    // not held, which is refused, so the pair differs only in `taskHeld`.
    const LOCKED = '#414 is locked while Usage budgets runs.';
    const REMOVE_FIRST = '#414 is in Usage budgets. Remove it from the workflow to move it to To Do.';

    it.each(['renderer', 'mobile'] as const)('lets a person (%s) move it to another working column of a running workflow', (origin) => {
      expect(workflowMoveRefusal(check({ origin, taskHeld: false }))).toBe(LOCKED);
      expect(workflowMoveRefusal(check({ origin, taskHeld: true }))).toBeNull();
    });

    it.each(['renderer', 'mobile'] as const)('lets a person (%s) move it to Done of a running workflow', (origin) => {
      const toDone = { origin, toSwimlaneId: 'done', toRole: 'done' as const };
      expect(workflowMoveRefusal(check({ ...toDone, taskHeld: false }))).toBe(LOCKED);
      expect(workflowMoveRefusal(check({ ...toDone, taskHeld: true }))).toBeNull();
    });

    it('lets a person move it out of a human gate to any column, not only the gate\'s target', () => {
      const gate = { humanGateTargetId: 'review', toSwimlaneId: 'testing' };
      expect(workflowMoveRefusal(check({ ...gate, taskHeld: false }))).toBe(LOCKED);
      expect(workflowMoveRefusal(check({ ...gate, taskHeld: true }))).toBeNull();
    });

    it.each(['renderer', 'mobile'] as const)('still refuses a person (%s) To Do, with the sentence that says to remove it first, not the lock\'s', (origin) => {
      const toDo = { origin, toSwimlaneId: 'todo', toRole: 'todo' as const };
      expect(workflowMoveRefusal(check({ ...toDo, taskHeld: false }))).toBe(LOCKED);
      expect(workflowMoveRefusal(check({ ...toDo, taskHeld: true }))).toBe(REMOVE_FIRST);
    });

    it('still refuses another agent, which is not the person working it', () => {
      expect(workflowMoveRefusal(check({ origin: 'agent', taskHeld: true }))).toBe(LOCKED);
      expect(workflowMoveRefusal(check({ origin: 'agent', taskHeld: false }))).toBe(LOCKED);
    });

    it('still refuses another agent To Do with the remove-first sentence', () => {
      expect(workflowMoveRefusal(check({ origin: 'agent', toSwimlaneId: 'todo', toRole: 'todo', taskHeld: true }))).toBe(REMOVE_FIRST);
    });

    it('leaves the task\'s own agent and the workflow, its automations and auto-move as they were', () => {
      for (const taskHeld of [false, true]) {
        expect(workflowMoveRefusal(check({ origin: 'agent', moverIsTaskAgent: true, taskHeld }))).toBeNull();
        expect(workflowMoveRefusal(check({ origin: 'workflow', taskHeld }))).toBeNull();
        expect(workflowMoveRefusal(check({ origin: 'automation', taskHeld }))).toBeNull();
        expect(workflowMoveRefusal(check({ origin: 'auto-move', taskHeld }))).toBeNull();
      }
    });

    it('moves by hand exactly as a paused workflow\'s card does (an agent is told the lock, not the pause)', () => {
      const targets = [
        { toSwimlaneId: 'review', toRole: null },
        { toSwimlaneId: 'done', toRole: 'done' as const },
        { toSwimlaneId: 'todo', toRole: 'todo' as const },
      ];
      for (const target of targets) {
        for (const origin of ['renderer', 'mobile'] as const) {
          expect(workflowMoveRefusal(check({ ...target, origin, workflowState: 'running', taskHeld: true })))
            .toBe(workflowMoveRefusal(check({ ...target, origin, workflowState: 'paused', taskHeld: false })));
        }
      }
    });

    it('changes nothing in a paused, draft or finished workflow, or for a reorder', () => {
      for (const workflowState of ['paused', 'draft', 'done'] as const) {
        expect(workflowMoveRefusal(check({ workflowState, taskHeld: true })))
          .toBe(workflowMoveRefusal(check({ workflowState, taskHeld: false })));
      }
      expect(workflowMoveRefusal(check({ toSwimlaneId: 'executing', taskHeld: true }))).toBeNull();
    });
  });
});
