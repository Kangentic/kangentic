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
    waitingFor: [], humanGateTargetId: null, hasLinks: true, stallReason: null, ...overrides,
  };
}

const TASK = { id: 't414', display_id: 414, swimlane_id: 'executing', automations_disabled: false };
// The same card with its own automations paused: a person's hold on it.
const HELD_TASK = { ...TASK, automations_disabled: true };

describe('boardWorkflowOf', () => {
  const own = summary('w', 'running', { t414: { waitingFor: [], humanGateTargetId: 'review', hasLinks: true } });
  const foreign = summary('w2', 'paused');

  it('reads a card on its home board from the board project\'s list', () => {
    const read = boardWorkflowOf([own], {}, { id: 't414', workflow_id: 'w', workflow_project_id: 'home' }, 'home');
    expect(read).toMatchObject({ workflowId: 'w', homeProjectId: 'home', state: 'running', humanGateTargetId: 'review', hasLinks: true });
    // A home task may carry no project id of its own.
    expect(boardWorkflowOf([own], {}, { id: 't414', workflow_id: 'w', workflow_project_id: null }, 'home')?.workflowId).toBe('w');
  });

  it('reads a card whose workflow lives in another project from that project\'s list', () => {
    const read = boardWorkflowOf([own], { mobile: [foreign] }, { id: 't9', workflow_id: 'w2', workflow_project_id: 'mobile' }, 'home');
    // No facts for the card yet: no links to show until the summary says so.
    expect(read).toMatchObject({ workflowId: 'w2', homeProjectId: 'mobile', state: 'paused', waitingFor: [], hasLinks: false });
  });

  it('names nothing for an ordinary task, or a workflow not in any list', () => {
    expect(boardWorkflowOf([own], {}, { id: 'x', workflow_id: null, workflow_project_id: null }, 'home')).toBeNull();
    expect(boardWorkflowOf([own], {}, { id: 'x', workflow_id: 'gone', workflow_project_id: 'home' }, 'home')).toBeNull();
  });
});

describe('the footer of a card in To Do', () => {
  it('names one blocker, counts several, else says paused or queued', () => {
    expect(boardWaiting(boardWorkflow({ waitingFor: ['#413'] }), TASK)).toEqual({ label: 'Blocked by #413...', paused: false });
    expect(boardWaiting(boardWorkflow({ waitingFor: ['#1', '#2', '#3'] }), TASK)).toEqual({ label: 'Blocked by 3 tasks...', paused: false });
    // A blocker whose board could not be read is named in plain words, never by where it is.
    expect(boardWaiting(boardWorkflow({ waitingFor: ['a task'] }), TASK)).toEqual({ label: 'Blocked by a task...', paused: false });
    expect(boardWaiting(boardWorkflow({ state: 'paused', waitingFor: ['#413', 'a task'] }), TASK)).toEqual({ label: 'Blocked by 2 tasks...', paused: false });
    expect(boardWaiting(boardWorkflow({ state: 'paused' }), TASK)).toEqual({ label: 'Paused', paused: true });
    expect(boardWaiting(boardWorkflow(), TASK)).toEqual({ label: 'Queued...', paused: false });
    expect(boardWaiting(null, TASK)).toBeNull();
  });

  describe('a card whose own automations are paused', () => {
    // The engine starts neither a held task nor, while it is held, anything it
    // alone would unblock, so a running workflow's footer reads Paused for it.
    // Each case pairs with the same workflow read for a task that is not held.
    it('reads Paused in a running workflow with nothing it waits for, where an ordinary card reads Queued', () => {
      expect(boardWaiting(boardWorkflow(), TASK)).toEqual({ label: 'Queued...', paused: false });
      expect(boardWaiting(boardWorkflow(), HELD_TASK)).toEqual({ label: 'Paused', paused: true });
    });

    it('still names what it waits for before it says Paused', () => {
      expect(boardWaiting(boardWorkflow({ waitingFor: ['#413'] }), HELD_TASK)).toEqual({ label: 'Blocked by #413...', paused: false });
      expect(boardWaiting(boardWorkflow({ waitingFor: ['#1', '#2'] }), HELD_TASK)).toEqual({ label: 'Blocked by 2 tasks...', paused: false });
    });

    it('reads Paused in a paused workflow as an ordinary card does', () => {
      expect(boardWaiting(boardWorkflow({ state: 'paused' }), HELD_TASK)).toEqual({ label: 'Paused', paused: true });
    });

    it('says nothing in a draft or a finished workflow', () => {
      expect(boardWaiting(boardWorkflow({ state: 'draft' }), HELD_TASK)).toBeNull();
      expect(boardWaiting(boardWorkflow({ state: 'done' }), HELD_TASK)).toBeNull();
    });
  });
});

