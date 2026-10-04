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
 */
import { describe, it, expect } from 'vitest';
import { finalAgentReply } from '../../src/main/agent/shared/agent-reply';
import { resolveMoveTarget } from '../../src/main/automations/move-target';
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
});
