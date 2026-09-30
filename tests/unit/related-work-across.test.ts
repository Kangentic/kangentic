/**
 * Related work across projects: one embedding, one search per project, one
 * ranking.
 *
 * What this pins is what a merge can get wrong without anyone noticing: the
 * question embedded once rather than per project, chunk ids that repeat between
 * project databases kept apart, strength measured against the merged best, and
 * a project that cannot be read dropping out instead of failing the question.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ChunkPlacement, SemanticHit } from '../../src/main/retrieval/types';

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));

/** Each project's index, as the fake store reads it. */
interface MockIndex {
  semantic: SemanticHit[];
  placements: ChunkPlacement[];
  texts: Record<number, string>;
  /** The code corpus: its nearest chunks, and each one's file and text. */
  code?: { hits: SemanticHit[]; chunks: Record<number, { docId: string; text: string }> };
}
let mockIndexes: Record<string, MockIndex> = {};
/** The project of every code search the fake store served, in order. */
let codeSearches: string[] = [];
/** The MATCH text of every keyword search the fake store served, in order. */
let keywordQueries: string[] = [];

vi.mock('../../src/main/retrieval/retrieval-store', () => ({
  RetrievalStore: class {
    private readonly index: MockIndex;
    private readonly projectId: string;
    constructor(db: { projectId: string }) {
      const index = mockIndexes[db.projectId];
      if (!index) throw new Error(`no database for ${db.projectId}`);
      this.index = index;
      this.projectId = db.projectId;
    }
    searchSemantic(_query: Float32Array, _limit: number, corpora: ReadonlyArray<string>): SemanticHit[] {
      if (!corpora.includes('code')) return this.index.semantic;
      codeSearches.push(this.projectId);
      return this.index.code?.hits ?? [];
    }
    searchLexical(matchQuery: string): [] {
      keywordQueries.push(matchQuery);
      return [];
    }
    getChunkPlacements(ids: number[]): ChunkPlacement[] {
      return this.index.placements.filter((placement) => ids.includes(placement.id));
    }
    getChunks(ids: number[]): Array<{ id: number; docId?: string; text: string }> {
      return ids.flatMap((id) => {
        const codeChunk = this.index.code?.chunks[id];
        if (codeChunk) return [{ id, docId: codeChunk.docId, text: codeChunk.text }];
        return this.index.texts[id] ? [{ id, text: this.index.texts[id] }] : [];
      });
    }
  },
}));

import {
  CODE_PASSAGES,
  passageKey,
  searchRelatedWork,
  searchRelatedWorkAcross,
  selectCodePassages,
  type RelatedWorkNode,
  type SearchRelatedWorkAcrossInput,
} from '../../src/main/retrieval/related-work';

/** A hit at a cosine of `cosine`, as sqlite-vec reports it: an L2 distance. */
function hit(chunkId: number, cosine: number): SemanticHit {
  return { chunkId, rank: 1, distance: Math.sqrt(2 * (1 - cosine)) };
}

function placement(id: number, docId: string): ChunkPlacement {
  return { id, corpus: 'conversation', docId, sessionId: `session-${docId}`, taskId: null, tsStart: null, turnUuidStart: `turn-${id}` };
}

function node(docId: string, taskId: string, displayId: number): RelatedWorkNode {
  return { docKey: `conversation::${docId}`, taskId, displayId, title: `Title ${docId}` };
}

const getDb = ((projectId: string) => ({ projectId })) as unknown as SearchRelatedWorkAcrossInput['getDb'];

function embedder() {
  return {
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0]))),
    dimensions: 2,
    modelTag: 'test@1',
    noiseFloor: 0,
  };
}

