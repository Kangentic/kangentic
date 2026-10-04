/**
 * The workflow rules the view draws from: why a task in To Do waits, which
 * cards can take a link, and the refusal a link would get.
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowDetail, WorkflowViewTask, WorkflowTaskPlace } from '../../src/shared/types';
import { linkRefusal, waitingOf, canWait, canBlock } from '../../src/renderer/components/workflows/workflow-graph';

function viewTask(key: string, displayId: number, place: WorkflowTaskPlace): WorkflowViewTask {
  return {
    key, projectId: 'p', task: null, planned: null, title: `Task ${key}`, displayId, place,
    swimlaneId: null, steps: [], canvasX: null, canvasY: null,
  };
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
  };
}

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
});
