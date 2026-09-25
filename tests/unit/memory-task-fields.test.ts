/**
 * The field catalog, and the view spec an answer writes against it.
 *
 * These pin the properties that make the catalog worth having: that the prompt
 * table is GENERATED from it (so a new field cannot arrive undocumented or
 * unreadable), that a malformed spec degrades instead of failing, and that a
 * column carrying no signal is dropped while the one being ranked on never is.
 */

import { describe, it, expect } from 'vitest';
import {
  MEMORY_TASK_FIELDS,
  DEFAULT_TASK_VIEW,
  compareByField,
  resolveTaskField,
  taskFieldByKey,
  visibleTaskColumns,
  type MemoryTaskFacts,
} from '../../src/shared/memory-task-fields';
import { buildAnswerPrompt, parseAnswerView, parseGrounds } from '../../src/main/retrieval/answer-prompt';
import { buildAnswerTaskTable, formatTaskTable, summarizeTaskTable } from '../../src/main/retrieval/answer-tasks';
import type { MemoryGraphNode, MemoryGraphProjection } from '../../src/shared/types';

function facts(overrides: Partial<MemoryTaskFacts> = {}): MemoryTaskFacts {
  return {
    displayId: null,
    sessions: 1,
    costUsd: null,
    durationMs: null,
    tokens: null,
    outcome: null,
    lastActivityMs: null,
    region: null,
    agent: null,
    model: null,
    ...overrides,
  };
}

function node(overrides: Partial<MemoryGraphNode> & { docKey: string }): MemoryGraphNode {
  return {
    x: 0, y: 0, z: 0,
    chunkCount: 10,
    title: 'A task',
    sessionId: `session-${overrides.docKey}`,
    taskId: null,
    displayId: null,
    agent: null,
    model: null,
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

describe('the prompt table is generated from the catalog', () => {
  it('carries every catalog field as a column, in catalog order', () => {
    // The property that makes adding a field one edit. The header used to be a
    // string literal beside eleven hand-written cell expressions, and that is
    // exactly how eleven columns went into the prompt while four came out on
    // the wire.
    const header = formatTaskTable(buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1' }),
    ]), 'balanced')).split('\n')[0];
    expect(header.split('|')).toEqual([
      'ref', 'task', ...MEMORY_TASK_FIELDS.map((field) => field.key),
    ]);
  });

  it('prints the board ticket, and nothing at all when there is none', () => {
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', displayId: 529 }),
      node({ docKey: 'b', taskId: 't2', displayId: null }),
    ]), 'balanced');
    const lines = formatTaskTable(table).split('\n');
    const ticketColumn = lines[0].split('|').indexOf('ticket');
    const cells = lines.slice(1).map((line) => line.split('|')[ticketColumn]);
    expect(cells).toContain('#529');
    // Never `#undefined`, and never `#null`. An absent ticket is an empty cell.
    expect(cells).toContain('');
    expect(cells.join('')).not.toContain('undefined');
  });

  it('survives a facts object with holes in it', () => {
    // The wire does not have to match the type: an answer in flight across a
    // reload, or a detached window's older payload, arrives missing fields. A
    // `=== null` guard let one through and printed `#undefined` at the user.
    const holed = {} as MemoryTaskFacts;
    for (const field of MEMORY_TASK_FIELDS) {
      expect(() => field.cell(holed)).not.toThrow();
      expect(() => field.display(holed)).not.toThrow();
      expect(field.cell(holed)).not.toContain('undefined');
      expect(field.display(holed) ?? '').not.toContain('undefined');
    }
  });
});