describe('related work across projects', () => {
  it('embeds once, ranks every project together, and keeps repeated chunk ids apart', async () => {
    // Both projects have a chunk 1. Project B's is the closer match.
    mockIndexes = {
      a: { semantic: [hit(1, 0.7)], placements: [placement(1, 'a1')], texts: { 1: 'project a passage' } },
      b: {
        semantic: [hit(1, 0.9), hit(2, 0.5)],
        placements: [placement(1, 'b1'), placement(2, 'b2')],
        texts: { 1: 'project b passage', 2: 'weaker b passage' },
      },
    };
    const model = embedder();

    const work = await searchRelatedWorkAcross({
      question: 'how does pairing work?',
      projects: [
        { projectId: 'a', nodes: [node('a1', 'task-a1', 5)] },
        { projectId: 'b', nodes: [node('b1', 'task-b1', 5), node('b2', 'task-b2', 6)] },
      ],
      embedder: model,
      getDb,
    });

    expect(model.embed).toHaveBeenCalledTimes(1);
    expect(work.semantic).toBe(true);
    expect(work.ranked.map((task) => [task.projectId, task.key])).toEqual([
      ['b', 'task-b1'],
      ['a', 'task-a1'],
      ['b', 'task-b2'],
    ]);
    // Strength is against the best of ALL projects, not each project's own.
    expect(work.ranked[0].strength).toBe(1);
    expect(work.ranked[1].strength).toBeLessThan(1);
    expect(work.handed.map((task) => task.key)).toEqual(['task-b1', 'task-a1', 'task-b2']);
    // Chunk 1 is two different passages, one per project.
    expect(work.passages.get(passageKey('a', 1))).toBe('project a passage');
    expect(work.passages.get(passageKey('b', 1))).toBe('project b passage');
  });

  it('drops a project it cannot read rather than failing the question', async () => {
    mockIndexes = {
      a: { semantic: [hit(1, 0.8)], placements: [placement(1, 'a1')], texts: {} },
    };
    const work = await searchRelatedWorkAcross({
      question: 'anything',
      projects: [
        { projectId: 'a', nodes: [node('a1', 'task-a1', 5)] },
        { projectId: 'missing', nodes: [node('m1', 'task-m1', 1)] },
      ],
      embedder: embedder(),
      getDb,
    });
    expect(work.ranked.map((task) => task.key)).toEqual(['task-a1']);
  });

  it('searches by keyword alone when there is no embedder', async () => {
    mockIndexes = {
      a: { semantic: [hit(1, 0.8)], placements: [placement(1, 'a1')], texts: {} },
    };
    const work = await searchRelatedWorkAcross({
      question: 'anything',
      projects: [{ projectId: 'a', nodes: [node('a1', 'task-a1', 5)] }],
      embedder: null,
      getDb,
    });
    // No vectors, so the semantic hits are never asked for.
    expect(work.semantic).toBe(false);
    expect(work.ranked).toEqual([]);
  });
});

describe('the text the keyword search runs on', () => {
  const QUESTION = 'terminal renderer flicker';

  function search(extra: { keywordText?: string } = {}) {
    mockIndexes = { a: { semantic: [hit(1, 0.8)], placements: [placement(1, 'a1')], texts: {} } };
    keywordQueries = [];
    const model = embedder();
    const work = searchRelatedWork({
      question: QUESTION,
      projectId: 'a',
      nodes: [node('a1', 'task-a1', 5)],
      embedder: model,
      getDb,
      ...extra,
    });
    return { work, model };
  }

  it('is the question when no keywordText is given', async () => {
    await search().work;
    expect(keywordQueries).toEqual(['"terminal" OR "renderer" OR "flicker"']);
  });

  it('is keywordText instead of the question when one is given', async () => {
    await search({ keywordText: 'relay backoff' }).work;
    // The words only the question has stay out of it, the words only keywordText has are in.
    expect(keywordQueries).toEqual(['"relay" OR "backoff"']);
  });

  it('runs no keyword search when keywordText has nothing to search, whatever the question says', async () => {
    await search({ keywordText: 'which tasks were the most expensive?' }).work;
    expect(keywordQueries).toEqual([]);
  });

  it('leaves the semantic side on the question: the vector is embedded from it, not from keywordText', async () => {
    const { work, model } = search({ keywordText: 'relay backoff' });
    await work;
    expect(model.embed).toHaveBeenCalledOnce();
    expect(model.embed.mock.calls[0][0]).toContain(QUESTION);
    expect(model.embed.mock.calls[0][0]).not.toContain('relay backoff');
  });
});

/** A code chunk as `codeChunks` writes it: the path, a blank line, the code. */
function codeText(path: string, body: string): string {
  return `${path}\n\n${body}\n`;
}

/** One project's index with a task and the given code chunks. */
function indexWithCode(chunks: Array<{ id: number; path: string; cosine: number }>): MockIndex {
  return {
    semantic: [hit(1, 0.7)],
    placements: [placement(1, 'a1')],
    texts: { 1: 'a conversation passage' },
    code: {
      hits: chunks.map((chunk) => hit(chunk.id, chunk.cosine)),
      chunks: Object.fromEntries(chunks.map((chunk) => [chunk.id, { docId: chunk.path, text: codeText(chunk.path, `code ${chunk.id}`) }])),
    },
  };
}

