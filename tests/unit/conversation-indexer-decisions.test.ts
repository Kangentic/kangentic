import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  ConversationIndexer,
  needsIndex,
  type SourceSignature,
} from '../../src/main/retrieval/conversation/conversation-indexer';
import type { IndexStateRow, ChunkInput } from '../../src/main/retrieval/types';
import type { SessionRecord, TranscriptEntry } from '../../src/shared/types';

/**
 * Two layers here:
 *   1. `needsIndex` is a pure decision - an exhaustive truth table over prior
 *      state x current signature.
 *   2. `ConversationIndexer.indexSession` is exercised against a hand-rolled
 *      fake `Database` (better-sqlite3 cannot load under vitest). The fake
 *      answers the SessionRepository lookup, the RetrievalStore index-state
 *      read/write, and the upsert transaction, so the adapter-capability
 *      branches and the indexed/skipped outcomes are covered without a real DB.
 */

function makeState(overrides: Partial<IndexStateRow> = {}): IndexStateRow {
  return {
    corpus: 'conversation',
    docId: 'session-1',
    sessionId: 'session-1',
    sourcePath: '/history/session-1.jsonl',
    sourceMtimeMs: 1000,
    sourceSize: 500,
    entryCount: 3,
    chunkCount: 2,
    status: 'ok',
    indexedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

function sig(overrides: Partial<SourceSignature> = {}): SourceSignature {
  return { path: '/history/session-1.jsonl', mtimeMs: 1000, size: 500, ...overrides };
}

describe('needsIndex (pure decision table)', () => {
  it('returns true when there is no prior state', () => {
    expect(needsIndex(undefined, sig())).toBe(true);
  });

  it("returns false for terminal 'unsupported' regardless of signature", () => {
    const state = makeState({ status: 'unsupported' });
    expect(needsIndex(state, sig())).toBe(false);
    expect(needsIndex(state, sig({ path: '/totally/different.jsonl' }))).toBe(false);
    expect(needsIndex(state, sig({ mtimeMs: 9999, size: 1 }))).toBe(false);
  });

  it("returns false for an 'ok' state whose signature is unchanged", () => {
    expect(needsIndex(makeState({ status: 'ok' }), sig())).toBe(false);
  });

  it("returns true for an 'ok' state whose path changed", () => {
    expect(needsIndex(makeState({ status: 'ok' }), sig({ path: '/moved.jsonl' }))).toBe(true);
  });

  it("returns true for an 'ok' state whose mtime changed", () => {
    expect(needsIndex(makeState({ status: 'ok' }), sig({ mtimeMs: 2000 }))).toBe(true);
  });

  it("returns true for an 'ok' state whose size changed", () => {
    expect(needsIndex(makeState({ status: 'ok' }), sig({ size: 999 }))).toBe(true);
  });

  it("returns false for a 'missing-source' state whose signature is unchanged", () => {
    // Not terminal, but same signature -> nothing new to index yet.
    expect(needsIndex(makeState({ status: 'missing-source' }), sig())).toBe(false);
  });

  it("returns true for a 'missing-source' state once the signature appears", () => {
    const state = makeState({ status: 'missing-source', sourcePath: null, sourceMtimeMs: null, sourceSize: null });
    expect(needsIndex(state, sig())).toBe(true);
  });

  it("returns false for an 'error' state with the same signature and true when it changes", () => {
    expect(needsIndex(makeState({ status: 'error' }), sig())).toBe(false);
    expect(needsIndex(makeState({ status: 'error' }), sig({ size: 1 }))).toBe(true);
  });
});

// --- indexSession against a fake DB --------------------------------------

interface FakeDbState {
  sessionRecord: SessionRecord | undefined;
  indexStateRows: Map<string, Record<string, unknown>>;
  indexStateWrites: Array<{ status: string; entryCount: number; chunkCount: number; sourcePath: string | null }>;
  chunkInserts: unknown[][];
  nextRowId: number;
}

function makeFakeState(record: SessionRecord | undefined): FakeDbState {
  return {
    sessionRecord: record,
    indexStateRows: new Map(),
    indexStateWrites: [],
    chunkInserts: [],
    nextRowId: 100,
  };
}

function makeFakeDb(state: FakeDbState): Database.Database {
  return {
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          if (sql.includes('FROM sessions WHERE id = ?')) return state.sessionRecord;
          if (sql.includes('FROM memory_index_state WHERE corpus')) {
            const [corpus, docId] = args as [string, string];
            return state.indexStateRows.get(`${corpus}::${docId}`);
          }
          throw new Error(`unexpected get SQL: ${sql}`);
        },
        all: (..._args: unknown[]) => {
          // upsertDocument's existing-chunk probe: no prior chunks.
          if (sql.includes('FROM memory_chunks') && sql.includes('content_hash')) return [];
          throw new Error(`unexpected all SQL: ${sql}`);
        },
        run: (...args: unknown[]) => {
          if (sql.includes('INSERT INTO memory_index_state')) {
            const [corpus, docId, sessionId, sourcePath, sourceMtimeMs, sourceSize, entryCount, chunkCount, status, indexedAt] = args;
            state.indexStateRows.set(`${String(corpus)}::${String(docId)}`, {
              corpus,
              doc_id: docId,
              session_id: sessionId,
              source_path: sourcePath,
              source_mtime_ms: sourceMtimeMs,
              source_size: sourceSize,
              entry_count: entryCount,
              chunk_count: chunkCount,
              status,
              indexed_at: indexedAt,
            });
            state.indexStateWrites.push({
              status: String(status),
              entryCount: Number(entryCount),
              chunkCount: Number(chunkCount),
              sourcePath: (sourcePath as string | null) ?? null,
            });
            return { changes: 1, lastInsertRowid: 0 };
          }
          if (sql.includes('INSERT INTO memory_chunks')) {
            state.chunkInserts.push(args);
            return { changes: 1, lastInsertRowid: state.nextRowId++ };
          }
          if (sql.includes('DELETE FROM memory_chunks WHERE id IN')) return { changes: 0 };
          throw new Error(`unexpected run SQL: ${sql}`);
        },
      };
    },
    // better-sqlite3 transaction(fn) returns a callable that runs fn and
    // returns its value; the fake collapses to calling fn directly.
    transaction: (fn: () => unknown) => fn,
  } as unknown as Database.Database;
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    task_id: 'task-1',
    session_type: 'claude_agent',
    agent_session_id: 'agent-abc',
    cwd: '/work/project',
    ...overrides,
  } as unknown as SessionRecord;
}

