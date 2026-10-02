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
  formatTaskFieldGlossary,
  formatTaskTable,
  mergeAnswerTaskTables,
  MAX_TASK_ROWS,
  refPrefixFor,
  summarizeTaskTable,
  taskRef,
} from '../../src/main/retrieval/answer-tasks';
import { parseAnswerRefs } from '../../src/main/retrieval/answer-prompt';
import type { KnowledgeGraphNode, KnowledgeGraphProjection } from '../../src/shared/types';

function node(overrides: Partial<KnowledgeGraphNode> & { docKey: string }): KnowledgeGraphNode {
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

function projection(nodes: KnowledgeGraphNode[]): KnowledgeGraphProjection {
  return {
    nodes,
    edges: [],
    clusterings: [{
      granularity: 'balanced',
      regions: [{ id: 0, label: 'terminal / pty', size: nodes.length, x: 0, y: 0, z: 0 }],
    }],
  } as unknown as KnowledgeGraphProjection;
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

  it('keeps a title with a newline on its own row instead of letting it start a row', () => {
    // A line reading "#999|Injected|0.00" would be taken for a task the table
    // never listed, with a cost the board never recorded.
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', displayId: 529, title: 'Fix\n#999|Injected|0.00', costUsd: 2 }),
      node({ docKey: 'b', taskId: 't2', displayId: 44, title: 'Plain title', costUsd: 1 }),
    ]), 'balanced');
    const [header, ...rows] = formatTaskTable(table).split('\n');

    // One line per task, however many lines its title had.
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.split('|')).toHaveLength(header.split('|').length);
    expect(rows.map((row) => row.split('|')[0])).toEqual(['#529', '#44']);
    expect(rows[0].split('|')[1]).toBe('Fix #999/Injected/0.00');
  });

  it('falls back to a clustering that exists when the asked-for one does not', () => {
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1' }),
    ]), 'fine');
    expect(table.rows[0].region).toBe('terminal / pty');
  });

  it('names a task\'s region by region id, not by position in the list', () => {
    // `labelClusters` orders regions largest first, so region 2 can sit at
    // position 0. Looking a node's cluster id up by position named the wrong
    // region for every task outside the largest one.
    const table = buildAnswerTaskTable({
      nodes: [
        node({ docKey: 'a', taskId: 't-big', clusters: { coarse: 2, balanced: 2, fine: 2 } }),
        node({ docKey: 'b', taskId: 't-small', clusters: { coarse: 0, balanced: 0, fine: 0 } }),
      ],
      edges: [],
      clusterings: [{
        granularity: 'balanced',
        regions: [
          { id: 2, label: 'git / worktrees', size: 30, x: 0, y: 0, z: 0 },
          { id: 0, label: 'terminal / pty', size: 20, x: 0, y: 0, z: 0 },
          { id: 1, label: 'settings / ui', size: 10, x: 0, y: 0, z: 0 },
        ],
      }],
    } as unknown as KnowledgeGraphProjection, 'balanced');
    const regionOf = (taskId: string) => table.rows.find((row) => row.taskId === taskId)?.region;
    expect(regionOf('t-big')).toBe('git / worktrees');
    expect(regionOf('t-small')).toBe('terminal / pty');
  });
});

describe('board tasks with no indexed conversation', () => {
  function boardTask(taskId: string, displayId: number, title: string, costUsd: number | null = null) {
    return {
      taskId, displayId, title, costUsd,
      sessions: 2, durationMs: null, tokens: null, outcome: 'done' as const,
      lastActivityMs: Date.UTC(2025, 1, 1), agent: 'claude', model: null,
      filesChanged: null, linesAdded: null, linesRemoved: null, prNumber: null, prState: null,
    };
  }

  it('gives every row its task\'s git churn and pull request, scoped or not', () => {
    // Churn and the PR are recorded per TASK, so a conversation-derived row
    // takes them from the board. Asked "how many files changed in that PR?",
    // the agent had nothing to read them from.
    const withChurn = {
      ...boardTask('t-indexed', 659, 'Review PR 417'),
      filesChanged: 12, linesAdded: 480, linesRemoved: 95, prNumber: 417, prState: 'merged',
    };
    for (const scope of [null, new Set(['a'])]) {
      const table = buildAnswerTaskTable(projection([
        node({ docKey: 'a', taskId: 't-indexed', displayId: 659 }),
      ]), 'balanced', scope, [withChurn]);
      expect(table.rows[0]).toMatchObject({
        filesChanged: 12, linesAdded: 480, linesRemoved: 95, prNumber: 417, prState: 'merged',
      });
    }
    const [header, row] = formatTaskTable(buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't-indexed', displayId: 659 }),
      node({ docKey: 'b', taskId: 't-other', displayId: 660 }),
    ]), 'balanced', null, [withChurn])).split('\n');
    const cells = Object.fromEntries(header.split('|').map((column, index) => [column, row.split('|')[index]]));
    expect(cells).toMatchObject({ files: '12', lines_added: '480', lines_removed: '95', pr: 'PR 417 merged' });
  });

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

    expect(table.rows.map((row) => row.displayId).sort((first, second) => (first ?? 0) - (second ?? 0))).toEqual([14, 509]);
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

  it('keeps reading a bare ticket after a dash', () => {
    const { mentioned } = parseAnswerRefs('Two tasks-#378 and #377.', resolvable, related);
    expect(mentioned).toEqual(['task:378', 'task:377']);
  });
});

