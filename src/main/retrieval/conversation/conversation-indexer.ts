import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { agentRegistry } from '../../agent/agent-registry';
import type { ParsedTranscript, ParsedTranscriptWindow } from '../../agent/agent-adapter';
import type { SessionRecord, TranscriptEntry } from '../../../shared/types';
import { RetrievalStore } from '../retrieval-store';
import type { ChunkInput, IndexStateRow } from '../types';
import { chunkTranscript, CHUNKER_VERSION } from './transcript-chunker';
import {
  ConversationUsageStore,
  extractTurnUsageRecords,
  type TurnUsageInput,
} from './conversation-usage-store';

const CORPUS = 'conversation';
const CHUNKER_VERSION_KEY = 'chunker_version';
/** Max sessions actually (re)indexed per backfill sweep, so a large history's
 *  cost amortizes across project opens instead of one long CPU burst. Exported
 *  so tests can assert the cap by the real value rather than a copied-in
 *  literal that could silently drift from it. */
export const MAX_SESSIONS_PER_SWEEP = 25;

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
  parseTranscriptWindow?: (
    agentSessionId: string,
    cwd: string,
    startByte: number,
    maxBytes: number,
  ) => Promise<ParsedTranscriptWindow>;
  locateSessionHistoryFile?: (agentSessionId: string, cwd: string) => Promise<string | null>;
}

/**
 * Source bytes the indexer parses at a time when walking a transcript in
 * windows.
 *
 * Deliberately its OWN constant rather than the parser's
 * `MAX_PARSE_SOURCE_BYTES`. They answer different questions: the parser's cap
 * is a RETENTION bound the user sees directly (turns missing from the top of
 * the viewer), while this is an internal WORKING-SET bound with no user-visible
 * effect at all - every window is chunked and dropped, so the whole file is
 * indexed regardless of how this is tuned. Sharing one constant would couple a
 * product decision to a memory-profiling one.
 */
const INDEX_WINDOW_BYTES = 8 * 1024 * 1024;

/** A transcript reduced to everything indexing needs, with no entries retained. */
interface WalkedTranscript {
  sourcePath: string | null;
  /** Total entries seen across all windows (for the index-state row only). */
  entryCount: number;
  chunks: ChunkInput[];
  usageRecords: TurnUsageInput[];
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