describe('the computed summary', () => {
  function tableOf(nodes: MemoryGraphNode[]) {
    return buildAnswerTaskTable(projection(nodes), 'balanced');
  }

  it('states a total that AGREES with the rows it summarizes', () => {
    // The measured failure this exists for: asked for total spend, the agent
    // summed 350 rows and answered $14,860.99 against a true $17,117.60 - 13%
    // wrong and completely confident. A summary carrying a total that disagrees
    // with its own table would be strictly worse than no summary, because the
    // agent would now be confidently wrong on our authority instead of its own.
    const nodes = [
      node({ docKey: 'a', taskId: 't1', costUsd: 10.5 }),
      node({ docKey: 'b', taskId: 't2', costUsd: 90.25 }),
      node({ docKey: 'c', taskId: 't3', costUsd: null }),
    ];
    const table = tableOf(nodes);
    const summary = summarizeTaskTable(table);
    const rowTotal = table.rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);

    expect(rowTotal).toBeCloseTo(100.75, 2);
    // Bare, matching the column's own format - the summary and the table have
    // to be readable as the same units or the agent has to reconcile them.
    expect(summary).toContain('cost_usd: total 100.75');
    // A metric NOTHING recorded reports no total at all rather than "total 0",
    // which would turn "never measured" into "measured as free" in the one
    // place the agent is being told to trust our arithmetic over its own.
    expect(summary).not.toMatch(/duration: total/);
  });

  it('names the corpus size, so a subset can never pass as the whole board', () => {
    const table = tableOf([
      node({ docKey: 'a', taskId: 't1' }),
      node({ docKey: 'b', taskId: 't2' }),
    ]);
    expect(summarizeTaskTable(table)).toContain('tasks: 2');
  });

  it('collapses a field that never varies, and drops its column', () => {
    // Measured on the real index: `agent` has ONE distinct value across 350
    // tasks, so the table spent 4,200 characters repeating "Claude Code".
    const nodes = [
      node({ docKey: 'a', taskId: 't1', agent: 'Claude Code', costUsd: 1 }),
      node({ docKey: 'b', taskId: 't2', agent: 'Claude Code', costUsd: 2 }),
    ];
    const table = tableOf(nodes);
    expect(summarizeTaskTable(table)).toContain('agent: Claude Code for all 2');
    // Stated once above, so it is not repeated per row below.
    expect(formatTaskTable(table).split('\n')[0]).not.toContain('agent');
  });

  it('keeps a field that DOES vary in the table', () => {
    const table = tableOf([
      node({ docKey: 'a', taskId: 't1', agent: 'Claude Code' }),
      node({ docKey: 'b', taskId: 't2', agent: 'Codex' }),
    ]);
    expect(formatTaskTable(table).split('\n')[0]).toContain('agent');
  });

  it('never collapses the ticket, however uniform the board looks', () => {
    // Identity is how a row is NAMED. A one-task project would otherwise lose
    // the number the question asks about.
    const table = tableOf([node({ docKey: 'a', taskId: 't1', displayId: 529 })]);
    expect(formatTaskTable(table).split('\n')[0]).toContain('ticket');
  });

  it('names the rare values of a dimension by ref', () => {
    // "Which tasks are still in progress" is answerable from the summary alone
    // when the answer is three rows out of hundreds, which is the real shape of
    // this board: 347 done against 3 active.
    const nodes = [
      node({ docKey: 'a', taskId: 't1', outcome: 'done', costUsd: 9 }),
      node({ docKey: 'b', taskId: 't2', outcome: 'done', costUsd: 8 }),
      node({ docKey: 'c', taskId: 't3', outcome: 'done', costUsd: 7 }),
      node({ docKey: 'd', taskId: 't4', outcome: 'done', costUsd: 6 }),
      node({ docKey: 'e', taskId: 't5', outcome: 'done', costUsd: 5 }),
      node({ docKey: 'f', taskId: 't6', outcome: 'active', costUsd: 4 }),
    ];
    const summary = summarizeTaskTable(tableOf(nodes));
    expect(summary).toContain('done 5');
    expect(summary).toMatch(/active \(T6\)/);
  });

  it('ranks a measure so a superlative is a lookup, not a scan', () => {
    const nodes = [
      node({ docKey: 'a', taskId: 't1', costUsd: 5 }),
      node({ docKey: 'b', taskId: 't2', costUsd: 500 }),
      node({ docKey: 'c', taskId: 't3', costUsd: 50 }),
    ];
    // Rows are numbered after the cost sort, so the priciest is T1 by
    // construction - and the summary must say so rather than leave it implied.
    expect(summarizeTaskTable(tableOf(nodes))).toContain('highest first T1 T2 T3');
  });

  it('says so plainly when there is nothing to summarize', () => {
    expect(summarizeTaskTable(tableOf([]))).toContain('No tasks');
  });
});