const fixedNow = '2026-06-01T12:00:00Z';
const oneChunk: ChunkInput[] = [
  {
    seq: 0,
    text: 'User: hi',
    contentHash: 'hash-0',
    tokenEstimate: 2,
    role: 'user',
    tsStart: 10,
    tsEnd: 10,
    turnUuidStart: 'u1',
    turnUuidEnd: 'u1',
  },
];

describe('ConversationIndexer.indexSession', () => {
  it("returns 'skipped' when the session record is not found", async () => {
    const state = makeFakeState(undefined);
    const indexer = new ConversationIndexer({
      getDb: () => makeFakeDb(state),
      getAdapter: () => ({ displayName: 'Claude', parseTranscript: vi.fn() }),
      stat: () => null,
      now: () => fixedNow,
      chunker: () => oneChunk,
      chunkerVersion: 1,
    });
    expect(await indexer.indexSession('project-1', 'nope')).toBe('skipped');
  });

  it("returns 'error' when the DB factory throws", async () => {
    const indexer = new ConversationIndexer({
      getDb: () => { throw new Error('db unavailable'); },
      getAdapter: () => ({ displayName: 'Claude', parseTranscript: vi.fn() }),
      stat: () => null,
      now: () => fixedNow,
      chunker: () => oneChunk,
      chunkerVersion: 1,
    });
    expect(await indexer.indexSession('project-1', 'session-1')).toBe('error');
  });

  it("returns 'unsupported' and records an unsupported index_state for a raw-only agent", async () => {
    const state = makeFakeState(makeRecord({ session_type: 'raw_agent' }));
    const indexer = new ConversationIndexer({
      getDb: () => makeFakeDb(state),
      // Adapter has NO parseTranscript -> raw-only.
      getAdapter: () => ({ displayName: 'Raw Agent' }),
      stat: () => null,
      now: () => fixedNow,
      chunker: () => oneChunk,
      chunkerVersion: 1,
    });

    const outcome = await indexer.indexSession('project-1', 'session-1');

    expect(outcome).toBe('unsupported');
    expect(state.indexStateWrites).toEqual([
      { status: 'unsupported', entryCount: 0, chunkCount: 0, sourcePath: null },
    ]);
    // No chunks were written for an unsupported agent.
    expect(state.chunkInserts).toHaveLength(0);
  });

  it("returns 'missing-source' when the adapter parses but agent_session_id is null", async () => {
    const state = makeFakeState(makeRecord({ agent_session_id: null }));
    const parseTranscript = vi.fn();
    const indexer = new ConversationIndexer({
      getDb: () => makeFakeDb(state),
      getAdapter: () => ({ displayName: 'Claude', parseTranscript }),
      stat: () => null,
      now: () => fixedNow,
      chunker: () => oneChunk,
      chunkerVersion: 1,
    });

    const outcome = await indexer.indexSession('project-1', 'session-1');

    expect(outcome).toBe('missing-source');
    expect(state.indexStateWrites).toEqual([
      { status: 'missing-source', entryCount: 0, chunkCount: 0, sourcePath: null },
    ]);
    // The parser must not run when there is no native history to point it at.
    expect(parseTranscript).not.toHaveBeenCalled();
  });

  it("returns 'indexed', upserts chunks, and writes an 'ok' state when parse yields entries", async () => {
    const state = makeFakeState(makeRecord());
    const entries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 10, text: 'hi' },
      { kind: 'assistant', uuid: 'a1', ts: 20, blocks: [{ type: 'text', text: 'hello' }] },
    ];
    const parseTranscript = vi.fn(async () => ({ entries, sourcePath: null }));
    const chunker = vi.fn(() => oneChunk);
    const indexer = new ConversationIndexer({
      getDb: () => makeFakeDb(state),
      getAdapter: () => ({ displayName: 'Claude', parseTranscript }),
      stat: () => null,
      now: () => fixedNow,
      chunker,
      chunkerVersion: 1,
    });

    const outcome = await indexer.indexSession('project-1', 'session-1');

    expect(outcome).toBe('indexed');
    expect(parseTranscript).toHaveBeenCalledWith('agent-abc', '/work/project');
    expect(chunker).toHaveBeenCalledWith(entries);
    // One chunk inserted into memory_chunks.
    expect(state.chunkInserts).toHaveLength(1);
    // The document is keyed on the agent transcript (agent_session_id), NOT the
    // Kangentic session id: suspend/resume mints a new session row resuming the
    // same agent_session_id, and keying on it dedups to one doc instead of a
    // duplicate search hit. INSERT columns: (corpus, doc_id, seq, session_id, ...).
    expect(state.chunkInserts[0][1]).toBe('agent-abc'); // doc_id = agent_session_id
    expect(state.chunkInserts[0][3]).toBe('session-1'); // session_id = Kangentic session id
    // Final state write is 'ok' with the real entry/chunk counts.
    expect(state.indexStateWrites.at(-1)).toEqual({
      status: 'ok',
      entryCount: 2,
      chunkCount: 1,
      sourcePath: null,
    });
  });

  it("returns 'missing-source' when the parser yields zero entries", async () => {
    const state = makeFakeState(makeRecord());
    const parseTranscript = vi.fn(async () => ({ entries: [], sourcePath: '/history/session-1.jsonl' }));
    const indexer = new ConversationIndexer({
      getDb: () => makeFakeDb(state),
      getAdapter: () => ({ displayName: 'Claude', parseTranscript }),
      stat: () => null,
      now: () => fixedNow,
      chunker: () => oneChunk,
      chunkerVersion: 1,
    });

    const outcome = await indexer.indexSession('project-1', 'session-1');

    expect(outcome).toBe('missing-source');
    expect(state.chunkInserts).toHaveLength(0);
    expect(state.indexStateWrites.at(-1)?.status).toBe('missing-source');
    // The parsed sourcePath is threaded into the recorded state.
    expect(state.indexStateWrites.at(-1)?.sourcePath).toBe('/history/session-1.jsonl');
  });

  it("returns 'error' and records an error state when the parser throws", async () => {
    const state = makeFakeState(makeRecord());
    const parseTranscript = vi.fn(async () => { throw new Error('parse boom'); });
    const indexer = new ConversationIndexer({
      getDb: () => makeFakeDb(state),
      getAdapter: () => ({ displayName: 'Claude', parseTranscript }),
      stat: () => null,
      now: () => fixedNow,
      chunker: () => oneChunk,
      chunkerVersion: 1,
    });

    const outcome = await indexer.indexSession('project-1', 'session-1');

    expect(outcome).toBe('error');
    expect(state.indexStateWrites.at(-1)?.status).toBe('error');
    expect(state.chunkInserts).toHaveLength(0);
  });

  it("returns 'skipped' on a re-run when the source signature is unchanged", async () => {
    const state = makeFakeState(makeRecord());
    const entries: TranscriptEntry[] = [{ kind: 'user', uuid: 'u1', ts: 10, text: 'hi' }];
    const parseTranscript = vi.fn(async () => ({ entries, sourcePath: null }));
    const sharedDb = makeFakeDb(state);
    const indexer = new ConversationIndexer({
      getDb: () => sharedDb,
      getAdapter: () => ({ displayName: 'Claude', parseTranscript }),
      // No locateSessionHistoryFile => signature is all-null both runs, so the
      // second run sees an unchanged signature.
      stat: () => null,
      now: () => fixedNow,
      chunker: () => oneChunk,
      chunkerVersion: 1,
    });

    expect(await indexer.indexSession('project-1', 'session-1')).toBe('indexed');
    // Second pass: state exists, signature unchanged -> skip before parsing.
    expect(await indexer.indexSession('project-1', 'session-1')).toBe('skipped');
    expect(parseTranscript).toHaveBeenCalledOnce();
    expect(state.chunkInserts).toHaveLength(1);
  });
});
