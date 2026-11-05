/**
 * Two small pieces the Code Review loop leans on.
 *
 * `finalAgentReply` is what `{{agentReply}}` resolves to: the final message of
 * the agent's last turn, whole. It must never walk back past the turn (a turn
 * that ended on a tool call has no reply of its own), must join the text
 * blocks Claude writes on separate transcript lines, and must not treat a
 * background job's `<task-notification>` as the start of the turn.
 *
 * `resolveMoveTarget` is where Move to column and `kangentic_move_task`'s
 * `column: "next"` land, so the two can never pick different columns.
 *
 * `routeOf` decides which of the two orders applies: a task in a workflow follows
 * its own route, anything else follows the board.
 */
import { describe, it, expect } from 'vitest';
import { finalAgentReply } from '../../src/main/agent/shared/agent-reply';
import { resolveMoveTarget, routeOf } from '../../src/main/automations/move-target';
import type { Swimlane, TranscriptEntry } from '../../src/shared/types';

let clock = 0;
const user = (text: string): TranscriptEntry => ({ kind: 'user', uuid: `u${++clock}`, ts: clock, text });
const assistantText = (text: string): TranscriptEntry => ({ kind: 'assistant', uuid: `a${++clock}`, ts: clock, blocks: [{ type: 'text', text }] });
const assistantTool = (name: string): TranscriptEntry => ({
  kind: 'assistant', uuid: `a${++clock}`, ts: clock, blocks: [{ type: 'tool_use', id: `t${clock}`, name, input: {} }],
});
const toolResult = (): TranscriptEntry => ({ kind: 'tool_result', uuid: `r${++clock}`, ts: clock, toolUseId: 'x', content: 'ok' });
const thinking = (): TranscriptEntry => ({ kind: 'assistant', uuid: `a${++clock}`, ts: clock, blocks: [{ type: 'thinking', text: 'hmm' }] });

describe('finalAgentReply', () => {
  it('returns the last message of the turn, with its line breaks', () => {
    const entries = [
      user('/code-review'),
      assistantText('Starting the review.'),
      assistantTool('Bash'),
      toolResult(),
      assistantText('Verdict: Needs revision.\n\n1. Fix the cap.\n2. Add a test.'),
    ];
    expect(finalAgentReply(entries)?.text).toBe('Verdict: Needs revision.\n\n1. Fix the cap.\n2. Add a test.');
  });

  it('joins the text blocks of one message written on separate lines', () => {
    const entries = [user('go'), assistantTool('Read'), toolResult(), thinking(), assistantText('Part one.'), assistantText('Part two.')];
    expect(finalAgentReply(entries)?.text).toBe('Part one.\n\nPart two.');
  });

  it('never walks back past the turn to an earlier reply', () => {
    const entries = [user('first'), assistantText('Old answer.'), user('second'), assistantTool('Bash'), toolResult()];
    expect(finalAgentReply(entries)).toBeNull();
  });

  it('reads past a background job restarting the agent, which is not a new prompt', () => {
    const entries = [
      user('/code-review'),
      assistantText('Verdict: Clean.'),
      user('<task-notification>\n<task-id>abc</task-id> completed</task-notification>'),
      assistantTool('TaskOutput'),
      toolResult(),
    ];
    expect(finalAgentReply(entries)?.text).toBe('Verdict: Clean.');
  });

  it('stops at a slash command, which starts a turn of the user', () => {
    const entries: TranscriptEntry[] = [
      assistantText('Old.'),
      { kind: 'system', uuid: 's1', ts: 1, subtype: 'command', text: '/compact' },
      assistantTool('Bash'),
    ];
    expect(finalAgentReply(entries)).toBeNull();
  });
});

function column(id: string, name: string, position: number, extra: Partial<Swimlane> = {}): Swimlane {
  return { id, name, position, is_archived: false, is_ghost: false, ...extra } as Swimlane;
}

const BOARD = [
  column('todo', 'To Do', 0),
  column('exec', 'Executing', 1),
  column('ghost', 'Hidden', 2, { is_ghost: true }),
  column('review', 'Code Review', 3),
  column('done', 'Done', 4),
];

describe('resolveMoveTarget', () => {
  it('takes the next column on the board, skipping a ghost', () => {
    expect(resolveMoveTarget(BOARD, 'exec', null)).toMatchObject({ ok: true, column: { id: 'review' } });
    expect(resolveMoveTarget(BOARD, 'exec', 'next')).toMatchObject({ ok: true, column: { id: 'review' } });
  });

  it('finds a named column case-blind', () => {
    expect(resolveMoveTarget(BOARD, 'review', 'executing')).toMatchObject({ ok: true, column: { id: 'exec' } });
  });

  it('refuses with a reason the run log can show', () => {
    expect(resolveMoveTarget(BOARD, 'done', null)).toEqual({ ok: false, reason: 'There is no column after Done.' });
    expect(resolveMoveTarget(BOARD, 'exec', 'Executing')).toEqual({ ok: false, reason: 'The task is already in Executing.' });
    const missing = resolveMoveTarget(BOARD, 'exec', 'Testing');
    expect(missing.ok).toBe(false);
    expect(missing.ok ? '' : missing.reason).toContain('No column named "Testing"');
  });

  it('reaches Done, which is stored archived, but never a column a user archived', () => {
    // A real board stores its Done lane archived: the board draws it as its own lane.
    const board = [
      column('todo', 'To Do', 0, { role: 'todo' }),
      column('exec', 'Executing', 1),
      column('retired', 'Retired', 2, { is_archived: true }),
      column('merge', 'Merge', 3),
      column('done', 'Done', 4, { role: 'done', is_archived: true }),
    ];
    expect(resolveMoveTarget(board, 'exec', 'Done')).toMatchObject({ ok: true, column: { id: 'done' } });
    expect(resolveMoveTarget(board, 'merge', null)).toMatchObject({ ok: true, column: { id: 'done' } });
    expect(resolveMoveTarget(board, 'exec', 'next')).toMatchObject({ ok: true, column: { id: 'merge' } });
    const retired = resolveMoveTarget(board, 'exec', 'Retired');
    expect(retired.ok ? '' : retired.reason).toContain('No column named "Retired"');
  });
});