describe('the lock on the board', () => {
  it('refuses every move of a running workflow\'s card with the lock\'s sentence, To Do included', () => {
    const workflow = boardWorkflow();
    // Locked: a drag of it stays in its own column.
    expect(isLockedOnBoard(workflow, TASK)).toBe(true);
    expect(boardMoveRefusal(workflow, TASK, { id: 'review', role: null })).toBe('#414 is locked while Usage budgets runs.');
    expect(boardMoveRefusal(workflow, TASK, { id: 'todo', role: 'todo' })).toBe('#414 is locked while Usage budgets runs.');
    // Reordering in its own column is never refused.
    expect(boardMoveRefusal(workflow, TASK, { id: 'executing', role: null })).toBeNull();
  });

  it('lets a person drag a card out of a human gate to the next column of its route, and nowhere else', () => {
    const workflow = boardWorkflow({ humanGateTargetId: 'review' });
    expect(isLockedOnBoard(workflow, TASK)).toBe(false);
    expect(boardMoveRefusal(workflow, TASK, { id: 'review', role: null })).toBeNull();
    expect(boardMoveRefusal(workflow, TASK, { id: 'testing', role: null })).toBe('#414 is locked while Usage budgets runs.');
  });

  it('lets a paused workflow\'s card move by hand except into To Do', () => {
    const workflow = boardWorkflow({ state: 'paused' });
    expect(isLockedOnBoard(workflow, TASK)).toBe(false);
    expect(boardMoveRefusal(workflow, TASK, { id: 'review', role: null })).toBeNull();
    expect(boardMoveRefusal(workflow, TASK, { id: 'todo', role: 'todo' }))
      .toBe('#414 is in Usage budgets. Remove it from the workflow to move it to To Do.');
  });

  describe('a card whose own automations are paused', () => {
    // A person's hold: the rest of the workflow runs, and this card moves by hand
    // as a paused workflow's does. Every case pairs with the same workflow read
    // for the same card not held, which stays locked.
    const REMOVE_FIRST_TO_DO = '#414 is in Usage budgets. Remove it from the workflow to move it to To Do.';

    it('is not locked on the board in a running workflow, where an ordinary card is', () => {
      const workflow = boardWorkflow();
      expect(isLockedOnBoard(workflow, TASK)).toBe(true);
      expect(isLockedOnBoard(workflow, HELD_TASK)).toBe(false);
    });

    it('is not locked in a human gate either, which was already open', () => {
      expect(isLockedOnBoard(boardWorkflow({ humanGateTargetId: 'review' }), HELD_TASK)).toBe(false);
    });

    it.each([
      ['another working column', { id: 'testing', role: null }],
      ['the next column on its route', { id: 'review', role: null }],
      ['Done', { id: 'done', role: 'done' }],
    ] as const)('may be dragged by hand to %s in a running workflow', (_label, target) => {
      const workflow = boardWorkflow();
      expect(boardMoveRefusal(workflow, TASK, target)).toBe('#414 is locked while Usage budgets runs.');
      expect(boardMoveRefusal(workflow, HELD_TASK, target)).toBeNull();
    });

    it('is still refused To Do, in the sentence that says what to do instead of the lock\'s', () => {
      const workflow = boardWorkflow();
      expect(boardMoveRefusal(workflow, TASK, { id: 'todo', role: 'todo' })).toBe('#414 is locked while Usage budgets runs.');
      expect(boardMoveRefusal(workflow, HELD_TASK, { id: 'todo', role: 'todo' })).toBe(REMOVE_FIRST_TO_DO);
    });

    it('moves exactly as a paused workflow\'s card does', () => {
      const running = boardWorkflow();
      const paused = boardWorkflow({ state: 'paused' });
      for (const target of [{ id: 'review', role: null }, { id: 'todo', role: 'todo' }, { id: 'done', role: 'done' }] as const) {
        expect(boardMoveRefusal(running, HELD_TASK, target)).toBe(boardMoveRefusal(paused, TASK, target));
      }
    });

    it('may reorder in its own column', () => {
      expect(boardMoveRefusal(boardWorkflow(), HELD_TASK, { id: 'executing', role: null })).toBeNull();
    });
  });

  it('keeps Backlog and Archive from taking a task out of its workflow', () => {
    expect(sendAwayRefusal(boardWorkflow(), TASK)).toBe('#414 is locked while Usage budgets runs.');
    expect(sendAwayRefusal(boardWorkflow({ state: 'paused' }), TASK)).toBe('Remove #414 from Usage budgets first.');
    expect(sendAwayRefusal(null, TASK)).toBeNull();
  });

  it('tells a held card in a running workflow to remove it first, not that it is locked', () => {
    // Not held: the workflow's lock. Held: nothing locks it, but only Remove takes it out.
    expect(sendAwayRefusal(boardWorkflow(), TASK)).toBe('#414 is locked while Usage budgets runs.');
    expect(sendAwayRefusal(boardWorkflow(), HELD_TASK)).toBe('Remove #414 from Usage budgets first.');
    expect(sendAwayRefusal(null, HELD_TASK)).toBeNull();
  });

  it('tells main\'s lock refusals from any other failure', () => {
    const workflow = boardWorkflow();
    expect(isWorkflowLockMessage('#414 is locked while Usage budgets runs.', TASK, workflow)).toBe(true);
    expect(isWorkflowLockMessage('#414 is in Usage budgets, which is paused. Resume it to move its tasks.', TASK, workflow)).toBe(true);
    expect(isWorkflowLockMessage('Worktree is dirty', TASK, workflow)).toBe(false);
    expect(isWorkflowLockMessage('#414 is locked while Usage budgets runs.', TASK, null)).toBe(false);
  });
});
