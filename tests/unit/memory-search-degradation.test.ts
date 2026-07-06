import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Project } from '../../src/shared/types';
import type { Embedder } from '../../src/main/retrieval/types';

/**
 * searchConversationMemory degradation contract.
 *
 * The engine must NEVER throw for an empty/absent index and must ALWAYS degrade
 * to lexical-only when the semantic layer is missing, disabled, slow, or errors.
 * These tests script a fake per-project DB (better-sqlite3 cannot load under
 * vitest) so the FTS -> fusion -> hydrate pipeline runs end to end, and drive a
 * DeterministicFakeEmbedder through its unavailable / null / slow / throwing /
 * working modes.
 *
 * Note on semantic fusion: `store.searchSemantic` returns [] unless the store's
 * connection is marked vec-capable (a WeakSet in vec-support), and a fake DB is
 * never marked. So a working embedder embeds the query but the vec list is
 * structurally empty here - the true semantic-fusion path needs a live
 * sqlite-vec DB and is asserted at the E2E tier. The fusion arithmetic itself is
 * covered by retrieval-fusion.test.ts. What we assert here is that supplying an
 * embedder never breaks or alters the lexical results (transparent degradation)
 * and that the query embedding is requested exactly once with the caller's
 * embedWaitMs budget.
 */

// better-sqlite3 loads at value level inside db/database; stub it so importing
// memory-search does not drag the native binding in. getDb is always injected,
// so this is never actually called.
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => {
    throw new Error('getProjectDb should not be called - getDb is injected in tests');
  }),
}));

// Keep agent-name resolution deterministic and hermetic (no adapter graph):
// getBySessionType returns undefined, so agentDisplayName echoes the raw
// session_type value.
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: () => undefined },
}));

import { searchConversationMemory } from '../../src/main/retrieval/memory-search';

// --- Deterministic fake embedder -------------------------------------------

type EmbedderMode = 'ok' | 'null' | 'slow' | 'throw';

class DeterministicFakeEmbedder implements Embedder {
  readonly dimensions: number;
  readonly modelTag = 'fake-embedder@test';
  // 0 disables the relevance filter, so these degradation tests assert purely on
  // the embedder's ok/null/slow/throw behavior, not on cosine calibration.
  readonly noiseFloor = 0;
  readonly embedCalls: Array<{ texts: string[]; opts?: { timeoutMs?: number } }> = [];

  constructor(
    private readonly mode: EmbedderMode,
    dimensions = 384,
    /** For 'slow': the fake's latency. Returns null when it exceeds the budget. */
    private readonly latencyMs = 60_000,
  ) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[], opts?: { timeoutMs?: number }): Promise<Float32Array[] | null> {
    this.embedCalls.push({ texts, opts });
    if (this.mode === 'throw') throw new Error('embedder boom');
    if (this.mode === 'null') return null;
    if (this.mode === 'slow') {
      const budget = opts?.timeoutMs ?? Number.POSITIVE_INFINITY;
      // Models an embedder that self-times-out when slower than the budget.
      return this.latencyMs > budget ? null : texts.map((text) => this.hashVector(text));
    }
    return texts.map((text) => this.hashVector(text));
  }

  /** Stable hash-of-text -> Float32Array of the configured dimension. */
  private hashVector(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    for (let index = 0; index < this.dimensions; index++) {
      hash ^= hash << 13;
      hash ^= hash >>> 17;
      hash ^= hash << 5;
      vector[index] = ((hash >>> 0) % 1000) / 1000;
    }
    return vector;
  }
}

// --- Fake scripted DB -------------------------------------------------------

interface LexicalRow {
  id: number;
  snip: string;
  score: number;
}

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

interface FakeDbConfig {
  lexical: LexicalRow[];
  chunks: StoredChunkRow[];
  taskTitles: Record<string, string>;
  sessionTypes: Record<string, string>;
}

