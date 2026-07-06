import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Project } from '../../src/shared/types';
import type { Embedder } from '../../src/main/retrieval/types';

/**
 * searchConversationMemory calibrated-relevance contract.
 *
 * `relevantSemantic` (private to memory-search.ts) filters raw semantic hits by a
 * MODEL-INDEPENDENT relevance derived from the active model's anisotropy floor,
 * carried on the embedder as `noiseFloor`. Embeddings are normalized and the vec
 * table uses L2 distance, so cosine = `1 - distance^2 / 2` (distance 0 => cos 1;
 * distance sqrt(2) ~= 1.414 => cos 0). A hit survives when
 * `(cos - noiseFloor) / (1 - noiseFloor) >= SEMANTIC_RELEVANCE_CUTOFF` (0.15), so
 * unrelated text (which lands at the floor -> relevance ~0) is dropped while a
 * genuine match (cos well above the floor) is kept. A floor <= 0 (or >= 1)
 * disables the filter and keeps every hit.
 *
 * As in memory-search-degradation.test.ts, `store.searchSemantic` returns []
 * unless the connection is marked vec-capable (a WeakSet in vec-support), so
 * this scripts a fake per-project DB AND calls `markVecCapable` on every
 * connection the fake getDb hands out, so the real semantic-fusion code path
 * (not just the lexical-degradation path) actually runs end to end here.
 */

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => {
    throw new Error('getProjectDb should not be called - getDb is injected in tests');
  }),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: () => undefined },
}));

import { searchConversationMemory } from '../../src/main/retrieval/memory-search';
import { markVecCapable } from '../../src/main/retrieval/vec-support';

// --- Fixed-vector fake embedder ---------------------------------------------
// The relevance filter operates on the scripted `distance` values from the (fake)
// vec table plus the embedder's `noiseFloor`, so the embedder produces SOME
// non-null query vector (to take the semantic path) and carries a scriptable
// floor (to calibrate the filter). A floor of 0.6 mirrors the bge tiers.

class FixedEmbedder implements Embedder {
  readonly dimensions = 3;
  readonly modelTag = 'fixed-embedder@test';
  callCount = 0;

  constructor(readonly noiseFloor: number) {}

  async embed(texts: string[]): Promise<Float32Array[] | null> {
    this.callCount += 1;
    return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
  }
}

// --- Fake scripted DB --------------------------------------------------------

interface StoredChunkRow {
  id: number;
  corpus: string;
  doc_id: string;
  seq: number;
  session_id: string | null;
  task_id: string | null;
  agent_session_id: string | null;
  role: string;
  text: string;
  content_hash: string;
  token_estimate: number;
  ts_start: number | null;
  ts_end: number | null;
  turn_uuid_start: string | null;
  turn_uuid_end: string | null;
  embedded_model: string | null;
}

interface SemanticRow {
  id: number;
  distance: number;
}

interface FakeDbConfig {
  /** Raw vec-table rows, in the order the (fake) `ORDER BY distance` query
   *  returns them. `store.searchSemantic` assigns rank by position in this list. */
  semantic: SemanticRow[];
  chunks: StoredChunkRow[];
  taskTitles: Record<string, string>;
  sessionTypes: Record<string, string>;
}

function chunkRow(overrides: Partial<StoredChunkRow> & { id: number }): StoredChunkRow {
  return {
    corpus: 'conversation',
    doc_id: `doc-${overrides.id}`,
    seq: 0,
    session_id: `s${overrides.id}`,
    task_id: `t${overrides.id}`,
    agent_session_id: `agent-${overrides.id}`,
    role: 'assistant',
    text: `full chunk text ${overrides.id}`,
    content_hash: `hash-${overrides.id}`,
    token_estimate: 10,
    ts_start: 1717000000000,
    ts_end: 1717000000000,
    turn_uuid_start: `turn-${overrides.id}`,
    turn_uuid_end: `turn-${overrides.id}`,
    embedded_model: null,
    ...overrides,
  };
}

