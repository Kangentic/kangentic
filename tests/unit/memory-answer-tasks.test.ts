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
  taskRef,
} from '../../src/main/retrieval/answer-tasks';
import { parseAnswerRefs } from '../../src/main/retrieval/answer-prompt';
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

describe('board tasks with no indexed conversation', () => {
  function boardTask(taskId: string, displayId: number, title: string, costUsd: number | null = null) {
    return {
      taskId, displayId, title, costUsd,
      sessions: 2, durationMs: null, tokens: null, outcome: 'done' as const,
      lastActivityMs: Date.UTC(2025, 1, 1), agent: 'claude', model: null,
    };
  }

  it('still gets a row, so the table the prompt calls complete is complete', () => {
    // The reported case: "how many adapters did we add?" answered two, because
    // four of the tasks that added one had no indexed conversation and were
    // missing from a table the agent was told held every task.
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't-indexed', displayId: 509, title: 'Add support for Antigravity' }),
    ]), 'balanced', null, [
      boardTask('t-indexed', 509, 'Add support for Antigravity'),
      boardTask('t-old', 14, 'Add support for OpenCode agent', 3.5),
    ]);

    expect(table.rows.map((row) => row.displayId).sort()).toEqual([14, 509]);
    const old = table.rows.find((row) => row.taskId === 't-old');
    expect(old).toMatchObject({ key: 't-old', docKeys: [], sessions: 2, costUsd: 3.5, region: null });
    // Its date widens the table's span, which the prompt states.
    expect(table.earliestMs).toBe(Date.UTC(2025, 1, 1));
    // The indexed task keeps its conversation-derived row rather than a copy.
    expect(table.rows.filter((row) => row.displayId === 509)).toHaveLength(1);
    expect(table.rows.find((row) => row.displayId === 509)?.docKeys).toEqual(['a']);
  });

  it('is left out when the map is filtered, since filters select conversations', () => {
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't-indexed', displayId: 509 }),
    ]), 'balanced', new Set(['a']), [boardTask('t-old', 14, 'Add support for OpenCode agent')]);
    expect(table.rows.map((row) => row.displayId)).toEqual([509]);
  });
});

describe('naming tasks by ticket', () => {
  it('refs a task by its board ticket, and an orphan conversation as C<n>', () => {
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', displayId: 529, costUsd: 9 }),
      node({ docKey: 'b', taskId: null, costUsd: 5 }),
    ]), 'balanced');
    expect(table.rows.map((row, index) => taskRef(row, index))).toEqual(['#529', 'C2']);
    // The table prints the same ref the prose will use, so the agent reads a
    // ticket and writes back the same one.
    expect(formatTaskTable(table)).toContain('\n#529|');
  });
});

describe('reading the tasks an answer is about', () => {
  // Refs as the prompt wrote them, mapped to task keys.
  const resolvable = new Map([
    ['#378', 'task:378'],
    ['#377', 'task:377'],
    ['#2', 'task:2'],
    ['C4', 'conversation:4'],
  ]);
  const related = new Set(['task:378', 'task:377', 'conversation:4']);

  it('parses the SELECTED line and strips it from the prose', () => {
    const { selected, text } = parseAnswerRefs('#378 cost the most.\nSELECTED: #378, #377, #378', resolvable, related);
    // Deduped, in the order written: a repeated ref would render a duplicate row.
    expect(selected).toEqual(['task:378', 'task:377']);
    expect(text).toBe('#378 cost the most.');
  });

  it('collects tasks named inline, in first-mention order', () => {
    // First-mention order is the order the reader has already seen in the
    // prose, so it is the one order the rows can never contradict.
    const { mentioned } = parseAnswerRefs('Mostly #377, then #378 and C4.', resolvable, related);
    expect(mentioned).toEqual(['task:377', 'task:378', 'conversation:4']);
  });

  it('does not trust a bare number that is not a task the answer could be about', () => {
    // "step #2" resolves to a real ticket, but that task is neither related
    // work nor selected, so it is prose, not a claim about task 2.
    const { mentioned } = parseAnswerRefs('Run step #2 before #378.', resolvable, related);
    expect(mentioned).toEqual(['task:378']);
  });

  it('trusts a task the SELECTED line names, even outside the related work', () => {
    const { mentioned } = parseAnswerRefs('Only #2 applies.\nSELECTED: #2', resolvable, related);
    expect(mentioned).toEqual(['task:2']);
  });

  it('ignores a ref the table never wrote', () => {
    const { selected, mentioned } = parseAnswerRefs('#999 did it.\nSELECTED: #999', resolvable, related);
    expect(selected).toEqual([]);
    expect(mentioned).toEqual([]);
  });

  it('does not mistake part of a longer token for a ref', () => {
    const { mentioned } = parseAnswerRefs('The ABC4 flag and ##378 changed.', resolvable, related);
    expect(mentioned).toEqual([]);
  });

  it('treats "none" as an empty selection', () => {
    const { selected, text } = parseAnswerRefs('Nothing matched.\nSELECTED: none', resolvable, related);
    expect(selected).toEqual([]);
    expect(text).toBe('Nothing matched.');
  });

  it('returns the answer untouched when there is no selection line', () => {
    const answer = 'We dropped it because a sphere circumscribes.';
    expect(parseAnswerRefs(answer, resolvable, related)).toEqual({ selected: [], mentioned: [], text: answer });
  });
});