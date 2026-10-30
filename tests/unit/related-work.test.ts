/**
 * Related work: rolling chunk hits up to tasks, ranking them, and choosing the
 * set the agent is handed.
 *
 * The ranking rules came from free measurements on the real index (see the
 * header of `related-work.ts`). These pin the ones that are easy to undo by
 * accident: corroboration counts, keywords enter by rank and never by count, a
 * weak semantic hit is noise, and the handed set is a relative floor with a
 * clamp, plus whatever a follow-up pins.
 */

import { describe, it, expect, vi } from 'vitest';

// The module's database helpers are never reached by the pure functions, but
// importing it loads the database module, which needs Electron.
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));

import {
  contentWords,
  relatedKeywordQuery,
  KEYWORD_TERMS,
  rollUpRelatedWork,
  selectHandedTasks,
  selectPriorWork,
  priorWorkBackground,
  MIN_HANDED,
  MAX_HANDED,
  PRIOR_WORK_BACKGROUND_RANK,
  PRIOR_WORK_FLOOR,
  PRIOR_WORK_MARGIN,
  PRIOR_WORK_ROWS,
  type RelatedWorkNode,
  type RelatedWorkTask,
} from '../../src/main/retrieval/related-work';
import type { ChunkPlacement } from '../../src/main/retrieval/types';

function placement(id: number, docId: string, tsStart: number | null = null): ChunkPlacement {
  return {
    id,
    corpus: 'conversation',
    docId,
    sessionId: `session-${docId}`,
    taskId: null,
    tsStart,
    turnUuidStart: `turn-${id}`,
  };
}

function nodes(...entries: Array<[docId: string, taskId: string | null, displayId: number | null]>): Map<string, RelatedWorkNode> {
  const map = new Map<string, RelatedWorkNode>();
  for (const [docId, taskId, displayId] of entries) {
    const docKey = `conversation::${docId}`;
    map.set(docKey, { docKey, taskId, displayId, title: `Title ${docId}` });
  }
  return map;
}

describe('the question words', () => {
  it('keeps what a question is about and drops how it is asked', () => {
    expect(contentWords('How many tasks touched the terminal renderer?')).toEqual(['terminal', 'renderer']);
  });

  it('ORs and quotes the keywords, so FTS operators cannot leak in', () => {
    expect(relatedKeywordQuery('mobile relay NEAR pairing')).toBe('"mobile" OR "relay" OR "near" OR "pairing"');
  });

  it('has no keyword query for a question made only of question words', () => {
    expect(relatedKeywordQuery('which tasks were the most expensive?')).toBeNull();
  });

  // A pasted wall of text built an OR of thousands of terms. The question's own
  // words come first in the text searched, so the cap keeps them.
  //
  // Red-green: drop the `KEYWORD_TERMS` slice and the query carries all 500.
  it('caps the keyword query at KEYWORD_TERMS terms, keeping the first words', () => {
    const wall = Array.from({ length: 500 }, (_unused, index) => `word${index}`).join(' ');
    const query = relatedKeywordQuery(`renderer ${wall}`);
    const terms = query?.split(' OR ') ?? [];
    expect(terms).toHaveLength(KEYWORD_TERMS);
    expect(terms[0]).toBe('"renderer"');
    expect(terms[KEYWORD_TERMS - 1]).toBe(`"word${KEYWORD_TERMS - 2}"`);
  });

  // The full-text index tokenizes letters of any script (`unicode61`), so a word
  // outside ASCII is one word to the question as well. The ASCII-only class the
  // function used to clean with cut it at the first such letter.
  //
  // Red-green: with `/[^a-z0-9_\-\s]/g` in place of the Unicode class the first
  // assertion reads ['na', 've', 'parser'] (the two halves of the word, each long
  // enough to survive), and the Cyrillic and CJK words vanish entirely.
  describe('words outside ASCII', () => {
    it('keeps an accented word whole', () => {
      expect(contentWords('Which tasks changed the naïve parser?')).toEqual(['naïve', 'parser']);
    });

    it('keeps a word built from a base letter and a combining mark', () => {
      // "ï" as "i" then U+0308: the mark is not a letter, so a class of letters
      // alone would split the word at it.
      const decomposed = 'naïve';
      expect(contentWords(`Which tasks changed the ${decomposed} parser?`)).toEqual([decomposed, 'parser']);
    });

    it('keeps a Cyrillic word, lower-cased', () => {
      expect(contentWords('Which tasks touched the Терминал renderer?')).toEqual(['терминал', 'renderer']);
    });

    it('keeps a CJK word', () => {
      expect(contentWords('Which tasks changed 解析器 parser?')).toEqual(['解析器', 'parser']);
    });

    it('still splits on punctuation and keeps digits, underscores and hyphens', () => {
      expect(contentWords('resize_debounce, pty-host (v2) 200ms!')).toEqual(['resize_debounce', 'pty-host', 'v2', '200ms']);
    });

    it('quotes a non-ASCII word in the keyword query', () => {
      expect(relatedKeywordQuery('Which tasks changed the naïve parser?')).toBe('"naïve" OR "parser"');
      expect(relatedKeywordQuery('Which tasks touched the Терминал renderer?')).toBe('"терминал" OR "renderer"');
    });
  });
});