describe('reading a view spec back out of an answer', () => {
  it('takes the columns and the ranking the answer named', () => {
    const { view, text } = parseAnswerView(
      'T1 is the largest at 12.4M.\nVIEW: tokens desc, duration, outcome',
    );
    expect(view?.select).toEqual(['tokens', 'duration', 'outcome']);
    expect(view?.order).toEqual({ key: 'tokens', direction: 'desc' });
    // The protocol line is stripped: it is an instruction, not prose.
    expect(text).toBe('T1 is the largest at 12.4M.');
  });

  it('accepts the synonyms a model actually writes', () => {
    expect(resolveTaskField('cost')?.key).toBe('cost_usd');
    expect(resolveTaskField('recency')?.key).toBe('last_active');
    expect(resolveTaskField('Duration_ms')?.key).toBe('duration');
    // Trailing prose, and a space where the header has an underscore.
    expect(resolveTaskField('last active.')?.key).toBe('last_active');
  });

  it('drops an invented column instead of failing the whole line', () => {
    // Degradation is the safety property. A spec is a display hint, so a bad
    // token must never cost the answer or the columns around it.
    const { view } = parseAnswerView('Answer.\nVIEW: importance desc, cost_usd');
    expect(view?.select).toEqual(['cost_usd']);
    expect(view?.order).toEqual({ key: 'cost_usd', direction: 'desc' });
  });

  it('returns no view when the line names nothing usable', () => {
    const { view } = parseAnswerView('Answer.\nVIEW: importance, vibes');
    expect(view).toBeNull();
  });

  it('returns no view when there is no line at all', () => {
    // The common case, and it has to be free: an ordinary answer must survive
    // the parser completely unchanged.
    const answer = 'We dropped the sphere fit because it circumscribes [2].';
    expect(parseAnswerView(answer)).toEqual({ view: null, text: answer });
  });

  it('ranks by the lead column when no direction was written', () => {
    // "Most important first" is the instruction, so the lead measure is the
    // ranking. Largest-first for a measure and newest-first for a date are both
    // `desc`, which is why this needs no branch.
    const { view } = parseAnswerView('Answer.\nVIEW: last_active, agent');
    expect(view?.order).toEqual({ key: 'last_active', direction: 'desc' });
  });

  it('refuses to order by a categorical column', () => {
    // "agent desc" would impose a ranking nobody asked for and quietly claim
    // the first row is the most something.
    const { view } = parseAnswerView('Answer.\nVIEW: agent desc, cost_usd');
    expect(view?.select).toEqual(['agent', 'cost_usd']);
    expect(view?.order).toEqual({ key: 'cost_usd', direction: 'desc' });
  });
});

describe('the prompt is built for its own length', () => {
  function promptFor(question: string) {
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', displayId: 529, costUsd: 10 }),
      node({ docKey: 'b', taskId: 't2', displayId: 44, costUsd: 20 }),
    ]), 'balanced');
    return buildAnswerPrompt(question, { tasks: table, nowMs: 1_756_100_000_000 });
  }

  it('puts the longform data ABOVE the rules and the question LAST', () => {
    // The documented shape for prompts over 20k tokens: data at the top,
    // instructions and query at the end, reported as worth up to 30% of
    // response quality. This prompt measures ~22.5k and ran rules-first until
    // it was checked against that guidance.
    const prompt = promptFor('What is the most expensive task?');
    const table = prompt.indexOf('<task_table>');
    const rules = prompt.indexOf('Answer only from <task_table>');
    const question = prompt.indexOf('Question:');

    expect(table).toBeGreaterThan(-1);
    expect(table).toBeLessThan(rules);
    expect(rules).toBeLessThan(question);
    // The query is genuinely last, not merely late.
    expect(prompt.trimEnd().endsWith('What is the most expensive task?')).toBe(true);
  });

  it('carries no passages of its own, and says where to find them', () => {
    // The transcripts used to arrive as an <excerpts> section our search chose
    // before the agent saw the question. They are pulled by the agent now,
    // through the one tool it is handed, so the prompt names the tool and its
    // mode rather than shipping a guess at what the question needs.
    const prompt = promptFor('why did we do that?');
    expect(prompt).not.toContain('<excerpts>');
    expect(prompt).toContain('kangentic_search');
    expect(prompt).toContain('mode "hybrid"');
    // And the rules say to try again before giving up, which is what a
    // pre-retrieved passage set could never do.
    expect(prompt).toMatch(/search again/);
  });
});

