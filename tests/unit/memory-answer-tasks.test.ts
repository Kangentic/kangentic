/**
 * The board half of what Ask reads: every task, rolled up and formatted.
 *
 * These pin the properties that made the feature wrong before it existed. Ask
 * shipped able to read only passages, so "what was the most expensive task?"
 * was answered "the excerpts don't carry per-task cost" while the number sat on
 * every node. The rollup is what fixes that, and two of its rules are easy to
 * get subtly wrong: summing per TASK rather than per conversation, and never
 * turning a never-recorded metric into a zero.
 */

import { describe, it, expect } from 'vitest';
import {
  buildAnswerTaskTable,
  formatTaskTable,
  MAX_TASK_ROWS,
} from '../../src/main/retrieval/answer-tasks';
import { wantsTaskSelection, parseSelectedRefs } from '../../src/main/retrieval/answer-prompt';
import type { MemoryGraphNode, MemoryGraphProjection } from '../../src/shared/types';

function node(overrides: Partial<MemoryGraphNode> & { docKey: string }): MemoryGraphNode {
  return {
    x: 0, y: 0, z: 0,
    chunkCount: 10,
    title: 'A task',
    sessionId: `session-${overrides.docKey}`,
    taskId: null,
    // The fixture has to carry this or it expresses nothing about the ticket
    // the rows are labelled with - the same fixture-cannot-express-the-field
    // gap that has bitten the mirror four times on this surface.
    displayId: null,
    agent: 'Claude Code',
    model: 'claude-opus-5',
    effort: null,
    durationMs: null,
    costUsd: null,
    tokens: null,
    lastActivityMs: null,
    outcome: null,
    clusters: { coarse: 0, balanced: 0, fine: 0 },
    ...overrides,
  };
}

function projection(nodes: MemoryGraphNode[]): MemoryGraphProjection {
  return {
    nodes,
    edges: [],
    clusterings: [{
      granularity: 'balanced',
      regions: [{ label: 'terminal / pty', size: nodes.length, x: 0, y: 0, z: 0 }],
    }],
  } as unknown as MemoryGraphProjection;
}

describe('rolling conversations up into tasks', () => {
  it('sums cost and duration across a task\'s sessions', () => {
    // The load-bearing case, measured on the real corpus: the priciest single
    // CONVERSATION is not the priciest TASK, so answering per-conversation
    // returns the wrong row rather than merely a smaller number.
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', title: 'Big task', costUsd: 100, durationMs: 60_000 }),
      node({ docKey: 'b', taskId: 't1', title: 'Big task', costUsd: 90, durationMs: 30_000 }),
      node({ docKey: 'c', taskId: 't2', title: 'Small task', costUsd: 150, durationMs: 10_000 }),
    ]), 'balanced');

    expect(table.rows).toHaveLength(2);
    // t1 totals 190 and so outranks the single 150 conversation.
    expect(table.rows[0]).toMatchObject({ taskId: 't1', costUsd: 190, sessions: 2 });
    expect(table.rows[0].durationMs).toBe(90_000);
    expect(table.rows[1]).toMatchObject({ taskId: 't2', sessions: 1 });
    expect(table.conversationCount).toBe(3);
  });

  it('keeps a never-recorded metric null rather than calling it zero', () => {
    // A task with no cost recorded is not a free task, and a table that says 0
    // would make it the cheapest thing on the board.
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', costUsd: null, durationMs: null, tokens: null }),
    ]), 'balanced');
    expect(table.rows[0].costUsd).toBeNull();
    expect(table.rows[0].durationMs).toBeNull();
    // And the formatted row leaves the cells empty rather than printing 0.00.
    // Asserted against the header rather than a fixed column offset, so adding
    // a field to the catalog cannot silently move what this is checking.
    const [header, row] = formatTaskTable(table).split('\n');
    const columns = header.split('|');
    const cells = row.split('|');
    for (const key of ['cost_usd', 'duration', 'tokens']) {
      expect(cells[columns.indexOf(key)]).toBe('');
    }
  });

  it('adds a recorded metric to a sibling that has none', () => {
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', costUsd: null }),
      node({ docKey: 'b', taskId: 't1', costUsd: 12.5 }),
    ]), 'balanced');
    expect(table.rows[0].costUsd).toBe(12.5);
  });

  it('keeps conversations with no task separate rather than merging them', () => {
    // Merging them would produce one row about nothing, holding unrelated work.
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: null, title: 'Orphan one', costUsd: 5 }),
      node({ docKey: 'b', taskId: null, title: 'Orphan two', costUsd: 6 }),
    ]), 'balanced');
    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((row) => row.title)).toEqual(['Orphan two', 'Orphan one']);
  });

  it('takes the outcome from whichever session knows it', () => {
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', outcome: null }),
      node({ docKey: 'b', taskId: 't1', outcome: 'done' }),
    ]), 'balanced');
    expect(table.rows[0].outcome).toBe('done');
  });

  it('reports the task\'s most recent session as its recency', () => {
    const older = Date.UTC(2026, 0, 1);
    const newer = Date.UTC(2026, 5, 1);
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', lastActivityMs: older, model: 'old-model' }),
      node({ docKey: 'b', taskId: 't1', lastActivityMs: newer, model: 'new-model' }),
    ]), 'balanced');
    expect(table.rows[0].lastActivityMs).toBe(newer);
    // And names the model that ran most recently, not whichever came first.
    expect(table.rows[0].model).toBe('new-model');
    expect(table.earliestMs).toBe(older);
    expect(table.latestMs).toBe(newer);
  });

  it('states a truncation rather than silently answering from part of the board', () => {
    // A hidden truncation turns "every task" into a lie in exactly the
    // questions that depend on completeness.
    const many = Array.from({ length: MAX_TASK_ROWS + 5 }, (_unused, index) =>
      node({ docKey: `d${index}`, taskId: `t${index}`, costUsd: index }));
    const table = buildAnswerTaskTable(projection(many), 'balanced');
    expect(table.rows).toHaveLength(MAX_TASK_ROWS);
    expect(table.droppedTasks).toBe(5);
    // Ranked by cost, so a truncation drops the cheapest rather than a slice
    // that might contain the answer to "most expensive".
    expect(table.rows[0].costUsd).toBe(MAX_TASK_ROWS + 4);
  });

  it('does not let a title containing a pipe shift a column', () => {
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', title: 'Fix a|b parsing', costUsd: 1 }),
    ]), 'balanced');
    const [header, row] = formatTaskTable(table).split('\n');
    // Against the header's own width rather than a literal count, so the
    // assertion survives a field being added to the catalog and still catches
    // the thing it is for: a title's pipe shifting every later column.
    expect(row.split('|')).toHaveLength(header.split('|').length);
    expect(row).toContain('Fix a/b parsing');
  });

  it('falls back to a clustering that exists when the asked-for one does not', () => {
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1' }),
    ]), 'fine');
    expect(table.rows[0].region).toBe('terminal / pty');
  });
});