describe('routeOf', () => {
  type RouteOfTask = Parameters<typeof routeOf>[0];

  const routeFields = {
    route_start_swimlane_id: 'exec',
    route_last_swimlane_id: 'review',
    skipped_swimlane_ids: ['review'],
  };

  // A Task assembled without the workflow_id column (a hand-built row, an older
  // payload) carries `undefined`, not null. Cast through unknown: the type says
  // string | null, and the point is what happens when the value is not honest.
  const withWorkflowId = (workflowId: unknown): RouteOfTask => ({ ...routeFields, workflow_id: workflowId }) as unknown as RouteOfTask;

  it('is no route for a task outside a workflow, however the column reads', () => {
    expect(routeOf(withWorkflowId(null))).toBeNull();
    expect(routeOf(withWorkflowId(undefined))).toBeNull();
    expect(routeOf(withWorkflowId(''))).toBeNull();
  });

  it('is the task\'s own route for a task in a workflow', () => {
    expect(routeOf(withWorkflowId('wf-1'))).toMatchObject(routeFields);
  });

  it('sends a workflow task along its route and any other task along the board', () => {
    // exec -> review is the board's next column; skipping review on the route
    // sends a workflow task from exec straight to Done instead.
    const columns = [
      column('todo', 'To Do', 0, { role: 'todo' }),
      column('exec', 'Executing', 1),
      column('ghost', 'Hidden', 2, { is_ghost: true }),
      column('review', 'Code Review', 3),
      column('done', 'Done', 4, { role: 'done' }),
    ];

    expect(resolveMoveTarget(columns, 'exec', null, routeOf(withWorkflowId('wf-1')))).toMatchObject({ ok: true, column: { id: 'done' } });
    // The same route fields on a task with no workflow are not a route.
    expect(resolveMoveTarget(columns, 'exec', null, routeOf(withWorkflowId(undefined)))).toMatchObject({ ok: true, column: { id: 'review' } });
    expect(resolveMoveTarget(columns, 'exec', null, routeOf(withWorkflowId('')))).toMatchObject({ ok: true, column: { id: 'review' } });
  });
});

describe('resolveMoveTarget, a row that names a column of a workflow task', () => {
  const columns = [
    column('todo', 'To Do', 0, { role: 'todo' }),
    column('plan', 'Planning', 1),
    column('exec', 'Executing', 2),
    column('review', 'Code Review', 3),
    column('testing', 'Testing', 4),
    column('done', 'Done', 5, { role: 'done', is_archived: true }),
  ];
  const planThenExecute = { route_start_swimlane_id: 'plan', route_last_swimlane_id: 'exec', skipped_swimlane_ids: [] };
  const skipsReview = { route_start_swimlane_id: 'plan', route_last_swimlane_id: 'testing', skipped_swimlane_ids: ['review'] };

  it('goes to the next column on the route when the route skips the one it names', () => {
    expect(resolveMoveTarget(columns, 'exec', 'Code Review', skipsReview)).toMatchObject({ ok: true, column: { id: 'testing' } });
  });

  it('goes to Done when the column it names lies past the route\'s last column', () => {
    expect(resolveMoveTarget(columns, 'exec', 'Code Review', planThenExecute)).toMatchObject({ ok: true, column: { id: 'done' } });
    expect(resolveMoveTarget(columns, 'exec', 'Testing', planThenExecute)).toMatchObject({ ok: true, column: { id: 'done' } });
  });

  it('keeps a send-back, which is never on the task\'s way forward', () => {
    expect(resolveMoveTarget(columns, 'testing', 'Executing', skipsReview)).toMatchObject({ ok: true, column: { id: 'exec' } });
    // A send-back to a column the route skips still goes there: only forward is the route's to decide.
    expect(resolveMoveTarget(columns, 'testing', 'Code Review', skipsReview)).toMatchObject({ ok: true, column: { id: 'review' } });
  });

  it('takes the next route column over a row that names Done, which would skip the rest of the route', () => {
    expect(resolveMoveTarget(columns, 'plan', 'Done', planThenExecute)).toMatchObject({ ok: true, column: { id: 'exec' } });
  });

  it('keeps a row that names Done from the route\'s last column', () => {
    expect(resolveMoveTarget(columns, 'exec', 'Done', planThenExecute)).toMatchObject({ ok: true, column: { id: 'done' } });
  });

  it('keeps a named column further along the route, which the route does visit', () => {
    expect(resolveMoveTarget(columns, 'plan', 'Testing', skipsReview)).toMatchObject({ ok: true, column: { id: 'testing' } });
  });

  it('leaves a task outside a workflow on the column the row names', () => {
    expect(resolveMoveTarget(columns, 'exec', 'Code Review')).toMatchObject({ ok: true, column: { id: 'review' } });
  });

  it('still refuses a column that does not exist, and the column the task is in', () => {
    expect(resolveMoveTarget(columns, 'exec', 'Nowhere', planThenExecute).ok).toBe(false);
    expect(resolveMoveTarget(columns, 'exec', 'Executing', planThenExecute)).toEqual({ ok: false, reason: 'The task is already in Executing.' });
  });
});