describe('lifting the working out of an answer', () => {
  it('separates the grounds from the answer', () => {
    const { grounds, text } = parseGrounds(
      '<grounds>\nT1 | 308.42 | cost_usd\n</grounds>\n#286 at $308.42 is the largest.',
    );
    expect(grounds).toBe('T1 | 308.42 | cost_usd');
    expect(text).toBe('#286 at $308.42 is the largest.');
  });

  it('leaves an answer with no grounds completely untouched', () => {
    // The common case, and it must be free.
    const answer = 'We dropped the sphere fit because it circumscribes [2].';
    expect(parseGrounds(answer)).toEqual({ grounds: null, text: answer });
  });

  it('does not leave a half-written block rendering as the answer', () => {
    // An unterminated opener would otherwise put `<grounds>` and everything
    // after it on screen as though it were the answer, which is worse than
    // showing no working at all.
    const { grounds, text } = parseGrounds('The answer is 42.\n<grounds>\nT1 | 42');
    expect(grounds).toBeNull();
    expect(text).toBe('The answer is 42.');
  });

  it('shows the working when the model wrote ONLY working', () => {
    // An empty rail is the one outcome worse than a badly-shaped answer.
    const { text } = parseGrounds('<grounds>\nT1 | 308.42\n</grounds>');
    expect(text).toBe('T1 | 308.42');
  });

  it('treats an empty block as no grounds rather than as empty grounds', () => {
    const { grounds, text } = parseGrounds('<grounds></grounds>\nThe answer.');
    expect(grounds).toBeNull();
    expect(text).toBe('The answer.');
  });
});

describe('ordering rows', () => {
  it('sorts an unmeasured task LAST in both directions', () => {
    // An unmeasured task is not a cheap one. Floating it to the top of
    // "cheapest first" would be a lie the reader cannot see.
    const rows = [facts({ costUsd: null }), facts({ costUsd: 10 }), facts({ costUsd: 90 })];
    const field = taskFieldByKey('cost_usd');
    if (!field) throw new Error('cost_usd must exist');

    const descending = [...rows].sort(compareByField(field, 'desc'));
    expect(descending.map((row) => row.costUsd)).toEqual([90, 10, null]);

    const ascending = [...rows].sort(compareByField(field, 'asc'));
    expect(ascending.map((row) => row.costUsd)).toEqual([10, 90, null]);
  });
});

describe('choosing which columns are worth rendering', () => {
  it('drops a column whose every value is the same', () => {
    // Eighteen rows all reading "Completed" spend width to say nothing. Same
    // rule the dead facet rows and the granularity control already follow.
    const rows = [
      facts({ outcome: 'done', costUsd: 10 }),
      facts({ outcome: 'done', costUsd: 90 }),
    ];
    const columns = visibleTaskColumns(
      { select: ['cost_usd', 'outcome'], order: { key: 'cost_usd', direction: 'desc' } },
      rows,
    );
    expect(columns.map((field) => field.key)).toEqual(['cost_usd']);
  });

  it('KEEPS a uniform column when it is the one being ranked on', () => {
    // The load-bearing exception. Asked which tasks are still in progress,
    // every row is "In Progress" and dropping the column would remove the one
    // that answers the question.
    const rows = [facts({ outcome: 'active' }), facts({ outcome: 'active' })];
    const columns = visibleTaskColumns(
      { select: ['outcome'], order: { key: 'outcome', direction: 'desc' } },
      rows,
    );
    expect(columns.map((field) => field.key)).toEqual(['outcome']);
  });

  it('drops a column no row ever recorded', () => {
    const rows = [facts({ costUsd: 10 }), facts({ costUsd: 90 })];
    const columns = visibleTaskColumns({ select: ['cost_usd', 'tokens'], order: null }, rows);
    expect(columns.map((field) => field.key)).toEqual(['cost_usd']);
  });

  it('never renders the ticket as a column, since it is already the badge', () => {
    const rows = [facts({ displayId: 1, costUsd: 5 }), facts({ displayId: 2, costUsd: 6 })];
    const columns = visibleTaskColumns({ select: ['ticket', 'cost_usd'], order: null }, rows);
    expect(columns.map((field) => field.key)).toEqual(['cost_usd']);
  });

  it('falls back to the default columns, which are what shipped before', () => {
    // An answer that declines the protocol must render exactly what the surface
    // rendered when there was no protocol at all.
    const rows = [
      facts({ costUsd: 10, durationMs: 60_000, outcome: 'done' }),
      facts({ costUsd: 90, durationMs: 120_000, outcome: 'active' }),
    ];
    const columns = visibleTaskColumns(DEFAULT_TASK_VIEW, rows);
    expect(columns.map((field) => field.key)).toEqual(['cost_usd', 'duration', 'outcome']);
  });

  it('names outcomes after the work rather than after the board', () => {
    const outcome = taskFieldByKey('outcome');
    expect(outcome?.display(facts({ outcome: 'done' }))).toBe('Completed');
    expect(outcome?.display(facts({ outcome: 'active' }))).toBe('In Progress');
    expect(outcome?.display(facts({ outcome: 'abandoned' }))).toBe('Dropped');
  });
});