describe('source code passages', () => {
  it('hands the closest chunks above the floor, two to a file, without the path line', async () => {
    mockIndexes = {
      a: indexWithCode([
        { id: 101, path: 'src/pacer.ts', cosine: 0.66 },
        { id: 102, path: 'src/pacer.ts', cosine: 0.64 },
        { id: 103, path: 'src/pacer.ts', cosine: 0.62 },
        { id: 104, path: 'docs/pacing.md', cosine: 0.5 },
        { id: 105, path: 'src/unrelated.ts', cosine: 0.44 },
      ]),
    };
    codeSearches = [];
    const work = await searchRelatedWork({
      question: 'How does the embedding drain pace itself?',
      projectId: 'a',
      nodes: [node('a1', 'task-a1', 5)],
      embedder: embedder(),
      getDb,
      code: true,
    });

    expect(codeSearches).toEqual(['a']);
    // The third pacer chunk is over the per-file cap; 0.44 is under the 0.45 floor.
    expect(work.code.map((passage) => [passage.path, passage.text])).toEqual([
      ['src/pacer.ts', 'code 101'],
      ['src/pacer.ts', 'code 102'],
      ['docs/pacing.md', 'code 104'],
    ]);
    // The tasks are ranked exactly as without code.
    expect(work.handed.map((task) => task.key)).toEqual(['task-a1']);
  });

  it('never searches code unless asked', async () => {
    mockIndexes = { a: indexWithCode([{ id: 101, path: 'src/pacer.ts', cosine: 0.9 }]) };
    codeSearches = [];
    const work = await searchRelatedWork({
      question: 'How does the embedding drain pace itself?',
      projectId: 'a',
      nodes: [node('a1', 'task-a1', 5)],
      embedder: embedder(),
      getDb,
    });
    expect(codeSearches).toEqual([]);
    expect(work.code).toEqual([]);
  });

  it('lowers the floor for a question that names an identifier', async () => {
    mockIndexes = { a: indexWithCode([{ id: 101, path: 'src/embed-engine.ts', cosine: 0.4 }]) };
    const ask = (question: string) => searchRelatedWork({
      question, projectId: 'a', nodes: [node('a1', 'task-a1', 5)], embedder: embedder(), getDb, code: true,
    });
    expect((await ask('Where is computeEmbedSleepMs?')).code.map((passage) => passage.path)).toEqual(['src/embed-engine.ts']);
    expect((await ask('Where is the sleep between batches computed?')).code).toEqual([]);
  });

  it('across projects, hands the best of them all and keeps one path in two projects apart', async () => {
    mockIndexes = {
      a: indexWithCode([
        { id: 101, path: 'src/shared.ts', cosine: 0.6 },
        { id: 102, path: 'src/shared.ts', cosine: 0.58 },
      ]),
      b: indexWithCode([
        { id: 101, path: 'src/shared.ts', cosine: 0.7 },
        { id: 102, path: 'src/shared.ts', cosine: 0.52 },
        { id: 103, path: 'src/shared.ts', cosine: 0.51 },
      ]),
    };
    const work = await searchRelatedWorkAcross({
      question: 'How is the shared state kept?',
      projects: [
        { projectId: 'a', nodes: [node('a1', 'task-a1', 5)] },
        { projectId: 'b', nodes: [node('b1', 'task-b1', 5)] },
      ],
      embedder: embedder(),
      getDb,
      code: true,
    });
    expect(work.code.map((passage) => [passage.projectId, passage.text])).toEqual([
      ['b', 'code 101'],
      ['a', 'code 101'],
      ['a', 'code 102'],
      ['b', 'code 102'],
    ]);
  });
});

describe('choosing code passages', () => {
  const candidate = (path: string, relevance: number) => ({ path, relevance });

  it('stops at the cap, best first', () => {
    const many = Array.from({ length: 12 }, (_, index) => candidate(`file-${index}.ts`, 0.9 - index * 0.01));
    const chosen = selectCodePassages(many, 0.45);
    expect(chosen).toHaveLength(CODE_PASSAGES);
    expect(chosen[0].path).toBe('file-0.ts');
  });

  it('keys files by the key it is given', () => {
    const chosen = selectCodePassages(
      [
        { path: 'same.ts', relevance: 0.9, projectId: 'a' },
        { path: 'same.ts', relevance: 0.8, projectId: 'a' },
        { path: 'same.ts', relevance: 0.7, projectId: 'a' },
        { path: 'same.ts', relevance: 0.6, projectId: 'b' },
      ],
      0.45,
      (passage) => `${passage.projectId}:${passage.path}`,
    );
    expect(chosen.map((passage) => [passage.projectId, passage.relevance])).toEqual([['a', 0.9], ['a', 0.8], ['b', 0.6]]);
  });
});
