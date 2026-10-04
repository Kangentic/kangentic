/**
 * A workflow task as its board card reads it (`src/renderer/utils/board-workflow.ts`):
 * which list names it, what its footer says in To Do, and why a person may not
 * move it, in main's own words through main's own predicate.
 */
import { describe, it, expect } from 'vitest';
import type { Workflow, WorkflowSummary } from '../../src/shared/types';
import {
  boardMoveRefusal,
  boardWaiting,
  boardWorkflowOf,
  isLockedOnBoard,
  isWorkflowLockMessage,
  sendAwayRefusal,
  type BoardWorkflow,
} from '../../src/renderer/utils/board-workflow';

function workflowRow(id: string, state: Workflow['state']): Workflow {
  return {
    id, title: 'Usage budgets', brief: null, source_task_id: null, state, draft: null,
    color_slot: 5, revision: 1, created_at: '', started_at: null, finished_at: null,
  };
}

function summary(id: string, state: Workflow['state'], boardTasks: WorkflowSummary['boardTasks'] = {}): WorkflowSummary {
  return { workflow: workflowRow(id, state), taskCount: 2, doneCount: 0, inProgressCount: 1, queuedCount: 0, blockedCount: 1, boardTasks };
}

function boardWorkflow(overrides: Partial<BoardWorkflow> = {}): BoardWorkflow {
  return {
    workflowId: 'w', homeProjectId: 'home', title: 'Usage budgets', colorSlot: 5, state: 'running',
    waitingFor: [], humanGateTargetId: null, ...overrides,
  };
}

const TASK = { id: 't414', display_id: 414, swimlane_id: 'executing' };

describe('boardWorkflowOf', () => {
  const own = summary('w', 'running', { t414: { waitingFor: [], humanGateTargetId: 'review' } });
  const foreign = summary('w2', 'paused');

  it('reads a card on its home board from the board project\'s list', () => {
    const read = boardWorkflowOf([own], {}, { id: 't414', workflow_id: 'w', workflow_project_id: 'home' }, 'home');
    expect(read).toMatchObject({ workflowId: 'w', homeProjectId: 'home', state: 'running', humanGateTargetId: 'review' });
    // A home task may carry no project id of its own.
    expect(boardWorkflowOf([own], {}, { id: 't414', workflow_id: 'w', workflow_project_id: null }, 'home')?.workflowId).toBe('w');
  });

  it('reads a card whose workflow lives in another project from that project\'s list', () => {
    const read = boardWorkflowOf([own], { mobile: [foreign] }, { id: 't9', workflow_id: 'w2', workflow_project_id: 'mobile' }, 'home');
    expect(read).toMatchObject({ workflowId: 'w2', homeProjectId: 'mobile', state: 'paused', waitingFor: [] });
  });

  it('names nothing for an ordinary task, or a workflow not in any list', () => {
    expect(boardWorkflowOf([own], {}, { id: 'x', workflow_id: null, workflow_project_id: null }, 'home')).toBeNull();
    expect(boardWorkflowOf([own], {}, { id: 'x', workflow_id: 'gone', workflow_project_id: 'home' }, 'home')).toBeNull();
  });
});

describe('the footer of a card in To Do', () => {
  it('names one blocker, counts several, else says paused or queued', () => {
    expect(boardWaiting(boardWorkflow({ waitingFor: ['#413'] }))).toEqual({ label: 'Blocked by #413...', paused: false });
    expect(boardWaiting(boardWorkflow({ waitingFor: ['#1', '#2', '#3'] }))).toEqual({ label: 'Blocked by 3 tasks...', paused: false });
    expect(boardWaiting(boardWorkflow({ state: 'paused' }))).toEqual({ label: 'Paused', paused: true });
    expect(boardWaiting(boardWorkflow())).toEqual({ label: 'Queued...', paused: false });
    expect(boardWaiting(null)).toBeNull();
  });
});

describe('the lock on the board', () => {
  it('refuses every move of a running workflow\'s card, To Do in its own words', () => {
    const workflow = boardWorkflow();
    expect(isLockedOnBoard(workflow)).toBe(true);
    expect(boardMoveRefusal(workflow, TASK, { id: 'review', role: null })).toBe('#414 is locked while Usage budgets runs.');
    expect(boardMoveRefusal(workflow, TASK, { id: 'todo', role: 'todo' }))
      .toBe('#414 is in Usage budgets. Remove it from the workflow to move it to To Do.');
    // Reordering in its own column is never refused.
    expect(boardMoveRefusal(workflow, TASK, { id: 'executing', role: null })).toBeNull();
  });

  it('lets a person drag a card out of a human gate to the next column of its route, and nowhere else', () => {
    const workflow = boardWorkflow({ humanGateTargetId: 'review' });
    expect(isLockedOnBoard(workflow)).toBe(false);
    expect(boardMoveRefusal(workflow, TASK, { id: 'review', role: null })).toBeNull();
    expect(boardMoveRefusal(workflow, TASK, { id: 'testing', role: null })).toBe('#414 is locked while Usage budgets runs.');
  });

  it('lets a paused workflow\'s card move by hand except into To Do', () => {
    const workflow = boardWorkflow({ state: 'paused' });
    expect(isLockedOnBoard(workflow)).toBe(false);
    expect(boardMoveRefusal(workflow, TASK, { id: 'review', role: null })).toBeNull();
    expect(boardMoveRefusal(workflow, TASK, { id: 'todo', role: 'todo' })).not.toBeNull();
  });

  it('keeps Backlog and Archive from taking a task out of its workflow', () => {
    expect(sendAwayRefusal(boardWorkflow(), TASK)).toBe('#414 is locked while Usage budgets runs.');
    expect(sendAwayRefusal(boardWorkflow({ state: 'paused' }), TASK)).toBe('Remove #414 from Usage budgets first.');
    expect(sendAwayRefusal(null, TASK)).toBeNull();
  });

  it('tells main\'s lock refusals from any other failure', () => {
    const workflow = boardWorkflow();
    expect(isWorkflowLockMessage('#414 is locked while Usage budgets runs.', TASK, workflow)).toBe(true);
    expect(isWorkflowLockMessage('#414 is in Usage budgets, which is paused. Resume it to move its tasks.', TASK, workflow)).toBe(true);
    expect(isWorkflowLockMessage('Worktree is dirty', TASK, workflow)).toBe(false);
    expect(isWorkflowLockMessage('#414 is locked while Usage budgets runs.', TASK, null)).toBe(false);
  });
});