function chunkRow(overrides: Partial<StoredChunkRow> & { id: number }): StoredChunkRow {
  return {
    corpus: 'conversation',
    doc_id: 'session-1',
    seq: overrides.id,
    session_id: 's1',
    task_id: 't1',
    agent_session_id: 'agent-1',
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

/** A fake better-sqlite3 that routes prepare() by SQL substring. */
function makeFakeDb(config: FakeDbConfig): Database.Database {
  return {
    prepare(sql: string) {
      return {
        all: (...args: unknown[]) => {
          // searchLexical: the FTS MATCH query.
          if (sql.includes('memory_chunks_fts') && sql.includes('MATCH')) {
            return config.lexical;
          }
          // searchSemantic never reaches here (vec is not marked capable).
          if (sql.includes('memory_chunks_vec')) return [];
          // getChunks: SELECT * FROM memory_chunks WHERE id IN (?, ?, ...)
          if (sql.includes('FROM memory_chunks') && sql.includes('id IN')) {
            const ids = new Set(args as number[]);
            return config.chunks.filter((row) => ids.has(row.id));
          }
          return [];
        },
        get: (...args: unknown[]) => {
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

/** getDb factory keyed by project id, so cross-project merges can be scripted. */
function makeGetDb(byProject: Record<string, FakeDbConfig>): (projectId: string) => Database.Database {
  return vi.fn((projectId: string) => {
    const config = byProject[projectId];
    if (!config) throw new Error(`no fake DB scripted for project "${projectId}"`);
    return makeFakeDb(config);
  });
}

// Two lexical hits (ranks 1, 2) for a single project, in DISTINCT sessions so
// per-session collapsing keeps both. Fusion scores them 1/61 and 1/62, so chunk 5
// sorts ahead of chunk 6.
function singleProjectConfig(): FakeDbConfig {
  return {
    lexical: [
      { id: 5, snip: 'the false idle bug fix', score: -3.2 },
      { id: 6, snip: 'another idle mention', score: -1.1 },
    ],
    chunks: [chunkRow({ id: 5 }), chunkRow({ id: 6, session_id: 's2' })],
    taskTitles: { t1: 'Fix false idle' },
    sessionTypes: { s1: 'claude_agent', s2: 'claude_agent' },
  };
}

const PROJECT_A = makeProject({ id: 'project-A', name: 'Proj A' });

describe('searchConversationMemory - lexical-only degradation', () => {
  it('with NO embedder, returns lexical hits from the scripted FTS rows', async () => {
    const getDb = makeGetDb({ 'project-A': singleProjectConfig() });

    const hits = await searchConversationMemory({
      query: 'idle bug',
      projects: [PROJECT_A],
      getDb,
    });

    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.chunkId)).toEqual([5, 6]);
    expect(hits[0].matchKind).toBe('lexical');
    expect(hits[0].snippet).toBe('the false idle bug fix');
    expect(hits[0].taskTitle).toBe('Fix false idle');
    expect(hits[0].agentName).toBe('claude_agent');
    expect(hits[0].sessionId).toBe('s1');
    expect(hits[0].turnUuid).toBe('turn-5');
    expect(hits[0].projectName).toBe('Proj A');
    expect(hits[0].score).toBeCloseTo(1 / 61, 12);
    // 'idle' (first query token) is highlighted inside the lexical snippet.
    expect(hits[0].matchStart).toBeGreaterThanOrEqual(0);
    expect(hits[0].snippet.slice(hits[0].matchStart, hits[0].matchEnd)).toBe('idle');
  });

  it('with an embedder that resolves null, degrades to lexical-only without throwing', async () => {
    const getDb = makeGetDb({ 'project-A': singleProjectConfig() });
    const embedder = new DeterministicFakeEmbedder('null');

    const hits = await searchConversationMemory({
      query: 'idle bug',
      projects: [PROJECT_A],
      embedder,
      embedWaitMs: 250,
      getDb,
    });

    expect(hits.map((hit) => hit.chunkId)).toEqual([5, 6]);
    expect(hits.every((hit) => hit.matchKind === 'lexical')).toBe(true);
    // The query was embedded once, with the caller's embedWaitMs budget.
    expect(embedder.embedCalls).toHaveLength(1);
    expect(embedder.embedCalls[0].texts).toEqual(['idle bug']);
    expect(embedder.embedCalls[0].opts?.timeoutMs).toBe(250);
  });

  it('with a slow embedder that exceeds embedWaitMs, degrades to lexical-only', async () => {
    const getDb = makeGetDb({ 'project-A': singleProjectConfig() });
    const embedder = new DeterministicFakeEmbedder('slow', 384, 60_000);

    const hits = await searchConversationMemory({
      query: 'idle bug',
      projects: [PROJECT_A],
      embedder,
      embedWaitMs: 100,
      getDb,
    });

    expect(hits.map((hit) => hit.chunkId)).toEqual([5, 6]);
    expect(embedder.embedCalls[0].opts?.timeoutMs).toBe(100);
  });

  it('with an embedder that throws, catches and degrades to lexical-only', async () => {
    const getDb = makeGetDb({ 'project-A': singleProjectConfig() });
    const embedder = new DeterministicFakeEmbedder('throw');

    const hits = await searchConversationMemory({
      query: 'idle bug',
      projects: [PROJECT_A],
      embedder,
      getDb,
    });

    expect(hits.map((hit) => hit.chunkId)).toEqual([5, 6]);
    expect(embedder.embedCalls).toHaveLength(1);
  });

  it('with a working embedder, embeds the query but the lexical results are unchanged (vec-fusion is E2E-only)', async () => {
    const getDb = makeGetDb({ 'project-A': singleProjectConfig() });
    const embedder = new DeterministicFakeEmbedder('ok');

    const hits = await searchConversationMemory({
      query: 'idle bug',
      projects: [PROJECT_A],
      embedder,
      embedWaitMs: 5000,
      getDb,
    });

    // The query was embedded exactly once.
    expect(embedder.embedCalls).toHaveLength(1);
    expect(embedder.embedCalls[0].texts).toEqual(['idle bug']);
    // No semantic rows (fake DB is not vec-capable), so the fused result is the
    // lexical list, identical to the no-embedder case: supplying an embedder
    // never breaks the lexical path.
    expect(hits.map((hit) => hit.chunkId)).toEqual([5, 6]);
    expect(hits.every((hit) => hit.matchKind === 'lexical')).toBe(true);
  });
});

describe('searchConversationMemory - bounds and empties', () => {
  it('returns [] for an empty/whitespace query without touching the DB', async () => {
    const getDb = makeGetDb({ 'project-A': singleProjectConfig() });

    const hits = await searchConversationMemory({
      query: '   ',
      projects: [PROJECT_A],
      getDb,
    });

    expect(hits).toEqual([]);
    expect(getDb).not.toHaveBeenCalled();
  });

  it('honors k by cutting the merged, score-sorted list', async () => {
    const getDb = makeGetDb({ 'project-A': singleProjectConfig() });

    const hits = await searchConversationMemory({
      query: 'idle bug',
      projects: [PROJECT_A],
      k: 1,
      getDb,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].chunkId).toBe(5);
  });

  it('skips a project whose DB factory throws and still returns other projects', async () => {
    const getDb = vi.fn((projectId: string) => {
      if (projectId === 'project-broken') throw new Error('db open failed');
      return makeFakeDb(singleProjectConfig());
    });
    const broken = makeProject({ id: 'project-broken', name: 'Broken' });

    const hits = await searchConversationMemory({
      query: 'idle bug',
      projects: [broken, PROJECT_A],
      getDb,
    });

    // Only the healthy project contributed hits; no throw.
    expect(hits.map((hit) => hit.chunkId)).toEqual([5, 6]);
    expect(hits.every((hit) => hit.projectId === 'project-A')).toBe(true);
  });

  it('merges hits across projects and sorts by fused score', async () => {
    const projectB = makeProject({ id: 'project-B', name: 'Proj B' });
    const configB: FakeDbConfig = {
      // A single rank-1 lexical hit (score 1/61), tying project A's chunk 5.
      lexical: [{ id: 9, snip: 'idle in project B', score: -2.0 }],
      chunks: [chunkRow({ id: 9, session_id: 's9', task_id: 't9', turn_uuid_start: 'turn-9' })],
      taskTitles: { t9: 'Project B task' },
      sessionTypes: { s9: 'codex' },
    };
    const getDb = makeGetDb({ 'project-A': singleProjectConfig(), 'project-B': configB });

    const hits = await searchConversationMemory({
      query: 'idle bug',
      projects: [PROJECT_A, projectB],
      getDb,
    });

    // Three hits across two projects: chunk 5 (1/61) and chunk 9 (1/61) tie at
    // the top, chunk 6 (1/62) last.
    expect(hits).toHaveLength(3);
    expect(hits.map((hit) => hit.chunkId).sort((a, b) => a - b)).toEqual([5, 6, 9]);
    expect(hits[hits.length - 1].chunkId).toBe(6);
    expect(hits.some((hit) => hit.projectId === 'project-B' && hit.chunkId === 9)).toBe(true);
  });

  it('collapses same-session chunks to the best-scoring hit with a matchCount', async () => {
    const config: FakeDbConfig = {
      lexical: [
        { id: 5, snip: 'first venus mention', score: -3.2 },
        { id: 6, snip: 'second venus mention', score: -1.1 },
      ],
      // Both chunks belong to the same session s1 (default), so they collapse.
      chunks: [chunkRow({ id: 5 }), chunkRow({ id: 6 })],
      taskTitles: { t1: 'Planets' },
      sessionTypes: { s1: 'claude_agent' },
    };
    const getDb = makeGetDb({ 'project-A': config });

    const hits = await searchConversationMemory({ query: 'venus', projects: [PROJECT_A], getDb });

    // One row for the conversation - the best-scoring chunk (5) - carrying the
    // total match count, rather than two near-duplicate rows.
    expect(hits).toHaveLength(1);
    expect(hits[0].chunkId).toBe(5);
    expect(hits[0].sessionId).toBe('s1');
    expect(hits[0].matchCount).toBe(2);
  });
});
