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
}
let mockIndexes: Record<string, MockIndex> = {};

vi.mock('../../src/main/retrieval/retrieval-store', () => ({
  RetrievalStore: class {
    private readonly index: MockIndex;
    constructor(db: { projectId: string }) {
      const index = mockIndexes[db.projectId];
      if (!index) throw new Error(`no database for ${db.projectId}`);
      this.index = index;
    }
    searchSemantic(): SemanticHit[] { return this.index.semantic; }
    searchLexical(): [] { return []; }
    getChunkPlacements(ids: number[]): ChunkPlacement[] {
      return this.index.placements.filter((placement) => ids.includes(placement.id));
    }
    getChunks(ids: number[]): Array<{ id: number; text: string }> {
      return ids.flatMap((id) => (this.index.texts[id] ? [{ id, text: this.index.texts[id] }] : []));
    }
  },
}));

import {
  passageKey,
  searchRelatedWorkAcross,
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