describe('rolling hits up to tasks', () => {
  it('sums a task across its conversations and keeps its best passage', () => {
    const ranked = rollUpRelatedWork({
      semantic: [
        { chunkId: 1, relevance: 0.5 },
        { chunkId: 2, relevance: 0.7 },
        { chunkId: 3, relevance: 0.6 },
      ],
      lexical: [],
      placements: new Map([
        [1, placement(1, 'a', 100)],
        [2, placement(2, 'b', 300)],
        [3, placement(3, 'c', 200)],
      ]),
      nodesByDocKey: nodes(['a', 't1', 561], ['b', 't1', 561], ['c', 't2', 564]),
    });

    expect(ranked.map((task) => task.key)).toEqual(['t1', 't2']);
    const [first] = ranked;
    expect(first.matches).toBe(2);
    expect(first.bestChunkId).toBe(2);
    // Where a row opens: the best passage's session and turn.
    expect(first.sessionId).toBe('session-b');
    expect(first.turnUuid).toBe('turn-2');
    expect(first.firstMs).toBe(100);
    expect(first.lastMs).toBe(300);
    expect(first.docKeys.sort()).toEqual(['conversation::a', 'conversation::b']);
    expect(first.strength).toBe(1);
    expect(ranked[1].strength).toBeLessThan(1);
  });

  it('ranks a corroborated task above one with a single slightly closer passage', () => {
    const ranked = rollUpRelatedWork({
      semantic: [
        { chunkId: 1, relevance: 0.62 },
        ...[2, 3, 4, 5, 6, 7, 8].map((chunkId) => ({ chunkId, relevance: 0.6 })),
      ],
      lexical: [],
      placements: new Map([
        [1, placement(1, 'single')],
        ...[2, 3, 4, 5, 6, 7, 8].map((chunkId): [number, ChunkPlacement] => [chunkId, placement(chunkId, 'many')]),
      ]),
      nodesByDocKey: nodes(['single', 't-single', 1], ['many', 't-many', 2]),
    });
    expect(ranked[0].key).toBe('t-many');
  });

  it('drops a semantic hit under the relevance cutoff', () => {
    const ranked = rollUpRelatedWork({
      semantic: [{ chunkId: 1, relevance: 0.05 }],
      lexical: [],
      placements: new Map([[1, placement(1, 'a')]]),
      nodesByDocKey: nodes(['a', 't1', 1]),
    });
    expect(ranked).toEqual([]);
  });

  it('gives keywords a bonus by rank, never by how often a word appears', () => {
    // A conversation that says "renderer" in a hundred passages must not
    // outrank a close semantic match on the strength of the count alone.
    const floodIds = Array.from({ length: 100 }, (_unused, index) => 100 + index);
    const ranked = rollUpRelatedWork({
      semantic: [{ chunkId: 1, relevance: 0.6 }],
      lexical: floodIds.map((chunkId, index) => ({ chunkId, rank: 150 + index })),
      placements: new Map<number, ChunkPlacement>([
        [1, placement(1, 'close')],
        ...floodIds.map((chunkId): [number, ChunkPlacement] => [chunkId, placement(chunkId, 'flood')]),
      ]),
      nodesByDocKey: nodes(['close', 't-close', 1], ['flood', 't-flood', 2]),
    });
    expect(ranked[0].key).toBe('t-close');
  });

  it('keeps a keyword-only task, with a passage to show', () => {
    const ranked = rollUpRelatedWork({
      semantic: [],
      lexical: [{ chunkId: 9, rank: 1 }],
      placements: new Map([[9, placement(9, 'a')]]),
      nodesByDocKey: nodes(['a', 't1', 1]),
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].bestChunkId).toBe(9);
  });

  it('drops a hit whose conversation is outside the scope', () => {
    // The map's filters are the scope of the question, so a conversation they
    // hide cannot become related work.
    const ranked = rollUpRelatedWork({
      semantic: [{ chunkId: 1, relevance: 0.8 }],
      lexical: [],
      placements: new Map([[1, placement(1, 'filtered-out')]]),
      nodesByDocKey: nodes(['a', 't1', 1]),
    });
    expect(ranked).toEqual([]);
  });

  it('keeps a conversation with no task as its own entry', () => {
    const ranked = rollUpRelatedWork({
      semantic: [{ chunkId: 1, relevance: 0.8 }],
      lexical: [],
      placements: new Map([[1, placement(1, 'orphan')]]),
      nodesByDocKey: nodes(['orphan', null, null]),
    });
    expect(ranked[0].key).toBe('conversation:conversation::orphan');
  });
});

