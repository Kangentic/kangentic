/**
 * The field catalog, and the prompt generated from it.
 *
 * These pin the properties that make the catalog worth having: that the prompt
 * table is GENERATED from it (so a new field cannot arrive undocumented or
 * unreadable), that a column carrying no signal is stated once rather than on
 * every row, and that the prompt is laid out for its own length.
 */

import { describe, it, expect } from 'vitest';
import {
  MEMORY_TASK_FIELDS,
  type MemoryTaskFacts,
} from '../../src/shared/memory-task-fields';
import { buildAnswerPrompt, formatRelatedWork } from '../../src/main/retrieval/answer-prompt';
import {
  buildAnswerTaskTable,
  formatTaskFieldGlossary,
  formatTaskTable,
  summarizeTaskTable,
} from '../../src/main/retrieval/answer-tasks';
import type { MemoryGraphNode, MemoryGraphProjection } from '../../src/shared/types';

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
    // the wire. The ticket is the ref column, so it is not repeated.
    const header = formatTaskTable(buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1' }),
    ]), 'balanced')).split('\n')[0];
    expect(header.split('|')).toEqual([
      'ref', 'task', ...MEMORY_TASK_FIELDS.filter((field) => field.key !== 'ticket').map((field) => field.key),
    ]);
  });

  it('leads each row with its ticket, and never an undefined one', () => {
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', displayId: 529, costUsd: 2 }),
      node({ docKey: 'b', taskId: 't2', displayId: null, costUsd: 1 }),
    ]), 'balanced');
    const refs = formatTaskTable(table).split('\n').slice(1).map((line) => line.split('|')[0]);
    // A task with no ticket is named by its position instead.
    expect(refs).toEqual(['#529', 'C2']);
    expect(refs.join('')).not.toMatch(/undefined|null/);
  });

  it('glosses the ref as the way to name a task, and never the retired T refs', () => {
    const glossary = formatTaskFieldGlossary();
    expect(glossary).toMatch(/^ref - .*#529/m);
    expect(glossary).not.toMatch(/\bT ref\b|\bT\d/);
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

  it('never loses the ticket, however uniform the board looks', () => {
    // Identity is how a row is NAMED. A one-task project would otherwise lose
    // the number the question asks about.
    const table = tableOf([node({ docKey: 'a', taskId: 't1', displayId: 529 })]);
    expect(formatTaskTable(table).split('\n')[1].startsWith('#529|')).toBe(true);
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
      node({ docKey: 'f', taskId: 't6', displayId: 606, outcome: 'active', costUsd: 4 }),
    ];
    const summary = summarizeTaskTable(tableOf(nodes));
    expect(summary).toContain('done 5');
    expect(summary).toMatch(/active \(#606\)/);
  });

  it('ranks a measure so a superlative is a lookup, not a scan', () => {
    const nodes = [
      node({ docKey: 'a', taskId: 't1', displayId: 11, costUsd: 5 }),
      node({ docKey: 'b', taskId: 't2', displayId: 22, costUsd: 500 }),
      node({ docKey: 'c', taskId: 't3', displayId: 33, costUsd: 50 }),
    ];
    // The summary names the ranking by the same refs the table uses, so the
    // priciest is stated rather than left to a scan.
    expect(summarizeTaskTable(tableOf(nodes))).toContain('highest first #22 #33 #11');
  });

  it('says so plainly when there is nothing to summarize', () => {
    expect(summarizeTaskTable(tableOf([]))).toContain('No tasks');
  });
});

describe('the prompt is built for its own length', () => {
  const related = [{
    ref: '#529', title: 'Memory graph', strength: 1, matches: 12,
    firstMs: Date.UTC(2026, 7, 1), lastMs: Date.UTC(2026, 8, 20), passage: 'we lit the related set',
    facts: {
      displayId: 529, sessions: 3, costUsd: 136.74, durationMs: 280_740_000, tokens: null,
      outcome: 'active' as const, lastActivityMs: null, region: null, agent: null, model: null,
      filesChanged: 42, linesAdded: 3100, linesRemoved: 870, prNumber: 417, prState: 'open',
    },
  }];

  function promptFor(question: string, canSearch = true, history: Parameters<typeof buildAnswerPrompt>[1]['history'] = []) {
    const table = buildAnswerTaskTable(projection([
      node({ docKey: 'a', taskId: 't1', displayId: 529, costUsd: 10 }),
      node({ docKey: 'b', taskId: 't2', displayId: 44, costUsd: 20 }),
    ]), 'balanced');
    return buildAnswerPrompt(question, { tasks: table, nowMs: Date.UTC(2026, 8, 25), related, canSearch, history });
  }

  it('keeps the stable table and rules ahead of what changes per question, and the question last', () => {
    // Long data first and the question last is the documented shape for long
    // prompts. And the table and rules are the same for every question, so
    // they come before the related work and the chat, keeping that prefix cached.
    const prompt = promptFor('Which tasks touched the relay?', true, [
      { question: 'What is the relay?', answer: 'It forwards bytes.', refs: ['#529'] },
    ]);
    const table = prompt.indexOf('<task_table>');
    const rules = prompt.indexOf('Answer only from');
    const relatedWork = prompt.indexOf('<related_work>');
    const history = prompt.indexOf('<conversation_so_far>');
    const question = prompt.indexOf('Question:');

    expect(table).toBeGreaterThan(-1);
    expect(table).toBeLessThan(rules);
    expect(rules).toBeLessThan(relatedWork);
    expect(relatedWork).toBeLessThan(history);
    expect(history).toBeLessThan(question);
    expect(prompt.trimEnd().endsWith('Which tasks touched the relay?')).toBe(true);
  });

  it('names the search tool only when the agent can use it', () => {
    expect(promptFor('why?', true)).toContain('kangentic_search');
    expect(promptFor('why?', false)).not.toContain('kangentic_search');
  });

  it('asks for prose and leaves the listing to the rows', () => {
    // The rows under an answer list every selected task, so a list in the
    // prose repeats them. Asked "which tasks", an agent listed all fourteen.
    const prompt = promptFor('Which tasks touched the relay?');
    expect(prompt).toMatch(/even when the question asks which tasks, do not list them/);
    // A hard number, because "the few that matter" did not hold: Haiku named
    // all thirteen inline, grouped and bolded.
    expect(prompt).toMatch(/Name at most three tasks in the prose/);
  });

  it('carries the related work with its strength, its facts and its passage', () => {
    // The facts ride on the related row itself, so "the most expensive task
    // related to X" is a read down one column rather than a table lookup per
    // task, which Haiku got wrong when it had to do it.
    const lines = formatRelatedWork(related).split('\n');
    expect(lines[1]).toBe(
      'ref|task|strength|matches|first|last|cost_usd|duration|tokens|sessions|files|lines_added|lines_removed|outcome|pr|digest|passage',
    );
    // A pull request is written "PR 417", never "#417", which would read as a task.
    expect(lines[2]).toBe(
      '#529|Memory graph|1.00|12|2026-08-01|2026-09-20|136.74|77h 59m||3|42|3100|870|active|PR 417 open||"we lit the related set"',
    );
    expect(formatRelatedWork([])).toMatch(/Nothing/);
  });

  it('carries a finished task\'s digest beside its passage, quoted like it', () => {
    const lines = formatRelatedWork([{ ...related[0], digest: 'Built the "set first" answer | and the map.' }]).split('\n');
    expect(lines[2]).toContain('|"Built the \'set first\' answer / and the map."|"we lit the related set"');
  });

  it('tells the agent the reader cannot see the tags', () => {
    expect(promptFor('Which tasks touched the relay?')).toMatch(/never open with "Based on"/);
  });

  it('restates the reply\'s shape right above the question, where it is read last', () => {
    const prompt = promptFor('Which tasks touched the relay?');
    const reminder = prompt.indexOf('Reply in two to four plain sentences');
    expect(reminder).toBeGreaterThan(prompt.indexOf('</related_work>'));
    expect(reminder).toBeLessThan(prompt.indexOf('Question:'));
    expect(prompt).toMatch(/never with their titles/);
    expect(prompt).toMatch(/never correct yourself in the reply/);
  });

  it('asks for one committed answer: a count first, one reading of "biggest"', () => {
    // Seen on Sonnet at low effort: thirteen refs listed, then "that's actually
    // more than nine", and "the biggest" answered by cost AND by duration.
    const prompt = promptFor('What was the biggest change?');
    expect(prompt).toMatch(/pick the reading that fits best, name its measure/);
    expect(prompt).toMatch(/state it once, as a number,\s+before naming any task/);
    const reminder = prompt.slice(prompt.indexOf('Reply in two to four plain sentences'));
    expect(reminder).toMatch(/for a count, the number first/);
    // Named outright: with only the general rule, Sonnet still closed on "If
    // instead you mean tasks that are literally review passes...".
    expect(reminder).toMatch(/never an "if instead you mean" second answer/);
  });

  it('tells an agent with the search tool to search rather than say it would need to', () => {
    // "I'd need to search the conversation directly" came from an agent holding the tool.
    expect(promptFor('How many files changed?', true)).toMatch(/Never tell the reader you would need to search: search/);
    expect(promptFor('How many files changed?', true)).toMatch(/search before saying so/);
    expect(promptFor('How many files changed?', false)).not.toMatch(/search before saying so/);
  });
});
