import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { agentRegistry } from '../../agent/agent-registry';
import type { ParsedTranscript } from '../../agent/agent-adapter';
import type { SessionRecord, TranscriptEntry } from '../../../shared/types';
import { RetrievalStore } from '../retrieval-store';
import type { ChunkInput, IndexStateRow } from '../types';
import { chunkTranscript, CHUNKER_VERSION } from './transcript-chunker';
import { ConversationUsageStore, extractTurnUsageRecords } from './conversation-usage-store';

const CORPUS = 'conversation';
const CHUNKER_VERSION_KEY = 'chunker_version';
/** Max sessions actually (re)indexed per backfill sweep, so a large history's
 *  cost amortizes across project opens instead of one long CPU burst. */
const MAX_SESSIONS_PER_SWEEP = 25;

/** Cheap staleness signature: the source file's path/mtime/size, without
 *  parsing it. */
export interface SourceSignature {
  path: string | null;
  mtimeMs: number | null;
  size: number | null;
}

export type IndexOutcome = 'indexed' | 'skipped' | 'unsupported' | 'missing-source' | 'error';

function signatureChanged(state: IndexStateRow, signature: SourceSignature): boolean {
  return (
    state.sourcePath !== signature.path ||
    state.sourceMtimeMs !== signature.mtimeMs ||
    state.sourceSize !== signature.size
  );
}

/** Pure decision: does this session need (re)indexing given its prior state and
 *  current source signature? 'unsupported' is terminal (raw-only agents). */
export function needsIndex(state: IndexStateRow | undefined, signature: SourceSignature): boolean {
  if (!state) return true;
  if (state.status === 'unsupported') return false;
  return signatureChanged(state, signature);
}

interface AdapterLike {
  displayName: string;
  parseTranscript?: (agentSessionId: string, cwd: string) => Promise<ParsedTranscript>;
  locateSessionHistoryFile?: (agentSessionId: string, cwd: string) => Promise<string | null>;
}

export interface ConversationIndexerDeps {
  getDb: (projectId: string) => Database.Database;
  getAdapter: (sessionType: string) => AdapterLike | undefined;
  /** fs.stat wrapper returning null when the path is absent/unreadable. */
  stat: (filePath: string) => { mtimeMs: number; size: number } | null;
  now: () => string;
  chunker: (entries: TranscriptEntry[]) => ChunkInput[];
  chunkerVersion: number;
}