describe('task records in the rollup', () => {
  /** A chunk of a task's own record (the `task` corpus). */
  function recordPlacement(id: number, taskId: string | null, docId = taskId ?? `backlog:${id}`): ChunkPlacement {
    return { id, corpus: 'task', docId, sessionId: null, taskId, tsStart: 50, turnUuidStart: null };
  }

  it('counts a record toward its task, and the row still opens the best conversation', () => {
    const ranked = rollUpRelatedWork({
      semantic: [
        { chunkId: 1, relevance: 0.5 },
        { chunkId: 70, relevance: 0.9 },
      ],
      lexical: [],
      placements: new Map([
        [1, { ...placement(1, 'a'), taskId: 't1' }],
        [70, recordPlacement(70, 't1')],
      ]),
      nodesByDocKey: nodes(['a', 't1', 561]),
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0].matches).toBe(2);
    // The record is the best passage for the prompt...
    expect(ranked[0].bestChunkId).toBe(70);
    // ...but a row opens a conversation, which a record is not.
    expect(ranked[0].sessionId).toBe('session-a');
    expect(ranked[0].turnUuid).toBe('turn-1');
    expect(ranked[0].docKeys).toEqual(['conversation::a']);
  });

  it('reaches a task with no conversation when the question is unscoped, with nothing to light', () => {
    const ranked = rollUpRelatedWork({
      semantic: [{ chunkId: 70, relevance: 0.7 }],
      lexical: [],
      placements: new Map([[70, recordPlacement(70, 't-quiet')]]),
      nodesByDocKey: nodes(['a', 't1', 1]),
      recordOnlyTasks: new Map([['t-quiet', { taskId: 't-quiet', displayId: 14, title: 'Add support for an agent' }]]),
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ key: 't-quiet', displayId: 14, title: 'Add support for an agent', docKeys: [], sessionId: null });
  });

  it('drops a record whose task has no conversation inside a filtered scope', () => {
    // The filters select conversations, so a task with none cannot be inside them.
    const ranked = rollUpRelatedWork({
      semantic: [{ chunkId: 70, relevance: 0.7 }],
      lexical: [{ chunkId: 70, rank: 1 }],
      placements: new Map([[70, recordPlacement(70, 't-quiet')]]),
      nodesByDocKey: nodes(['a', 't1', 1]),
    });
    expect(ranked).toEqual([]);
  });

  it('never makes a row of a backlog item, which has no board task', () => {
    const ranked = rollUpRelatedWork({
      semantic: [{ chunkId: 80, relevance: 0.9 }],
      lexical: [],
      placements: new Map([[80, recordPlacement(80, null)]]),
      nodesByDocKey: nodes(['a', 't1', 1]),
      recordOnlyTasks: new Map([['t1', { taskId: 't1', displayId: 1, title: 'One' }]]),
    });
    expect(ranked).toEqual([]);
  });

  /** A commit on the default branch (the `commit` corpus), found by keyword. */
  function commitPlacement(id: number, taskId: string | null): ChunkPlacement {
    return { id, corpus: 'commit', docId: `sha-${id}`, sessionId: null, taskId, tsStart: 60, turnUuidStart: null };
  }

  it('counts a keyword-matched commit toward the task that wrote it', () => {
    const ranked = rollUpRelatedWork({
      semantic: [{ chunkId: 1, relevance: 0.5 }],
      lexical: [{ chunkId: 90, rank: 1 }],
      placements: new Map([
        [1, { ...placement(1, 'a'), taskId: 't1' }],
        [90, commitPlacement(90, 't1')],
      ]),
      nodesByDocKey: nodes(['a', 't1', 561]),
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0].matches).toBe(2);
    expect(ranked[0].docKeys).toEqual(['conversation::a']);
  });

  it('never makes a row of an unlinked commit', () => {
    const ranked = rollUpRelatedWork({
      semantic: [],
      lexical: [{ chunkId: 91, rank: 1 }],
      placements: new Map([[91, commitPlacement(91, null)]]),
      nodesByDocKey: nodes(['a', 't1', 1]),
      recordOnlyTasks: new Map([['t1', { taskId: 't1', displayId: 1, title: 'One' }]]),
    });
    expect(ranked).toEqual([]);
  });
});