/** A fake better-sqlite3 that routes prepare() by SQL substring. No lexical FTS
 *  rows are ever scripted here (empty MATCH results) - these tests isolate the
 *  semantic-relevance path, which memory-search-degradation.test.ts already
 *  proves never interferes with lexical hits. */
function makeFakeDb(config: FakeDbConfig): Database.Database {
  return {
    prepare(sql: string) {
      return {
        all: (...args: unknown[]) => {
          if (sql.includes('memory_chunks_fts') && sql.includes('MATCH')) {
            return [];
          }
          if (sql.includes('memory_chunks_vec') && sql.includes('MATCH')) {
            return config.semantic;
          }
          if (sql.includes('FROM memory_chunks') && sql.includes('id IN')) {
            const ids = new Set(args as number[]);
            return config.chunks.filter((row) => ids.has(row.id));
          }
          return [];
        },
        get: (...args: unknown[]) => {
          // RetrievalStore's constructor probe: report the vec table as already
          // existing so `vecReady` flips true and `searchSemantic` actually runs
          // its query instead of short-circuiting to [].
          if (sql.includes('sqlite_master')) {
            return { name: 'memory_chunks_vec' };
          }
          if (sql.includes('SELECT title FROM tasks')) {
            const taskId = args[0] as string;
            const title = config.taskTitles[taskId];
            return title === undefined ? undefined : { title };
          }
          if (sql.includes('SELECT session_type FROM sessions')) {
            const sessionId = args[0] as string;
            const sessionType = config.sessionTypes[sessionId];
            return sessionType === undefined ? undefined : { session_type: sessionType };
          }
          return undefined;
        },
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    },
    transaction: (fn: () => unknown) => fn,
  } as unknown as Database.Database;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'project-A',
    name: overrides.name ?? 'Proj A',
    path: overrides.path ?? '/mock/proj-a',
    github_url: overrides.github_url ?? null,
    default_agent: overrides.default_agent ?? 'claude',
    group_id: overrides.group_id ?? null,
    position: overrides.position ?? 0,
    last_opened: overrides.last_opened ?? '2026-05-01T00:00:00Z',
    created_at: overrides.created_at ?? '2026-04-01T00:00:00Z',
  };
}

/** getDb factory that marks every connection it hands out vec-capable, so the
 *  real semantic-fusion path (not just lexical-degradation) exercises here. */
function makeGetDb(config: FakeDbConfig): (projectId: string) => Database.Database {
  return vi.fn(() => {
    const db = makeFakeDb(config);
    markVecCapable(db);
    return db;
  });
}

const PROJECT_A = makeProject({ id: 'project-A', name: 'Proj A' });

