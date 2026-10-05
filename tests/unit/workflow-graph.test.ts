/**
 * The workflow rules the view draws from: why a task in To Do waits, which
 * cards can take a link, and the refusal a link would get.
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowDetail, WorkflowViewTask, WorkflowTaskPlace } from '../../src/shared/types';
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
import { WORKFLOW_REFUSALS } from '../../src/shared/workflow-refusals';

function viewTask(key: string, displayId: number, place: WorkflowTaskPlace, steps: WorkflowRouteStep[] = []): WorkflowViewTask {
  return {
    key, projectId: 'p', task: null, planned: null, title: `Task ${key}`, displayId, place,
    swimlaneId: null, steps, canvasX: null, canvasY: null,
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
    doneColors: { p: '#10b981' },
  };
}

describe('otherBoardDoneColor', () => {
  const home = { homeProjectId: 'p', doneColors: { p: '#10b981', mobile: '#a855f7', bare: null } };

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
    expect(addBlockerRefusal(tasks[2])).toBeNull();
    expect(addBlockerRefusal(tasks[1])).toBe('#413 has started. Only a task in To Do can wait for another.');
    expect(removeRefusal(tasks[1])).toBeNull();
    expect(removeRefusal(tasks[0])).toBe('#411 is done and stays with its workflow.');
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