describe('choosing the handed set', () => {
  function rankedWithScores(scores: number[]): RelatedWorkTask[] {
    return scores.map((score, index) => ({
      key: `t${index}`,
      taskId: `t${index}`,
      displayId: index,
      title: `Task ${index}`,
      score,
      relevance: score,
      strength: score / scores[0],
      matches: 1,
      firstMs: null,
      lastMs: null,
      docKeys: [],
      bestChunkId: null,
      sessionId: null,
      turnUuid: null,
    }));
  }

  it('hands every task within the floor of the best', () => {
    const scores = [
      ...Array.from({ length: 20 }, () => 1),
      ...Array.from({ length: 20 }, () => 0.3),
    ];
    expect(selectHandedTasks(rankedWithScores(scores))).toHaveLength(20);
  });

  it('hands at least the minimum, so a sharp top still leaves room to judge', () => {
    const scores = [1, ...Array.from({ length: 30 }, () => 0.1)];
    expect(selectHandedTasks(rankedWithScores(scores))).toHaveLength(MIN_HANDED);
  });

  it('never hands more than the maximum', () => {
    const scores = Array.from({ length: 200 }, () => 1);
    expect(selectHandedTasks(rankedWithScores(scores))).toHaveLength(MAX_HANDED);
  });

  it('adds a task a follow-up pinned, however far down it ranked', () => {
    // "Which of those" refers to the earlier answer's tasks, so they stay.
    const scores = [1, ...Array.from({ length: 30 }, () => 0.1)];
    const handed = selectHandedTasks(rankedWithScores(scores), new Set(['t25']));
    expect(handed).toHaveLength(MIN_HANDED + 1);
    expect(handed.map((task) => task.key)).toContain('t25');
  });
});

/**
 * The task window's prior work (the "N earlier conversations about this"
 * line). Measured on the dogfood index, it showed on every task because nothing
 * filtered by time or by tool output and its only gate was a cutoff nearly
 * every chunk clears. See the header of `related-work.ts`.
 */
