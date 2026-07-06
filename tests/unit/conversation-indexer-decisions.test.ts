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

// --- Suspend/resume: two Kangentic session rows share one agent transcript --

/**
 * `makeFakeDb` above always answers the memory_chunks existing-chunk probe
 * with an empty array (no session in that suite ever calls indexSession
 * twice against overlapping content), so it cannot reproduce the ownership
 * re-point bug: it never lets a second `indexSession` pass see the chunk row
 * the first pass just wrote. This fake keeps a real in-memory
 * `memory_chunks` table (shared across multiple `indexSession` calls) and
 * multiple session rows keyed by their own id, so the test can drive the
 * sweep's actual DESC (newest-first) visit order across two Kangentic
 * session rows that resume the SAME agent_session_id, and observe which
 * session ends up owning the resulting chunk.
 */
interface SharedFakeChunkRow {
  id: number;
  corpus: string;
  docId: string;
  seq: number;
  sessionId: string | null;
  taskId: string | null;
  contentHash: string;
}

interface SharedFakeDbState {
  sessionsById: Map<string, SessionRecord>;
  indexStateRows: Map<string, Record<string, unknown>>;
  chunks: SharedFakeChunkRow[];
  nextChunkId: number;
}

function makeSharedFakeState(records: SessionRecord[]): SharedFakeDbState {
  const sessionsById = new Map<string, SessionRecord>();
  for (const record of records) sessionsById.set(record.id, record);
  return { sessionsById, indexStateRows: new Map(), chunks: [], nextChunkId: 1 };
}

function makeSharedFakeDb(state: SharedFakeDbState): Database.Database {
  return {
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          if (sql.includes('FROM sessions WHERE id = ?')) {
            // Mirrors SessionRepository.findByAnyId: WHERE id = ? OR
            // agent_session_id = ?, newest started_at first.
            const [lookupId] = args as [string];
            const matches = [...state.sessionsById.values()].filter(
              (record) => record.id === lookupId || record.agent_session_id === lookupId,
            );
            matches.sort((first, second) => second.started_at.localeCompare(first.started_at));
            return matches[0];
          }
          if (sql.includes('FROM memory_index_state WHERE corpus')) {
            const [corpus, docId] = args as [string, string];
            return state.indexStateRows.get(`${corpus}::${docId}`);
          }
          throw new Error(`unexpected get SQL: ${sql}`);
        },
        all: (...args: unknown[]) => {
          if (sql.includes('SELECT id, seq, content_hash FROM memory_chunks')) {
            const [corpus, docId] = args as [string, string];
            return state.chunks
              .filter((chunk) => chunk.corpus === corpus && chunk.docId === docId)
              .sort((first, second) => first.seq - second.seq)
              .map((chunk) => ({ id: chunk.id, seq: chunk.seq, content_hash: chunk.contentHash }));
          }
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
            return { changes: 1, lastInsertRowid: 0 };
          }
          if (sql.includes('INSERT INTO memory_chunks')) {
            // Column order matches RetrievalStore.upsertDocument's insert:
            // (corpus, doc_id, seq, session_id, task_id, agent_session_id,
            //  role, text, content_hash, ...).
            const corpus = String(args[0]);
            const docId = String(args[1]);
            const seq = Number(args[2]);
            const sessionId = (args[3] as string | null) ?? null;
            const taskId = (args[4] as string | null) ?? null;
            const contentHash = String(args[8]);
            const id = state.nextChunkId++;
            state.chunks.push({ id, corpus, docId, seq, sessionId, taskId, contentHash });
            return { changes: 1, lastInsertRowid: id };
          }
          if (sql.includes('DELETE FROM memory_chunks WHERE id IN')) {
            const deletedIds = new Set(args.map((value) => Number(value)));
            const remaining = state.chunks.filter((chunk) => !deletedIds.has(chunk.id));
            const removedCount = state.chunks.length - remaining.length;
            state.chunks = remaining;
            return { changes: removedCount };
          }
          if (sql.includes('UPDATE memory_chunks SET session_id')) {
            // The diff-upsert's ownership re-point over the untouched leading
            // prefix: WHERE corpus = ? AND doc_id = ? AND seq < ?.
            const [sessionId, taskId, corpus, docId, divergence] = args as [
              string | null,
              string | null,
              string,
              string,
              number,
            ];
            for (const chunk of state.chunks) {
              if (chunk.corpus === corpus && chunk.docId === docId && chunk.seq < divergence) {
                chunk.sessionId = sessionId;
                chunk.taskId = taskId;
              }
            }
            return { changes: 0 };
          }
          throw new Error(`unexpected run SQL: ${sql}`);
        },
      };
    },
    transaction: (fn: () => unknown) => fn,
  } as unknown as Database.Database;
}

describe('ConversationIndexer.indexSession - suspend/resume shares one agent transcript (regression #2)', () => {
  it(
    'keys index-state on agent_session_id, so a sweep visiting the newest ' +
      'session first leaves chunk ownership on the newest session and no-ops the older one',
    async () => {
      const sharedAgentSessionId = 'agent-xyz';
      // Same agent_session_id (same native history file), distinct Kangentic
      // session rows: the suspended session and the resumed session that
      // replaced it.
      const sessionOlder = makeRecord({
        id: 'session-suspended',
        agent_session_id: sharedAgentSessionId,
        started_at: '2026-06-01T10:00:00Z',
      });
      const sessionNewer = makeRecord({
        id: 'session-resumed',
        agent_session_id: sharedAgentSessionId,
        started_at: '2026-06-01T11:00:00Z',
      });

      const state = makeSharedFakeState([sessionOlder, sessionNewer]);
      const entries: TranscriptEntry[] = [{ kind: 'user', uuid: 'u1', ts: 10, text: 'hi' }];
      // Both rows resume the SAME native history file, so the adapter parses
      // to identical entries (and the chunker produces an identical content
      // hash) regardless of which session row asks for it.
      const parseTranscript = vi.fn(async () => ({ entries, sourcePath: null }));
      const sharedDb = makeSharedFakeDb(state);
      const indexer = new ConversationIndexer({
        getDb: () => sharedDb,
        getAdapter: () => ({ displayName: 'Claude', parseTranscript }),
        stat: () => null,
        now: () => fixedNow,
        chunker: () => oneChunk,
        chunkerVersion: 1,
      });

      // sweepProject visits `ORDER BY started_at DESC`: newest session first,
      // then the older suspended one.
      const outcomeForNewer = await indexer.indexSession('project-1', sessionNewer.id);
      const outcomeForOlder = await indexer.indexSession('project-1', sessionOlder.id);

      expect(outcomeForNewer).toBe('indexed');
      // The older session's pass must be a no-op: by the time it runs, the
      // shared doc's index-state already reflects an unchanged signature.
      expect(outcomeForOlder).toBe('skipped');

      // Exactly one chunk backs the shared transcript, owned by the NEWEST
      // (live/resumed) session, never re-pointed onto the stale suspended one.
      expect(state.chunks).toHaveLength(1);
      expect(state.chunks[0].docId).toBe(sharedAgentSessionId);
      expect(state.chunks[0].sessionId).toBe(sessionNewer.id);

      // Exactly one index-state row backs the shared doc, not one per
      // Kangentic session row.
      expect(state.indexStateRows.size).toBe(1);
      expect(state.indexStateRows.has(`conversation::${sharedAgentSessionId}`)).toBe(true);

      // The parser only ran once: the second pass skipped before parsing.
      expect(parseTranscript).toHaveBeenCalledOnce();
    },
  );
});