    // Raw-only agent: no structured parser. Terminal 'unsupported'. Either
    // capability qualifies - gating on `parseTranscript` alone would reject an
    // adapter that implements ONLY the windowed walk before the walk it was
    // written for could ever run.
    if (!adapter?.parseTranscript && !adapter?.parseTranscriptWindow) {
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

    let walked: WalkedTranscript;
    try {
      walked = await this.walkTranscript(adapter, record.agent_session_id, record.cwd);
    } catch {
      this.writeState(store, record, signature, 'error', 0, 0);
      return 'error';
    }
    if (walked.entryCount === 0) {
      this.writeState(
        store,
        record,
        { ...signature, path: walked.sourcePath ?? signature.path },
        'missing-source',
        0,
        0,
      );
      return 'missing-source';
    }
    const chunks = walked.chunks;
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
        walked.usageRecords,
        this.deps.now(),
      );
    } catch (error) {
      console.warn(`[retrieval] turn-usage record failed for session ${record.id}:`, error);
    }

    this.writeState(
      store,
      record,
      { ...signature, path: walked.sourcePath ?? signature.path },
      'ok',
      walked.entryCount,
      chunks.length,
    );
    return 'indexed';
  }

  /**
   * Read a session's whole transcript and reduce it to chunks + usage records,
   * WITHOUT ever holding the whole thing.
   *
   * Prefers the adapter's windowed walk: chunk a window, keep only its
   * (small, owned-string) chunks and usage records, drop its entries, advance.
   * Peak is therefore one window PLUS this session's accumulated chunk and
   * usage output, not one window flat - the chunks are held until the single
   * upsert at the end. That output runs roughly 0.05-0.1x source bytes, so a
   * 137.9MB transcript costs one 8MB window plus low tens of MB, rather than
   * the 275.9MB string a whole-file read would have materialized.
   * `parseTranscript` is the fallback for adapters without the capability, and
   * it returns only a bounded tail of a large file - so an adapter that has not
   * implemented `parseTranscriptWindow` indexes only recent history. That is
   * the deliberate trade: bounded memory everywhere, full search coverage
   * wherever the walk exists.
   */
  private async walkTranscript(
    adapter: AdapterLike,
    agentSessionId: string,
    cwd: string,
  ): Promise<WalkedTranscript> {
    const chunks: ChunkInput[] = [];
    const usageRecords: TurnUsageInput[] = [];
    let sourcePath: string | null = null;
    let entryCount = 0;

    // `seq` must be 0-based and DENSE across the whole document, but the
    // chunker numbers from 0 per call, so per-window numbering has to be
    // rebased here rather than trusted.
    const collect = (entries: TranscriptEntry[]): void => {
      // Drop the "earlier N MB are not shown" notice before chunking. It is a
      // presentation artifact of the READER's size cap, not conversation
      // content, and the chunker indexes `system` entries verbatim - so every
      // large session would otherwise carry a searchable chunk describing the
      // viewer's truncation, which is pure noise in the corpus.
      const indexable = entries.filter(
        (entry) => !(entry.kind === 'system' && entry.subtype === 'truncated'),
      );
      entryCount += indexable.length;
      for (const chunk of this.deps.chunker(indexable)) {
        chunks.push({ ...chunk, seq: chunks.length });
      }
      for (const usage of extractTurnUsageRecords(indexable)) usageRecords.push(usage);
    };

    if (adapter.parseTranscriptWindow) {
      let offset = 0;
      // Bounds the walk against a pathological file or an adapter that fails to
      // advance. At INDEX_WINDOW_BYTES per window this still covers far more
      // than any real transcript.
      for (let windowIndex = 0; windowIndex < 4096; windowIndex += 1) {
        const window = await adapter.parseTranscriptWindow(
          agentSessionId, cwd, offset, INDEX_WINDOW_BYTES,
        );
        sourcePath = window.sourcePath ?? sourcePath;
        collect(window.entries);
        if (window.nextByteOffset <= offset) break;
        offset = window.nextByteOffset;
        if (offset >= window.totalBytes) break;
      }
      return { sourcePath, entryCount, chunks, usageRecords };
    }

    // Narrowed rather than asserted: `indexSession` only reaches here when at
    // least one of the two capabilities exists, and the window branch above
    // consumed the other - but that reasoning lives in a different method, so
    // let the type system carry it instead of a `!`.
    if (!adapter.parseTranscript) return { sourcePath, entryCount, chunks, usageRecords };
    const parsed = await adapter.parseTranscript(agentSessionId, cwd);
    sourcePath = parsed.sourcePath;
    collect(parsed.entries);
    return { sourcePath, entryCount, chunks, usageRecords };
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

    let parsedThisSweep = 0;
    for (const sessionId of sessionIds) {
      if (!shouldContinue()) return;
      if (parsedThisSweep >= MAX_SESSIONS_PER_SWEEP) return;
      const outcome = await this.indexSession(projectId, sessionId);
      // Count every outcome that actually PARSED, not just the ones that
      // produced chunks. The cap previously incremented on 'indexed' alone,
      // while the driving query has no LIMIT - so sessions that parsed and then
      // returned 'error' or 'missing-source' were free, and one sweep could run
      // an unbounded number of full transcript reads. 'skipped' (signature
      // unchanged) and 'unsupported' (no parser) do no file reading and stay
      // free, which is what keeps the steady-state sweep cheap.
      if (outcome === 'indexed' || outcome === 'error' || outcome === 'missing-source') {
        parsedThisSweep += 1;
      }
      // Yield between sessions so a large sweep never blocks the event loop.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}