describe('prior work on a task', () => {
  const CREATED_MS = 10_000;

  // Red-green: drop the `beforeMs` check in the rollup and both later chunks
  // count, so t-later ranks and t-earlier's best passage is the later one.
  it('counts only chunks from before the task was created, and none with no time', () => {
    const ranked = rollUpRelatedWork({
      semantic: [
        { chunkId: 1, relevance: 0.6 },
        { chunkId: 2, relevance: 0.9 },
        { chunkId: 3, relevance: 0.8 },
        { chunkId: 4, relevance: 0.7 },
      ],
      lexical: [],
      placements: new Map([
        [1, placement(1, 'earlier', CREATED_MS - 1)],
        [2, placement(2, 'earlier', CREATED_MS + 1)],
        [3, placement(3, 'later', CREATED_MS)],
        [4, placement(4, 'undated', null)],
      ]),
      nodesByDocKey: nodes(['earlier', 't-earlier', 1], ['later', 't-later', 2], ['undated', 't-undated', 3]),
      beforeMs: CREATED_MS,
    });
    expect(ranked.map((task) => task.key)).toEqual(['t-earlier']);
    expect(ranked[0].bestChunkId).toBe(1);
    expect(ranked[0].relevance).toBe(0.6);
  });

  it('counts nothing when the cutoff is not a number', () => {
    const ranked = rollUpRelatedWork({
      semantic: [{ chunkId: 1, relevance: 0.6 }],
      lexical: [],
      placements: new Map([[1, placement(1, 'a', 5)]]),
      nodesByDocKey: nodes(['a', 't1', 1]),
      beforeMs: Number.NaN,
    });
    expect(ranked).toEqual([]);
  });

  // Red-green: drop the `excludedChunkIds` check and chunk 1 wins t1's row,
  // so the row opens on tool output.
  it('lets an excluded chunk neither score nor win a row, as a keyword or a vector hit', () => {
    const ranked = rollUpRelatedWork({
      semantic: [
        { chunkId: 1, relevance: 0.9 },
        { chunkId: 2, relevance: 0.5 },
      ],
      lexical: [{ chunkId: 1, rank: 1 }],
      placements: new Map([
        [1, placement(1, 'a')],
        [2, placement(2, 'b')],
      ]),
      nodesByDocKey: nodes(['a', 't1', 1], ['b', 't1', 1]),
      excludedChunkIds: new Set([1]),
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].bestChunkId).toBe(2);
    expect(ranked[0].relevance).toBe(0.5);
    expect(ranked[0].matches).toBe(1);
  });

  describe('the background a task is measured against', () => {
    const pool = (count: number, start = 0): Array<[number, number]> => (
      Array.from({ length: count }, (_unused, index) => [start + index, 1 - index / 1000])
    );

    it('is the PRIOR_WORK_BACKGROUND_RANKth best relevance', () => {
      const relevance = new Map(pool(PRIOR_WORK_BACKGROUND_RANK + 50));
      expect(priorWorkBackground(relevance, new Map(), 'own')).toBeCloseTo(1 - (PRIOR_WORK_BACKGROUND_RANK - 1) / 1000);
    });

    // The task's own conversations match its text best, and are not what the
    // rest of the index looks like near it.
    //
    // Red-green: drop the own-task filter and the background is the 100th best
    // of everything, which the own chunks push up.
    it('leaves out the task\'s own chunks', () => {
      const own = Array.from({ length: 30 }, (_unused, index): [number, number] => [5000 + index, 0.99]);
      const relevance = new Map([...own, ...pool(PRIOR_WORK_BACKGROUND_RANK + 50)]);
      const placements = new Map(own.map(([chunkId]): [number, ChunkPlacement] => [chunkId, { ...placement(chunkId, 'mine'), taskId: 'own' }]));
      expect(priorWorkBackground(relevance, placements, 'own')).toBeCloseTo(1 - (PRIOR_WORK_BACKGROUND_RANK - 1) / 1000);
    });

    it('is null when fewer chunks than the rank are left to measure', () => {
      const relevance = new Map(pool(PRIOR_WORK_BACKGROUND_RANK - 1));
      expect(priorWorkBackground(relevance, new Map(), 'own')).toBeNull();
    });
  });

  describe('choosing the rows', () => {
    function row(key: string, relevance: number, overrides: Partial<RelatedWorkTask> = {}): RelatedWorkTask {
      return {
        key,
        taskId: key,
        displayId: null,
        title: `Task ${key}`,
        // A score that disagrees with relevance, so ordering by it would show.
        score: 1 - relevance,
        relevance,
        strength: 1,
        matches: 1,
        firstMs: null,
        lastMs: null,
        docKeys: [`conversation::${key}`],
        bestChunkId: null,
        sessionId: `session-${key}`,
        turnUuid: null,
        ...overrides,
      };
    }
    const BACKGROUND = 0.4;
    const CLEARS = BACKGROUND + PRIOR_WORK_MARGIN;

    it('shows nothing when no task stands far enough above the background', () => {
      expect(selectPriorWork([row('a', CLEARS - 0.001), row('b', 0.2)], BACKGROUND)).toEqual([]);
    });

    it('shows nothing when there is no background to measure against', () => {
      expect(selectPriorWork([row('a', 0.95)], null)).toEqual([]);
    });

    it('shows the tasks that clear the margin, best passage first', () => {
      const shown = selectPriorWork([row('low', CLEARS), row('high', CLEARS + 0.1), row('under', CLEARS - 0.01)], BACKGROUND);
      expect(shown.map((task) => task.key)).toEqual(['high', 'low']);
    });

    // A sparse neighborhood has a low background, so the margin alone would
    // pass a passage that is not close in any absolute sense.
    it('holds the absolute floor when the background is low', () => {
      const low = 0.1;
      expect(low + PRIOR_WORK_MARGIN).toBeLessThan(PRIOR_WORK_FLOOR);
      expect(selectPriorWork([row('a', PRIOR_WORK_FLOOR - 0.01)], low)).toEqual([]);
      expect(selectPriorWork([row('a', PRIOR_WORK_FLOOR)], low)).toHaveLength(1);
    });

    // A row names its task and opens a conversation.
    it('skips a task matched with no conversation to open, and a conversation with no task', () => {
      const shown = selectPriorWork([
        row('no-session', 0.9, { sessionId: null }),
        row('no-task', 0.9, { taskId: null }),
        row('kept', 0.9),
      ], BACKGROUND);
      expect(shown.map((task) => task.key)).toEqual(['kept']);
    });

    // Unlike the handed set, there is no minimum: a few rows, or none.
    it('shows at most PRIOR_WORK_ROWS', () => {
      const ranked = Array.from({ length: PRIOR_WORK_ROWS + 3 }, (_unused, index) => row(`t${index}`, 0.9 - index / 100));
      expect(selectPriorWork(ranked, BACKGROUND)).toHaveLength(PRIOR_WORK_ROWS);
    });
  });
});
