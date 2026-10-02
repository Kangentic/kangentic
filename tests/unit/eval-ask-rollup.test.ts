/**
 * The Ask harness computes its own ground truth, so it carries its own copy of
 * the conversations-to-tasks rollup. This pins that the copy agrees with the
 * shipped one.
 *
 * Without it the harness measures its own arithmetic rather than the product's,
 * and the failure is silent in the worst possible way: every question keeps
 * passing while both sides are wrong together. The clustering rig used exactly
 * this self-check and it earned its keep immediately, catching a divergence
 * that had already changed a shipped answer.
 *
 * A drifting copy fails HERE, in the unit tier, at no quota cost - rather than
 * during a harness run that spends a real agent call per question to reach the
 * same conclusion.
 */

import { describe, it, expect } from 'vitest';
import { buildAnswerTaskTable } from '../../src/main/retrieval/answer-tasks';
import { toBoardTaskFacts, type BoardTaskFactsRow } from '../../src/main/retrieval/board-task-facts';
import type { KnowledgeGraphNode, KnowledgeGraphProjection } from '../../src/shared/types';
// The harness is plain ESM on purpose (it runs under bare node against a live
// preview), so it is imported here exactly as it ships.
import { __testing } from '../../scripts/eval-ask.mjs';

function node(overrides: Partial<KnowledgeGraphNode> & { docKey: string }): KnowledgeGraphNode {
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

/** Comparable shape: the fields both sides claim to compute. */
function comparable(rows: ReadonlyArray<{
  displayId: number | null;
  sessions: number;
  costUsd: number | null;
  durationMs: number | null;
  tokens: number | null;
  outcome: string | null;
  lastActivityMs: number | null;
  prState?: string | null;
}>) {
  return [...rows]
    .map((row) => ({
      displayId: row.displayId,
      sessions: row.sessions,
      costUsd: row.costUsd,
      durationMs: row.durationMs,
      tokens: row.tokens,
      outcome: row.outcome,
      lastActivityMs: row.lastActivityMs,
      prState: row.prState ?? null,
    }))
    // Row ORDER is not part of the contract - the shipped builder sorts by cost
    // as a truncation policy, the harness does not sort at all - so both sides
    // are keyed before comparison.
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

describe('the Ask harness rollup matches the shipped one', () => {
  it('agrees on a corpus that exercises every merge rule', () => {
    // Built to hit each rule the shipped builder states: summing across a
    // task's sessions, a null metric that must not become zero, an outcome
    // carried by only one session, a task-less conversation staying its own
    // row, and a display id present on only one of a task's nodes.
    const nodes = [
      node({ docKey: 'a', taskId: 't1', displayId: 529, costUsd: 10, durationMs: 60_000, tokens: 1_000, outcome: 'done', lastActivityMs: 1_000 }),
      node({ docKey: 'b', taskId: 't1', displayId: null, costUsd: 15, durationMs: null, tokens: null, outcome: null, lastActivityMs: 2_000 }),
      node({ docKey: 'c', taskId: 't2', displayId: 44, costUsd: null, durationMs: 30_000, tokens: 500, outcome: 'active', lastActivityMs: 3_000 }),
      node({ docKey: 'd', taskId: null, displayId: null, costUsd: 7, durationMs: 1_000, tokens: 90, outcome: null, lastActivityMs: 4_000 }),
      node({ docKey: 'e', taskId: 't3', displayId: 100, costUsd: 0, durationMs: 0, tokens: 0, outcome: 'done', lastActivityMs: 5_000 }),
    ];

    const shipped = buildAnswerTaskTable(projection(nodes), 'balanced').rows;
    const harness = __testing.rollUpConversations(nodes);

    expect(harness).toHaveLength(shipped.length);
    expect(comparable(harness)).toEqual(comparable(shipped));
  });

  it('adds the board tasks with no indexed conversation, as the shipped table does', () => {
    // The answer's table holds every board task since task records joined the
    // index. A harness that rolled up conversations alone counted 516 tasks
    // against the answer's 683 and failed three answers that were right.
    const nodes = [
      node({ docKey: 'a', taskId: 't1', displayId: 529, costUsd: 10, durationMs: 60_000, tokens: 1_000, outcome: 'done', lastActivityMs: 1_000 }),
    ];
    const boardRow = (taskId: string, displayId: number, costUsd: number | null): BoardTaskFactsRow => ({
      taskId,
      displayId,
      title: `Task ${displayId}`,
      outcome: 'done',
      sessions: 2,
      costUsd,
      durationMs: 5_000,
      tokens: null,
      lastActivity: '2026-09-01T12:00:00.000Z',
      agent: null,
      model: null,
      filesChanged: null,
      linesAdded: null,
      linesRemoved: null,
      prNumber: null,
      prState: null,
    });
    // t1 is on the board too: its conversation row must win, not be doubled,
    // and still carry the pull request the board records for its task.
    const boardTasks = [
      { ...boardRow('t1', 529, 99), prNumber: 255, prState: 'closed' },
      boardRow('t9', 14, 3.5),
      boardRow('t10', 15, null),
    ].map(toBoardTaskFacts);

    const shipped = buildAnswerTaskTable(projection(nodes), 'balanced', null, boardTasks).rows;
    const harness = __testing.rollUpConversations(nodes, boardTasks);

    expect(harness).toHaveLength(3);
    expect(comparable(harness)).toEqual(comparable(shipped));
    expect(harness.find((row) => row.displayId === 529)?.prState).toBe('closed');
  });

  it('keeps an unrecorded metric null on BOTH sides', () => {
    // The single rule most likely to drift, and the one whose drift is most
    // damaging: a zero here makes an unmeasured task the cheapest on the board
    // and silently inverts every "cheapest" answer the harness grades.
    const nodes = [node({ docKey: 'a', taskId: 't1', costUsd: null, durationMs: null, tokens: null })];
    const shipped = buildAnswerTaskTable(projection(nodes), 'balanced').rows[0];
    const harness = __testing.rollUpConversations(nodes)[0];

    expect(shipped.costUsd).toBeNull();
    expect(harness.costUsd).toBeNull();
    expect(harness.durationMs).toBeNull();
    expect(harness.tokens).toBeNull();
  });

  it('grades on containment, tolerating how a number was punctuated', () => {
    // The agent writes prose. `1,234` and `1234` are the same fact, and a
    // grader that fails one of them measures formatting rather than accuracy.
    const { pass } = __testing.grade('The total is $1,234.00 across the board.', {
      all: ['1234.00'],
      none: [],
    });
    expect(pass).toBe(true);
  });

  it('finds a fact in the rows as well as the prose', () => {
    // The phrase question: the prose said "Selected the task whose conversation
    // contains the exact phrase" and the row under it was #218. Right by any
    // reading a person would give it, and a prose-only grader failed it.
    const scoped = __testing.grade(
      'Selected the task.',
      { all: [], none: [], any: ['#218'] },
      { namedTasks: ['#218'] },
    );
    expect(scoped.pass).toBe(true);
  });

  it('judges a forbidden claim on the prose alone', () => {
    const declined = __testing.grade(
      'The sources do not cover this question.',
      { all: [], none: ['#218'] },
      { namedTasks: ['#218'] },
    );
    expect(declined.pass).toBe(true);
  });

  it('asks a grounded answer to quote what it read', () => {
    const expectation = { all: [], none: [], grounded: true };
    expect(__testing.grade('It fixed the scroll.', expectation).pass).toBe(false);
    expect(__testing.grade('It said "scroll to the latest turn".', expectation).pass).toBe(true);
  });

  it('fails an answer that says something it was told not to', () => {
    // The control questions depend entirely on this direction working.
    const { pass, forbidden } = __testing.grade('The capital of France is Paris.', {
      all: [],
      none: ['Paris'],
    });
    expect(pass).toBe(false);
    expect(forbidden).toEqual(['Paris']);
  });
});