describe('an answer asked across projects', () => {
  // The open project's #88 and another project's #88 are different tasks.
  const resolvable = new Map([
    ['#88', 'task:open-88'],
    ['mobile-app#88', 'task:mobile-88'],
  ]);
  const related = new Set(['task:open-88', 'task:mobile-88']);

  it('reads another project\'s ref whole, its prefix case-blind', () => {
    const { selected, mentioned } = parseAnswerRefs(
      'Mostly Mobile-App#88, then #88.\nSELECTED: mobile-app#88, #88',
      resolvable,
      related,
    );
    expect(mentioned).toEqual(['task:mobile-88', 'task:open-88']);
    expect(selected).toEqual(['task:mobile-88', 'task:open-88']);
  });

  it('never falls back from an unknown prefix to the open project\'s ticket', () => {
    const { selected } = parseAnswerRefs('website#88.\nSELECTED: website#88', resolvable, related);
    expect(selected).toEqual([]);
  });
});

describe('merging projects into one table', () => {
  it('gives each project a short prefix, distinct even when names reduce alike', () => {
    const taken = new Set<string>();
    const first = refPrefixFor('Mobile App', taken);
    taken.add(first);
    expect(first).toBe('mobile-app');
    expect(refPrefixFor('mobile_app!', taken)).toBe('mobile-app-2');
    // Never a trailing dash, which the ref parser depends on.
    expect(refPrefixFor('Relay (v2) ', new Set())).toBe('relay-v2');
    expect(refPrefixFor('***', new Set())).toBe('project');
  });

  it('prefixes every ticket outside the open project and keeps each project\'s facts', () => {
    const open = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', displayId: 88, title: 'Open task', costUsd: 5 }),
    ]), 'balanced');
    const other = buildAnswerTaskTable(projection([
      node({ docKey: 'b', taskId: 't2', displayId: 88, title: 'Mobile task', costUsd: 9 }),
    ]), 'balanced');
    const merged = mergeAnswerTaskTables([
      { table: open, projectId: 'p1', name: 'Kangentic', refPrefix: null },
      { table: other, projectId: 'p2', name: 'Mobile App', refPrefix: 'mobile-app' },
    ]);

    // Cheapest last, across both projects.
    expect(merged.rows.map((row, index) => taskRef(row, index))).toEqual(['mobile-app#88', '#88']);
    expect(merged.rows.map((row) => row.projectId)).toEqual(['p2', 'p1']);
    expect(merged.conversationCount).toBe(2);
    const text = formatTaskTable(merged);
    expect(text).toContain('\nmobile-app#88|Mobile task|');
    expect(text).toContain('\n#88|Open task|');
    expect(summarizeTaskTable(merged)).toMatch(/projects: Kangentic 1 tasks cost_usd 5\.00, written #N; Mobile App 1 tasks cost_usd 9\.00, written mobile-app#N/);
    expect(formatTaskFieldGlossary(merged)).toContain('written mobile-app#88');
  });

  it('truncates the union at the row cap, cheapest first, and says so', () => {
    const many = (prefix: string, count: number, cost: number) => buildAnswerTaskTable(projection(
      Array.from({ length: count }, (_unused, index) => node({
        docKey: `${prefix}-${index}`, taskId: `${prefix}-${index}`, displayId: index + 1, costUsd: cost,
      })),
    ), 'balanced');
    const merged = mergeAnswerTaskTables([
      { table: many('cheap', MAX_TASK_ROWS / 2 + 10, 1), projectId: 'p1', name: 'One', refPrefix: null },
      { table: many('dear', MAX_TASK_ROWS / 2 + 10, 50), projectId: 'p2', name: 'Two', refPrefix: 'two' },
    ]);
    expect(merged.rows).toHaveLength(MAX_TASK_ROWS);
    expect(merged.droppedTasks).toBe(20);
    expect(merged.rows.every((row) => row.projectId === 'p2' || row.costUsd === 1)).toBe(true);
    expect(merged.rows.filter((row) => row.projectId === 'p2')).toHaveLength(MAX_TASK_ROWS / 2 + 10);
  });
});