/**
 * The workflow rules the view draws from: why a task in To Do waits, which
 * cards can take a link, and the refusal a link would get.
 */
import { describe, it, expect } from 'vitest';
import type { Task, WorkflowDetail, WorkflowViewTask, WorkflowTaskPlace } from '../../src/shared/types';
import type { WorkflowRouteStep } from '../../src/shared/types';
import {
  DONE_COLOR_FALLBACK,
  addBlockerRefusal,
  blockerCandidates,
  canBlock,
  canWait,
  firstInRunOrder,
  linkRefusal,
  otherBoardDoneColor,
  removeRefusal,
  runOrder,
  stepRefusal,
  toggledRoute,
  unlinkRefusal,
  waitingOf,
} from '../../src/renderer/components/workflows/workflow-graph';
import { boardWaiting, type BoardWorkflow } from '../../src/renderer/utils/board-workflow';
import { WORKFLOW_REFUSALS } from '../../src/shared/workflow-refusals';

function viewTask(key: string, displayId: number, place: WorkflowTaskPlace, steps: WorkflowRouteStep[] = [], unnamedBlockerCount = 0): WorkflowViewTask {
  return {
    key, projectId: 'p', task: null, planned: null, title: `Task ${key}`, displayId, place,
    swimlaneId: null, steps, canvasX: null, canvasY: null, unnamedBlockerCount,
  };
}

function step(name: string, state: WorkflowRouteStep['state']): WorkflowRouteStep {
  return { swimlaneId: name.toLowerCase(), name, color: null, icon: null, state, finishedAt: null };
}

function detail(state: WorkflowDetail['workflow']['state'], tasks: WorkflowViewTask[], links: Array<[string, string]>): WorkflowDetail {
  return {
    workflow: {
      id: 'w', title: 'Usage budgets', brief: null, source_task_id: null, state, draft: null,
      color_slot: 1, revision: 1, created_at: '', started_at: null, finished_at: null,
    },
    homeProjectId: 'p',
    tasks,
    links: links.map(([blockerKey, blockedKey]) => ({ blockerKey, blockedKey })),
    projectNames: { p: 'kangentic' },
    boardEnds: { p: { todo: null, done: { swimlaneId: 'p-done', name: 'Done', color: '#10b981', icon: null } } },
  };
}

describe('otherBoardDoneColor', () => {
  const done = (color: string | null) => ({ todo: null, done: { swimlaneId: 'done', name: 'Done', color, icon: null } });
  const home = { homeProjectId: 'p', boardEnds: { p: done('#10b981'), mobile: done('#a855f7'), bare: done(null) } };

  it('leaves a home-board card on the canvas\'s live color, and gives another board\'s card its own Done color', () => {
    expect(otherBoardDoneColor(home, { projectId: 'p' })).toBeNull();
    expect(otherBoardDoneColor(home, { projectId: 'mobile' })).toBe('#a855f7');
  });

  it('draws a board with no Done color in the board\'s own fallback, never in the home board\'s', () => {
    expect(otherBoardDoneColor(home, { projectId: 'bare' })).toBe(DONE_COLOR_FALLBACK);
    expect(otherBoardDoneColor(home, { projectId: 'unknown' })).toBe(DONE_COLOR_FALLBACK);
  });
});