describe('selection questions', () => {
  it('recognises a question asking WHICH tasks', () => {
    expect(wantsTaskSelection('Show me the tasks related to terminal bug fixes')).toBe(true);
    expect(wantsTaskSelection('which tasks were abandoned?')).toBe(true);
    expect(wantsTaskSelection('list the work on mobile relay')).toBe(true);
  });

  it('leaves an explanation question alone', () => {
    // These want prose. Adding the selection line would ask for a trailing
    // SELECTED: on an answer that has nothing to select.
    expect(wantsTaskSelection('Why did we drop the sphere fit?')).toBe(false);
    expect(wantsTaskSelection('How does the activity engine decide idle?')).toBe(false);
  });

  it('parses the selected refs and strips the machinery from the prose', () => {
    const { refs, text } = parseSelectedRefs('Terminal and PTY work.\nSELECTED: T3, T17, T3, T9');
    // Deduped and ordered: a repeated ref would render a duplicate card.
    expect(refs).toEqual([3, 9, 17]);
    // The reader never sees the protocol line.
    expect(text).toBe('Terminal and PTY work.');
  });

  it('collects refs the answer named INLINE, with no protocol line at all', () => {
    // The case measured against a real agent: asked to describe mobile work it
    // wrote an essay naming 22 tasks as `T133` and never emitted SELECTED. Those
    // refs were real and rendered as dead text, so they are parsed out of the
    // prose rather than only out of a format the model may decline to use.
    const answer = 'Mobile work spans T133 Phase 1, T84 Phase 2, and T323 the protocol package.';
    const { refs, mentioned } = parseSelectedRefs(answer);
    // No SELECTED line, so nothing is claimed as a selection...
    expect(refs).toEqual([]);
    // ...but every named task is still resolvable, in FIRST-MENTION order.
    //
    // The order is the assertion, not incidental. It is what the rail falls
    // back to when the answer names no ranking column, and it is the one order
    // that can never look wrong, because it is the order the reader has already
    // seen in the prose. Sorting numerically - as this did - sorted by the
    // prompt table's row order, which is COST order, so every question that was
    // not about cost got a cost ranking it never asked for.
    expect(mentioned).toEqual([133, 84, 323]);
  });

  it('does not mistake a T inside an identifier for a task ref', () => {
    // Word-bounded, or `T1` in a token like `WT12` would light a random task.
    const { mentioned } = parseSelectedRefs('The WT12 branch and PART3 both changed.');
    expect(mentioned).toEqual([]);
  });

  it('counts a task named only in the protocol line as mentioned', () => {
    // The line is a statement about the answer, not decoration on the prose, so
    // a ref that appears nowhere else still has to resolve.
    const { refs, mentioned } = parseSelectedRefs('Two matched.\nSELECTED: T4, T8');
    expect(refs).toEqual([4, 8]);
    expect(mentioned).toEqual([4, 8]);
  });

  it('treats "none" as an empty selection rather than a parse failure', () => {
    const { refs, mentioned, text } = parseSelectedRefs('Nothing matched.\nSELECTED: none');
    expect(refs).toEqual([]);
    expect(mentioned).toEqual([]);
    expect(text).toBe('Nothing matched.');
  });

  it('returns the answer untouched when there is no selection line', () => {
    // An ordinary answer must survive the parser completely unchanged.
    const answer = 'We dropped it because a sphere circumscribes [2].';
    expect(parseSelectedRefs(answer)).toEqual({ refs: [], mentioned: [], text: answer });
  });
});