function defaultStat(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const stats = fs.statSync(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

const defaultDeps: ConversationIndexerDeps = {
  getDb: getProjectDb,
  getAdapter: (sessionType) => agentRegistry.getBySessionType(sessionType) as AdapterLike | undefined,
  stat: defaultStat,
  now: () => new Date().toISOString(),
  chunker: chunkTranscript,
  chunkerVersion: CHUNKER_VERSION,
};

/**
 * Indexes structured conversation transcripts into the per-project retrieval
 * store. Fed live from session finalize hooks (one session at a time) and by a
 * backfill sweep at project open. Never throws to its callers; a failed session
 * is recorded and retried on a future signature change.
 */
export class ConversationIndexer {
  private readonly deps: ConversationIndexerDeps;

  constructor(deps?: Partial<ConversationIndexerDeps>) {
    this.deps = { ...defaultDeps, ...deps };
  }

  /** Compute the source-file signature for staleness comparison. */
  private async sourceSignature(adapter: AdapterLike, record: SessionRecord): Promise<SourceSignature> {
    if (!adapter.locateSessionHistoryFile || !record.agent_session_id) {
      return { path: null, mtimeMs: null, size: null };
    }
    let path: string | null = null;
    try {
      path = await adapter.locateSessionHistoryFile(record.agent_session_id, record.cwd);
    } catch {
      path = null;
    }
    if (!path) return { path: null, mtimeMs: null, size: null };
    const stats = this.deps.stat(path);
    return stats ? { path, mtimeMs: stats.mtimeMs, size: stats.size } : { path, mtimeMs: null, size: null };
  }

  private writeState(
    store: RetrievalStore,
    record: SessionRecord,
    signature: SourceSignature,
    status: IndexStateRow['status'],
    entryCount: number,
    chunkCount: number,
  ): void {
    store.setIndexState({
      corpus: CORPUS,
      // The index-state document identity MUST match the chunk document identity
      // (agent_session_id), not the Kangentic session id. Suspend/resume mints a
      // new session row over the SAME agent transcript; keying state on record.id
      // would track it as a separate never-indexed document, and a first backfill
      // sweep (DESC by started_at) would re-index the older session second and
      // re-point chunk ownership back onto the stale suspended session. The
      // sessionId column below stays record.id so the session-delete trigger and
      // the ownership re-point track the live session.
      docId: record.agent_session_id ?? record.id,
      sessionId: record.id,
      sourcePath: signature.path,
      sourceMtimeMs: signature.mtimeMs,
      sourceSize: signature.size,
      entryCount,
      chunkCount,
      status,
      indexedAt: this.deps.now(),
    });
  }

  /** Index one session by id. Idempotent; safe to call on every finalize. */
  async indexSession(projectId: string, sessionId: string): Promise<IndexOutcome> {
    let db: Database.Database;
    try {
      db = this.deps.getDb(projectId);
    } catch {
      return 'error';
    }
    const store = new RetrievalStore(db);
    const record = new SessionRepository(db).findByAnyId(sessionId);
    if (!record) return 'skipped';

    const adapter = this.deps.getAdapter(record.session_type);

    // Raw-only agent: no structured parser. Terminal 'unsupported'.
    if (!adapter?.parseTranscript) {
      this.writeState(store, record, { path: null, mtimeMs: null, size: null }, 'unsupported', 0, 0);
      return 'unsupported';
    }
    // Native history not written yet (no agent_session_id): retried on a later open.
    if (!record.agent_session_id) {
      this.writeState(store, record, { path: null, mtimeMs: null, size: null }, 'missing-source', 0, 0);
      return 'missing-source';
    }

    const signature = await this.sourceSignature(adapter, record);
    // Key on the agent transcript (agent_session_id), consistent with the chunk
    // document identity, so a resumed session's new row shares one index-state
    // row with its prior sessions instead of being treated as never-indexed.
    const state = store.getIndexState(CORPUS, record.agent_session_id ?? record.id);
    if (!needsIndex(state, signature)) return 'skipped';

    let parsed: ParsedTranscript;
    try {
      parsed = await adapter.parseTranscript(record.agent_session_id, record.cwd);
    } catch {
      this.writeState(store, record, signature, 'error', 0, 0);
      return 'error';
    }
    if (parsed.entries.length === 0) {
      this.writeState(
        store,
        record,
        { ...signature, path: parsed.sourcePath ?? signature.path },
        'missing-source',
        0,
        0,
      );
      return 'missing-source';
    }

    const chunks = this.deps.chunker(parsed.entries);
    store.upsertDocument(
      {
        corpus: CORPUS,
        // The document identity is the AGENT TRANSCRIPT (agent_session_id), not
        // the Kangentic session id. Suspend/resume mints a NEW session row that
        // resumes the SAME agent_session_id (the same native history file), so
        // keying the doc on record.id would index that one conversation twice -
        // once per session row - and surface it as a duplicate search hit.
        // Keying on agent_session_id lets the diff-upsert dedup it to one doc.
        docId: record.agent_session_id,
        sessionId: record.id,
        taskId: record.task_id,
        agentSessionId: record.agent_session_id,
        metaJson: null,
      },
      chunks,
    );

    // Durable per-turn token-usage ledger (conversation_turn_usage): captured
    // here from the parsed transcript so it survives the agent pruning its native
    // JSONL. Best-effort - a usage-write failure must not fail the search index or
    // drop the 'ok' state below (the class contract is "never throws to callers").
    try {
      new ConversationUsageStore(db).recordTurns(
        {
          agentSessionId: record.agent_session_id,
          sessionId: record.id,
          taskId: record.task_id,
        },
        extractTurnUsageRecords(parsed.entries),
        this.deps.now(),
      );
    } catch (error) {
      console.warn(`[retrieval] turn-usage record failed for session ${record.id}:`, error);
    }

    this.writeState(
      store,
      record,
      { ...signature, path: parsed.sourcePath ?? signature.path },
      'ok',
      parsed.entries.length,
      chunks.length,
    );
    return 'indexed';
  }

  /**
   * Backfill sweep for a project: reindex sessions whose native history changed
   * (or was never indexed), capped per open. `shouldContinue` is polled between
   * sessions so a project switch / dispose aborts promptly.
   */
  async sweepProject(projectId: string, shouldContinue: () => boolean): Promise<void> {
    if (!shouldContinue()) return;
    let db: Database.Database;
    try {
      db = this.deps.getDb(projectId);
    } catch {
      return;
    }
    const store = new RetrievalStore(db);

    // A chunker change invalidates every stored chunk: purge + reindex.
    if (store.getMeta(CHUNKER_VERSION_KEY) !== String(this.deps.chunkerVersion)) {
      store.purgeAll();
      store.setMeta(CHUNKER_VERSION_KEY, String(this.deps.chunkerVersion));
    }

    const sessionIds = (
      db
        .prepare(
          "SELECT id FROM sessions WHERE agent_session_id IS NOT NULL ORDER BY started_at DESC",
        )
        .all() as Array<{ id: string }>
    ).map((row) => row.id);

    let indexed = 0;
    for (const sessionId of sessionIds) {
      if (!shouldContinue()) return;
      if (indexed >= MAX_SESSIONS_PER_SWEEP) return;
      const outcome = await this.indexSession(projectId, sessionId);
      if (outcome === 'indexed') indexed += 1;
      // Yield between sessions so a large sweep never blocks the event loop.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}