describe('searchConversationMemory - calibrated semantic relevance', () => {
  it('drops a below-floor hit and keeps above-floor hits, densely re-ranked (floor 0.6)', async () => {
    // Floor 0.6, cutoff 0.15 => a hit survives when cos >= 0.6 + 0.15*0.4 = 0.66.
    // The vec table's real `ORDER BY distance` returns closest-first (ascending
    // distance), which is the order scripted below.
    // distance 0.05 -> cos 0.99875 -> relevance 0.997 (kept, rank 1)
    // distance 0.3  -> cos 0.955   -> relevance 0.8875 (kept, rank 2)
    // distance 1.4  -> cos 0.02    -> relevance -1.45  (dropped: below the floor)
    const config: FakeDbConfig = {
      semantic: [
        { id: 103, distance: 0.05 },
        { id: 102, distance: 0.3 },
        { id: 101, distance: 1.4 },
      ],
      chunks: [chunkRow({ id: 101 }), chunkRow({ id: 102 }), chunkRow({ id: 103 })],
      taskTitles: { t101: 'Off topic', t102: 'On topic', t103: 'Very on topic' },
      sessionTypes: { s101: 'claude_agent', s102: 'claude_agent', s103: 'claude_agent' },
    };
    const getDb = makeGetDb(config);
    const embedder = new FixedEmbedder(0.6);

    const hits = await searchConversationMemory({
      query: 'gibberish query',
      projects: [PROJECT_A],
      embedder,
      getDb,
    });

    // Chunk 101 (cos 0.02) never appears - its relevance is below the cutoff.
    expect(hits.map((hit) => hit.chunkId)).not.toContain(101);
    expect(hits.map((hit) => hit.chunkId).sort((a, b) => a - b)).toEqual([102, 103]);
    expect(hits.every((hit) => hit.matchKind === 'semantic')).toBe(true);

    // The two survivors keep their relative order (103 was rank 1, 102 was
    // rank 2 before the divergent rank-3 hit was dropped) and are re-ranked
    // densely to (1, 2) before fusion, so RRF score 1/(60+1) for chunk 103
    // outranks chunk 102's 1/(60+2).
    const byId = new Map(hits.map((hit) => [hit.chunkId, hit]));
    expect(byId.get(103)?.score).toBeCloseTo(1 / 61, 12);
    expect(byId.get(102)?.score).toBeCloseTo(1 / 62, 12);
    expect(hits[0].chunkId).toBe(103);
  });

  it('returns [] when every semantic hit is below the floor (the gibberish-query case)', async () => {
    // distance 1.4 -> cos 0.02, far below a 0.6 floor. No lexical hits either
    // (empty query match), so the whole project contributes nothing.
    const config: FakeDbConfig = {
      semantic: [{ id: 101, distance: 1.4 }],
      chunks: [chunkRow({ id: 101 })],
      taskTitles: { t101: 'Off topic' },
      sessionTypes: { s101: 'claude_agent' },
    };
    const getDb = makeGetDb(config);
    const embedder = new FixedEmbedder(0.6);

    const hits = await searchConversationMemory({
      query: 'asdkjhaskjdh nonsense',
      projects: [PROJECT_A],
      embedder,
      getDb,
    });

    expect(hits).toEqual([]);
  });

  it('drops a near-floor hit that a raw cosine threshold would have kept', async () => {
    // distance 0.85 -> cos = 1 - 0.85^2/2 = 1 - 0.36125 = 0.63875. A naive raw
    // 0.5 cosine threshold would KEEP this. Calibrated against the 0.6 floor its
    // relevance is (0.63875 - 0.6)/0.4 = 0.0969, below the 0.15 cutoff -> dropped.
    // This is the anisotropy case: sitting just above the floor is not a match.
    const config: FakeDbConfig = {
      semantic: [{ id: 101, distance: 0.85 }],
      chunks: [chunkRow({ id: 101 })],
      taskTitles: { t101: 'Barely related' },
      sessionTypes: { s101: 'claude_agent' },
    };
    const getDb = makeGetDb(config);
    const embedder = new FixedEmbedder(0.6);

    const hits = await searchConversationMemory({
      query: 'loosely related query',
      projects: [PROJECT_A],
      embedder,
      getDb,
    });

    expect(hits).toEqual([]);
  });

  it('with noiseFloor 0, keeps a low-cosine hit (filter off)', async () => {
    const config: FakeDbConfig = {
      semantic: [{ id: 101, distance: 1.4 }], // cos ~= 0.02
      chunks: [chunkRow({ id: 101 })],
      taskTitles: { t101: 'Off topic' },
      sessionTypes: { s101: 'claude_agent' },
    };
    const getDb = makeGetDb(config);
    const embedder = new FixedEmbedder(0);

    const hits = await searchConversationMemory({
      query: 'gibberish query',
      projects: [PROJECT_A],
      embedder,
      getDb,
    });

    expect(hits.map((hit) => hit.chunkId)).toEqual([101]);
    expect(hits[0].matchKind).toBe('semantic');
  });
});