describe('workflow rules in the view', () => {
  const tasks = [viewTask('a', 411, 'done'), viewTask('b', 413, 'working'), viewTask('c', 414, 'todo'), viewTask('d', 415, 'todo')];

  it('says what a task in To Do waits for, or that it is queued or paused', () => {
    const running = detail('running', tasks, [['a', 'c'], ['b', 'c'], ['b', 'd']]);
    expect(waitingOf(running, tasks[2])).toEqual({ label: 'Blocked by #413...', paused: false });
    const twoPending = detail('running', tasks, [['b', 'd'], ['c', 'd']]);
    expect(waitingOf(twoPending, tasks[3])).toEqual({ label: 'Blocked by 2 tasks...', paused: false });
    expect(waitingOf(detail('running', tasks, [['a', 'c']]), tasks[2])).toEqual({ label: 'Queued...', paused: false });
    expect(waitingOf(detail('paused', tasks, []), tasks[2])).toEqual({ label: 'Paused', paused: true });
    expect(waitingOf(running, tasks[1])).toBeNull();
  });

  it('counts a blocker the read could not name, alone and beside a live one, and never as queued or paused', () => {
    const waiting = viewTask('e', 416, 'todo', [], 1);
    const withTasks = [...tasks, waiting];
    expect(waitingOf(detail('running', withTasks, []), waiting)).toEqual({ label: 'Blocked by a task...', paused: false });
    expect(waitingOf(detail('running', withTasks, [['b', 'e']]), waiting)).toEqual({ label: 'Blocked by 2 tasks...', paused: false });
    expect(waitingOf(detail('paused', withTasks, []), waiting)).toEqual({ label: 'Blocked by a task...', paused: false });
    // A done blocker beside it does not count.
    expect(waitingOf(detail('running', withTasks, [['a', 'e']]), waiting)).toEqual({ label: 'Blocked by a task...', paused: false });
  });

  it('words a task\'s wait the same on its canvas card as on its board card, which reads the summary', () => {
    // The summary names the same blockers: a live one by number, an unnamed one as "a task".
    const waiting = viewTask('e', 416, 'todo', [], 1);
    const withTasks = [...tasks, waiting];
    const cases: Array<{ state: 'running' | 'paused'; links: Array<[string, string]>; waitingFor: string[] }> = [
      { state: 'running', links: [], waitingFor: ['a task'] },
      { state: 'running', links: [['b', 'e']], waitingFor: ['#413', 'a task'] },
      { state: 'paused', links: [['b', 'e']], waitingFor: ['#413', 'a task'] },
    ];
    for (const { state, links, waitingFor } of cases) {
      const board: BoardWorkflow = { workflowId: 'w', homeProjectId: 'p', title: 'Usage budgets', colorSlot: 1, state, waitingFor, humanGateTargetId: null, hasLinks: true, stallReason: null };
      expect(waitingOf(detail(state, withTasks, links), waiting)).toEqual(boardWaiting(board, { automations_disabled: false }));
    }
    const single = viewTask('f', 417, 'todo');
    const live: BoardWorkflow = { workflowId: 'w', homeProjectId: 'p', title: 'Usage budgets', colorSlot: 1, state: 'running', waitingFor: ['#413'], humanGateTargetId: null, hasLinks: true, stallReason: null };
    expect(waitingOf(detail('running', [...tasks, single], [['b', 'f']]), single)).toEqual(boardWaiting(live, { automations_disabled: false }));
  });

  describe('a task whose own automations are paused', () => {
    // The row the canvas card reads its hold from: `viewTask.task`. A planned
    // task has no row, so it never reads held.
    const taskRow = (automations_disabled: boolean) => ({ automations_disabled }) as Task;
    const withRow = (key: string, displayId: number, automationsDisabled: boolean | null): WorkflowViewTask => ({
      ...viewTask(key, displayId, 'todo'),
      task: automationsDisabled === null ? null : taskRow(automationsDisabled),
    });

    it('reads Paused in a running workflow with nothing it waits for, where the same task not held reads Queued', () => {
      const free = withRow('f', 417, false);
      const held = withRow('h', 418, true);
      expect(waitingOf(detail('running', [free], []), free)).toEqual({ label: 'Queued...', paused: false });
      expect(waitingOf(detail('running', [held], []), held)).toEqual({ label: 'Paused', paused: true });
    });

    it('names what it waits for before it says Paused', () => {
      const held = withRow('h', 418, true);
      const blocker = viewTask('b', 413, 'working');
      expect(waitingOf(detail('running', [blocker, held], [['b', 'h']]), held)).toEqual({ label: 'Blocked by #413...', paused: false });
    });

    it('reads a planned task, which has no row to hold, as Queued', () => {
      const planned = withRow('p', 419, null);
      expect(waitingOf(detail('running', [planned], []), planned)).toEqual({ label: 'Queued...', paused: false });
    });

    it('says nothing in a draft workflow, and nothing for a task that has started', () => {
      const held = withRow('h', 418, true);
      expect(waitingOf(detail('draft', [held], []), held)).toBeNull();
      const started = { ...viewTask('w', 420, 'working'), task: taskRow(true) };
      expect(waitingOf(detail('running', [started], []), started)).toBeNull();
    });

    it('words the wait the same on its canvas card as on its board card', () => {
      const held = withRow('h', 418, true);
      const blocker = viewTask('b', 413, 'working');
      const board: BoardWorkflow = {
        workflowId: 'w', homeProjectId: 'p', title: 'Usage budgets', colorSlot: 1, state: 'running',
        waitingFor: [], humanGateTargetId: null, hasLinks: true, stallReason: null,
      };
      expect(waitingOf(detail('running', [held], []), held)).toEqual(boardWaiting(board, { automations_disabled: true }));
      expect(waitingOf(detail('running', [blocker, held], [['b', 'h']]), held))
        .toEqual(boardWaiting({ ...board, waitingFor: ['#413'] }, { automations_disabled: true }));
    });
  });

  it('lets only a task that has not started wait, and only an unfinished one block', () => {
    expect(tasks.map(canWait)).toEqual([false, false, true, true]);
    expect(tasks.map(canBlock)).toEqual([false, true, true, true]);
  });

  it('refuses a link with the reason the user needs', () => {
    const current = detail('running', tasks, [['c', 'd']]);
    expect(linkRefusal(current, 'c', 'b')).toBe('#413 has started. Only a task in To Do can wait for another.');
    expect(linkRefusal(current, 'a', 'c')).toBe('#411 is done. Waiting for it changes nothing.');
    expect(linkRefusal(current, 'c', 'd')).toBe('#415 already waits for #414.');
    expect(linkRefusal(current, 'd', 'c')).toMatch(/closes a loop/);
    expect(linkRefusal(current, 'c', 'c')).toBe('A task cannot wait for itself.');
    expect(linkRefusal(current, 'b', 'c')).toBeNull();
  });

  it('words every refusal the way main does', () => {
    const current = detail('running', tasks, [['c', 'd']]);
    expect(linkRefusal(current, 'c', 'b')).toBe(WORKFLOW_REFUSALS.cannotWait('#413'));
    expect(linkRefusal(current, 'a', 'c')).toBe(WORKFLOW_REFUSALS.blockerDone('#411'));
    expect(linkRefusal(current, 'd', 'c')).toBe(WORKFLOW_REFUSALS.loop);
  });

  it('keeps a link removable only while it still holds a task in To Do back', () => {
    const current = detail('running', tasks, [['a', 'c'], ['b', 'c'], ['c', 'd'], ['b', 'd']]);
    // Blocker done: nothing to release.
    expect(unlinkRefusal(current, 'a', 'c')).toBe('#411 is done. Removing the link changes nothing.');
    // Waiting task in To Do, blocker working: removing it changes something.
    expect(unlinkRefusal(current, 'b', 'c')).toBeNull();
    const started = detail('running', [tasks[0], tasks[1], viewTask('c', 414, 'working')], [['b', 'c']]);
    expect(unlinkRefusal(started, 'b', 'c')).toBe('#414 has started. Removing the link changes nothing.');
  });

  it('allows Add blocker and Remove only where they act', () => {
    const unlinked = detail('running', tasks, []);
    expect(addBlockerRefusal(unlinked, tasks[2])).toBeNull();
    expect(addBlockerRefusal(unlinked, tasks[1])).toBe('#413 has started. Only a task in To Do can wait for another.');
    expect(removeRefusal(tasks[1])).toBeNull();
    expect(removeRefusal(tasks[0])).toBe('#411 is done and stays with its workflow.');
  });

  it('disables Add blocker when no task is left to wait for, and a started task still says it has started', () => {
    // #414 already waits for #413, #411 is done, and #415 waits on #414, so linking it would loop.
    const exhausted = detail('running', tasks, [['b', 'c'], ['c', 'd']]);
    expect(blockerCandidates(exhausted, 'c')).toEqual([]);
    expect(addBlockerRefusal(exhausted, tasks[2])).toBe(WORKFLOW_REFUSALS.noBlockerCandidates);
    expect(addBlockerRefusal(exhausted, tasks[1])).toBe('#413 has started. Only a task in To Do can wait for another.');
  });

  it('locks every route step the task has reached, and only those', () => {
    const steps = [step('Planning', 'done'), step('Executing', 'current'), step('Code Review', 'ahead'), step('Testing', 'skipped')];
    const working = viewTask('w', 414, 'working', steps);
    expect(stepRefusal(working, 0)).toBe('#414 has reached Executing. Only the columns after it can change.');
    expect(stepRefusal(working, 1)).toBe('#414 has reached Executing. Only the columns after it can change.');
    expect(stepRefusal(working, 2)).toBeNull();
    expect(stepRefusal(working, 3)).toBeNull();
    expect(stepRefusal(viewTask('t', 415, 'todo', steps), 0)).toBeNull();
    expect(stepRefusal(viewTask('d', 411, 'done', steps), 3)).toBe('#411 is done and stays with its workflow.');
  });

  it('switches one step and refuses a route with no column left', () => {
    const steps = [step('Planning', 'ahead'), step('Executing', 'ahead'), step('Testing', 'skipped')];
    expect(toggledRoute(steps, 'planning')).toEqual({ columns: ['executing'] });
    expect(toggledRoute(steps, 'testing')).toEqual({ columns: ['planning', 'executing', 'testing'] });
    const single = [step('Executing', 'ahead'), step('Testing', 'skipped')];
    expect(toggledRoute(single, 'executing')).toEqual({ refusal: 'A task visits at least one column.' });
  });

  it('lists what a task can wait for, and groups the run order by when each task can start', () => {
    const current = detail('running', tasks, [['b', 'd'], ['c', 'd']]);
    // #414 may wait for #413 (working). Not #411 (done), and not #415, which already
    // waits for #414, so the link would close a loop. #415 already waits for both others.
    expect(blockerCandidates(current, 'c').map((task) => task.key)).toEqual(['b']);
    expect(blockerCandidates(current, 'd').map((task) => task.key)).toEqual([]);
    expect(runOrder(current).map((group) => group.map((task) => task.key))).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('opens a workflow on its run order\'s first row, among the tasks the search leaves', () => {
    // `d` comes first in the plan but waits for `c`, so the first stop is a, b, c.
    const reordered = detail('draft', [tasks[3], tasks[0], tasks[1], tasks[2]], [['c', 'd']]);
    expect(firstInRunOrder(reordered)).toBe('a');
    expect(firstInRunOrder(reordered, new Set(['b', 'd']))).toBe('b');
    // A search that leaves only a later stop opens on that stop's first row.
    expect(firstInRunOrder(reordered, new Set(['d']))).toBe('d');
    expect(firstInRunOrder(reordered, new Set())).toBeNull();
    expect(firstInRunOrder(detail('draft', [], []))).toBeNull();
  });
});
