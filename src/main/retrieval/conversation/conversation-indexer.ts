import crypto from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { agentRegistry } from '../../agent/agent-registry';
import type {
  ParsedSubagentUsage,
  ParsedTranscript,
  ParsedTranscriptWindow,
  SubagentSpawnLink,
  SubagentTranscriptSignature,
} from '../../agent/agent-adapter';
import type { SessionRecord, TranscriptEntry } from '../../../shared/types';
import { RetrievalStore } from '../retrieval-store';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import type { ChunkInput, IndexStateRow } from '../types';
import { chunkTranscript, CHUNKER_VERSION } from './transcript-chunker';
import {
  ConversationUsageStore,
  extractTurnSpawnLinks,
  extractTurnUsageRecords,
  type TurnUsageInput,
} from './conversation-usage-store';

const CORPUS = 'conversation';
const CHUNKER_VERSION_KEY = 'chunker_version';
/** Deleted sessions' documents found per read of the index state. */
const ORPHAN_PAGE = 20;
/** Max sessions actually (re)indexed per backfill sweep, so a large history's
 *  cost amortizes across project opens instead of one long CPU burst. Exported
 *  so tests can assert the cap by the real value rather than a copied-in
 *  literal that could silently drift from it. */
export const MAX_SESSIONS_PER_SWEEP = 25;
/**
 * Max sessions whose SUBAGENT transcripts are walked per sweep. Higher than the
 * main cap because the work is not comparable: the subagent pass never chunks or
 * embeds, it only folds token counts, measured at 57ms for a 13-subagent /
 * 11MB review session. A dogfooding machine carries ~301 sessions with subagent
 * files, so this fills the backlog in about three project opens instead of
 * twelve while staying bounded and yielding between sessions.
 */
export const MAX_SUBAGENT_SESSIONS_PER_SWEEP = 100;
/**
 * Suffix distinguishing a session's SUBAGENT index-state row from its main one.
 * `memory_index_state` is keyed `(corpus, doc_id)` with a free-form doc id, so
 * the two advance independently with no schema change - which is the whole
 * point: a running subagent writes to its own file, leaving the main
 * transcript's mtime and size untouched, so one shared signature would either
 * never see subagent turns or force a full re-chunk of the main transcript on
 * every subagent write.
 */
export const SUBAGENT_DOC_SUFFIX = '#subagents';

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
    attributedMessageIds?: Set<string>,
  ) => Promise<ParsedTranscriptWindow>;
  locateSessionHistoryFile?: (agentSessionId: string, cwd: string) => Promise<string | null>;
  statSubagentTranscripts?: (
    agentSessionId: string,
    cwd: string,
  ) => SubagentTranscriptSignature | null;
  parseSubagentUsage?: (agentSessionId: string, cwd: string) => Promise<ParsedSubagentUsage>;
  /** The agent's subagent-spawning tool name, or undefined when it has none.
   *  Read rather than matched here, so no agent name reaches this layer. */
  subagentSpawnToolName?: string;
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

/**
 * Where the next walk of a growing transcript can start instead of byte 0,
 * stored as JSON on the document's index-state row.
 *
 * A live conversation is indexed again after every turn, and walking it from
 * byte 0 each time parsed and chunked every window of it: 52 windows for a
 * 413 MB transcript, per turn. The walk chunks each window on its own and the
 * parser carries nothing across a window seam except the usage-attribution
 * ids, so a walk that restarts at a window's start, with the carry as it was
 * there, produces exactly the chunks, entries and usage a walk from byte 0
 * would. Everything before that window is left as it is.
 *
 * The point is the start of the LAST WINDOW THAT ADVANCED, not the last window
 * read. A transcript caught mid-write ends in a partial line, and the walk
 * ends on a window at that line that reads nothing. Resuming there would chunk
 * the completed line apart from the window before it, where a walk from byte 0
 * chunks them together.
 */
interface ResumePoint {
  sourcePath: string;
  /** Byte offset of the window to start from. */
  offset: number;
  /** Hash of up to `RESUME_CHECK_BYTES` just before `offset`, so a transcript
   *  rewritten rather than appended to is walked from byte 0. */
  checkHash: string;
  /** Chunks and entries the walk had collected before `offset`. */
  chunkCount: number;
  entryCount: number;
  /** The usage-attribution carry before `offset`, oldest first: the parser
   *  prunes it oldest first, so the order is part of its state. */
  carry: string[];
  /** The owner the chunks and usage rows before `offset` were written for. A
   *  new session row over the same transcript (a resume) re-points every one
   *  of them, which only a walk from byte 0 does. */
  sessionId: string;
  taskId: string | null;
}

const RESUME_CHECK_BYTES = 4096;

/** A transcript reduced to everything indexing needs, with no entries retained. */
interface WalkedTranscript {
  sourcePath: string | null;
  /** Total entries seen across all windows (for the index-state row only). */
  entryCount: number;
  /** Seq of the first chunk in `chunks`: 0, or the resume point's chunk count. */
  fromSeq: number;
  chunks: ChunkInput[];
  usageRecords: TurnUsageInput[];
  /** Subagent-spawning tool calls this transcript emitted. Collected alongside
   *  the usage records but NOT gated on them, so a spawn on a turn the ledger
   *  skips is still resolvable. */
  spawnLinks: SubagentSpawnLink[];
  /** Where the next walk can start, when the walk went by windows. */
  resumeAt: Omit<ResumePoint, 'sourcePath' | 'checkHash' | 'sessionId' | 'taskId'> | null;
}

export interface ConversationIndexerDeps {
  getDb: (projectId: string) => Database.Database;
  getAdapter: (sessionType: string) => AdapterLike | undefined;
  /** fs.stat wrapper returning null when the path is absent/unreadable. */
  stat: (filePath: string) => { mtimeMs: number; size: number } | null;
  now: () => string;
  chunker: (entries: TranscriptEntry[]) => ChunkInput[];
  chunkerVersion: number;
  /** Source bytes per window of the walk. */
  windowBytes: number;
  /** Hash of up to `length` bytes of a file just before `offset`, or null when
   *  the file cannot be read. */
  hashBefore: (filePath: string, offset: number, length: number) => Promise<string | null>;
}

function defaultStat(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const stats = fs.statSync(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

async function defaultHashBefore(filePath: string, offset: number, length: number): Promise<string | null> {
  const start = Math.max(0, offset - length);
  const bytes = Buffer.alloc(offset - start);
  try {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      if (bytesRead !== bytes.length) return null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

/** A stored resume point, or null when it is absent or unreadable. */
function parseResumePoint(json: string | null | undefined): ResumePoint | null {
  if (!json) return null;
  try {
    const point = JSON.parse(json) as ResumePoint;
    return typeof point.offset === 'number' && Array.isArray(point.carry) ? point : null;
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
  windowBytes: INDEX_WINDOW_BYTES,
  hashBefore: defaultHashBefore,
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
    let path: string | null;
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
    docSuffix = '',
    resumePoint: string | null = null,
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
      // `docSuffix` splits the subagent walk onto its own row (see
      // SUBAGENT_DOC_SUFFIX). It stays keyed to record.id, so the record
      // sweep's orphan purge removes it with the main one once the session is
      // deleted; the ledger rows it produced survive by design (no cascade).
      docId: `${record.agent_session_id ?? record.id}${docSuffix}`,
      sessionId: record.id,
      sourcePath: signature.path,
      sourceMtimeMs: signature.mtimeMs,
      sourceSize: signature.size,
      entryCount,
      chunkCount,
      status,
      indexedAt: this.deps.now(),
      resumePoint,
    });
  }

  /**
   * The stored resume point, if the next walk may start from it: written for
   * this owner, the same file, not shorter than the point, the chunks before it
   * all still stored, and the bytes just before it unchanged. Anything else is
   * walked from byte 0.
   */
  private async usableResumePoint(
    store: RetrievalStore,
    record: SessionRecord,
    state: IndexStateRow | undefined,
    signature: SourceSignature,
  ): Promise<ResumePoint | null> {
    const point = state?.status === 'ok' ? parseResumePoint(state.resumePoint) : null;
    if (!point || !record.agent_session_id) return null;
    if (point.sessionId !== record.id || point.taskId !== record.task_id) return null;
    if (point.sourcePath !== signature.path || signature.size === null || signature.size < point.offset) return null;
    if (store.documentChunkCountBelow(CORPUS, record.agent_session_id, point.chunkCount) !== point.chunkCount) return null;
    const checkHash = await this.deps.hashBefore(point.sourcePath, point.offset, RESUME_CHECK_BYTES);
    return checkHash === point.checkHash ? point : null;
  }

  /** The resume point a finished walk leaves for the next one, as JSON. */
  private async resumePointAfter(
    walked: WalkedTranscript,
    sourcePath: string | null,
    record: SessionRecord,
  ): Promise<string | null> {
    if (!walked.resumeAt || !sourcePath) return null;
    const checkHash = await this.deps.hashBefore(sourcePath, walked.resumeAt.offset, RESUME_CHECK_BYTES);
    if (checkHash === null) return null;
    const point: ResumePoint = {
      sourcePath,
      checkHash,
      sessionId: record.id,
      taskId: record.task_id,
      ...walked.resumeAt,
    };
    return JSON.stringify(point);
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
      const resume = await this.usableResumePoint(store, record, state, signature);
      walked = await this.walkTranscript(adapter, record.agent_session_id, record.cwd, resume);
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
      walked.fromSeq,
    );

    // Durable per-turn token-usage ledger (conversation_turn_usage): captured
    // here from the parsed transcript so it survives the agent pruning its native
    // JSONL. Best-effort - a usage-write failure must not fail the search index or
    // drop the 'ok' state below (the class contract is "never throws to callers").
    try {
      const usageStore = new ConversationUsageStore(db);
      usageStore.recordTurns(
        {
          agentSessionId: record.agent_session_id,
          sessionId: record.id,
          taskId: record.task_id,
        },
        walked.usageRecords,
        this.deps.now(),
      );
      // The other half of a subagent's `parent_tool_use_id`. No-op (no statement,
      // no transaction) when this transcript spawned nothing, which is the common
      // case on the live turn-boundary path this method sits on.
      usageStore.recordSpawnLinks(walked.spawnLinks, this.deps.now());
    } catch (error) {
      console.warn(`[retrieval] turn-usage record failed for session ${record.id}:`, error);
    }

    const sourcePath = walked.sourcePath ?? signature.path;
    this.writeState(
      store,
      record,
      { ...signature, path: sourcePath },
      'ok',
      walked.entryCount,
      walked.fromSeq + chunks.length,
      '',
      await this.resumePointAfter(walked, sourcePath, record),
    );
    return 'indexed';
  }

  /**
   * Index one session's SUBAGENT token usage into the turn-usage ledger.
   *
   * Deliberately a SEPARATE method from `indexSession`, not an option on it. The
   * live turn-boundary re-index (`scheduleLiveIndex`) calls `indexSession` after
   * every settled turn, and stays cheap only because an unchanged transcript
   * makes it a no-op. That assumption does not hold here: during a fan-out,
   * thirteen subagents append continuously, so the directory signature changes on
   * every driver turn and each one would pay a full re-walk (measured 57ms) on
   * the main thread - a recurring stall in exactly the workload this feature
   * exists to measure. A separate method means opting in is explicit, and only
   * finalize and the project-open sweep do. Subagent tokens land when the driver
   * finishes, which is when anyone reads them.
   *
   * Never throws. Returns 'skipped' when the signature is unchanged or the agent
   * has no subagent concept, 'missing-source' when the directory is gone (the
   * agent pruned it), and 'error' on a partial read so a later sweep retries.
   */
  async indexSubagentUsage(projectId: string, sessionId: string): Promise<IndexOutcome> {
    let db: Database.Database;
    try {
      db = this.deps.getDb(projectId);
    } catch {
      return 'error';
    }
    const record = new SessionRepository(db).findByAnyId(sessionId);
    if (!record?.agent_session_id) return 'skipped';

    const adapter = this.deps.getAdapter(record.session_type);
    // No subagent concept for this agent. Terminal, and cheap: no state row is
    // written, so this costs one map lookup per sweep forever.
    if (!adapter?.parseSubagentUsage || !adapter.statSubagentTranscripts) return 'skipped';

    const store = new RetrievalStore(db);
    const docId = `${record.agent_session_id}${SUBAGENT_DOC_SUFFIX}`;
    const state = store.getIndexState(CORPUS, docId);

    let signature: SourceSignature;
    try {
      const stats = adapter.statSubagentTranscripts(record.agent_session_id, record.cwd);
      // Fold the directory to the same three fields `needsIndex` already
      // compares. fileCount rides in `path` because a new subagent adds a file
      // without necessarily moving the largest mtime within one millisecond.
      signature = stats
        ? { path: `${docId}:${stats.fileCount}`, mtimeMs: stats.maxMtimeMs, size: stats.totalSize }
        : { path: null, mtimeMs: null, size: null };
    } catch {
      signature = { path: null, mtimeMs: null, size: null };
    }
    if (!needsIndex(state, signature)) return 'skipped';

    let parsed: ParsedSubagentUsage;
    try {
      parsed = await adapter.parseSubagentUsage(record.agent_session_id, record.cwd);
    } catch {
      this.writeState(store, record, signature, 'error', 0, 0, SUBAGENT_DOC_SUFFIX);
      return 'error';
    }

    // No directory at all: the agent pruned its transcripts (or never fanned
    // out). Recorded rather than left blank, so a reader can tell a GAP in
    // coverage from a genuinely quiet session.
    if (!parsed.directoryPresent) {
      this.writeState(store, record, signature, 'missing-source', 0, 0, SUBAGENT_DOC_SUFFIX);
      return 'missing-source';
    }

    try {
      const usageStore = new ConversationUsageStore(db);
      usageStore.recordTurns(
        {
          agentSessionId: record.agent_session_id,
          sessionId: record.id,
          taskId: record.task_id,
        },
        parsed.turns,
        this.deps.now(),
      );
      // Spawns made BY these subagents. This is the edge a depth-2 subagent needs
      // to reach its depth-1 parent; without it, nesting is only a number.
      // `?? []` because an adapter that predates this field would otherwise throw
      // here, and the catch below would discard its TURNS too - losing real token
      // data over a missing optional.
      usageStore.recordSpawnLinks(parsed.spawnLinks ?? [], this.deps.now());
    } catch (error) {
      console.warn(`[retrieval] subagent usage record failed for session ${record.id}:`, error);
      this.writeState(store, record, signature, 'error', 0, 0, SUBAGENT_DOC_SUFFIX);
      return 'error';
    }

    // A truncated read wrote real rows (they are idempotent by turn uuid, so a
    // later walk completes them), but must NOT be stamped 'ok': the signature
    // would then look current and the missing tail would never be picked up.
    if (!parsed.complete) {
      this.writeState(store, record, signature, 'error', parsed.turns.length, 0, SUBAGENT_DOC_SUFFIX);
      return 'error';
    }
    this.writeState(store, record, signature, 'ok', parsed.turns.length, 0, SUBAGENT_DOC_SUFFIX);
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
   *
   * Given a resume point, the windowed walk starts there and returns only what
   * follows it: chunks numbered from the point's chunk count, and the usage
   * and spawn links of those windows alone, which is enough because the ledger
   * writes upsert and never delete (see `ResumePoint`).
   */
  private async walkTranscript(
    adapter: AdapterLike,
    agentSessionId: string,
    cwd: string,
    resume: ResumePoint | null,
  ): Promise<WalkedTranscript> {
    const start = adapter.parseTranscriptWindow ? resume : null;
    const fromSeq = start?.chunkCount ?? 0;
    const chunks: ChunkInput[] = [];
    const usageRecords: TurnUsageInput[] = [];
    const spawnLinks: SubagentSpawnLink[] = [];
    let sourcePath: string | null = null;
    let entryCount = start?.entryCount ?? 0;

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
        chunks.push({ ...chunk, seq: fromSeq + chunks.length });
      }
      for (const usage of extractTurnUsageRecords(indexable)) usageRecords.push(usage);
      // Note this reads `indexable`, not the raw `entries`: the truncation notice
      // is the only thing filtered out and it is a `system` entry, so the two are
      // identical here. Using the same list the usage records use keeps one
      // source for both.
      for (const link of extractTurnSpawnLinks(indexable, adapter.subagentSpawnToolName)) {
        spawnLinks.push(link);
      }
    };

    if (adapter.parseTranscriptWindow) {
      let offset = start?.offset ?? 0;
      // Usage-attribution carry, created OUTSIDE the loop and never reset per
      // window. An agent reports one API message's tokens on several transcript
      // lines; the adapter attributes them to the first line it emits, and a
      // per-window dedupe would attribute them AGAIN on the far side of a seam.
      // Chunking never reads usage so it would not notice, but every usage
      // record below carries its own line uuid and `turn_uuid` is the ledger's
      // primary key, so the two attributions become two rows and the message is
      // counted twice.
      //
      // Resetting this per window is the subtle way to reintroduce that: a
      // window can legitimately attribute nothing (one parallel-tool batch's
      // tool_result lines can fill it), and the carry has to survive that
      // window to reach the message's remaining lines. The adapter prunes it, so
      // it costs a handful of ids against a `usageRecords` array that is already
      // O(turns in the file). A resumed walk starts from the carry as it was at
      // its window, in the same order.
      const attributedMessageIds = new Set<string>(start?.carry ?? []);
      let resumeAt: WalkedTranscript['resumeAt'] = null;
      // Bounds the walk against a pathological file or an adapter that fails to
      // advance. At INDEX_WINDOW_BYTES per window this still covers far more
      // than any real transcript.
      for (let windowIndex = 0; windowIndex < 4096; windowIndex += 1) {
        // Taken before the parse, which prunes and adds to the carry in place.
        const beforeWindow = { offset, chunkCount: fromSeq + chunks.length, entryCount, carry: [...attributedMessageIds] };
        const window = await adapter.parseTranscriptWindow(
          agentSessionId, cwd, offset, this.deps.windowBytes, attributedMessageIds,
        );
        sourcePath = window.sourcePath ?? sourcePath;
        timeSyncWork('index:chunk-window', () => collect(window.entries));
        if (window.nextByteOffset <= offset) break;
        resumeAt = beforeWindow;
        offset = window.nextByteOffset;
        if (offset >= window.totalBytes) break;
      }
      return { sourcePath, entryCount, fromSeq, chunks, usageRecords, spawnLinks, resumeAt };
    }

    // Narrowed rather than asserted: `indexSession` only reaches here when at
    // least one of the two capabilities exists, and the window branch above
    // consumed the other - but that reasoning lives in a different method, so
    // let the type system carry it instead of a `!`.
    const unwalked = { fromSeq, chunks, usageRecords, spawnLinks, resumeAt: null };
    if (!adapter.parseTranscript) return { sourcePath, entryCount, ...unwalked };
    const parsed = await adapter.parseTranscript(agentSessionId, cwd);
    sourcePath = parsed.sourcePath;
    collect(parsed.entries);
    return { sourcePath, entryCount, ...unwalked };
  }

  /**
   * Remove deleted sessions' documents from the index (the conversation, its
   * subagent walk, the files it changed), one document at a time with a yield
   * between, `DELETES_PER_TRANSACTION` chunks per transaction. This used to be
   * a trigger on `sessions`, which deleted a whole conversation inside the
   * session delete's own transaction. Returns how many documents went; never
   * throws.
   */
  async purgeDeletedSessions(projectId: string, shouldContinue: () => boolean): Promise<number> {
    let removed = 0;
    let store: RetrievalStore;
    try {
      store = new RetrievalStore(this.deps.getDb(projectId));
    } catch {
      return removed;
    }
    for (;;) {
      if (!shouldContinue()) return removed;
      let documents: Array<{ corpus: string; docId: string }>;
      try {
        documents = store.deletedSessionDocuments(ORPHAN_PAGE);
      } catch {
        return removed;
      }
      if (documents.length === 0) return removed;
      for (const { corpus, docId } of documents) {
        if (!shouldContinue()) return removed;
        try {
          timeSyncWork('index:purge-deleted', () => store.deleteDocument(corpus, docId));
          removed += 1;
        } catch (error) {
          console.warn(`[retrieval] a deleted session's ${corpus} document ${docId} failed to remove:`, error);
          return removed;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
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

    // A chunker change invalidates every conversation chunk and the session
    // changes read from them: purge + reindex. Task records are chunked by
    // their own indexer and survive.
    if (store.getMeta(CHUNKER_VERSION_KEY) !== String(this.deps.chunkerVersion)) {
      store.purgeCorpora(['conversation', 'change']);
      store.setMeta(CHUNKER_VERSION_KEY, String(this.deps.chunkerVersion));
    }

    const sessionIds = (
      db
        .prepare(
          "SELECT id FROM sessions WHERE agent_session_id IS NOT NULL ORDER BY started_at DESC",
        )
        .all() as Array<{ id: string }>
    ).map((row) => row.id);

    // TWO independent budgets over one session list. The main transcript pass
    // chunks and feeds embedding, so it stays at 25; the subagent pass only
    // folds token counts (no chunking, no embedding, measured 57ms for a
    // 13-subagent review) and gets its own, higher cap. The loop runs until BOTH
    // are spent, so a backlog of already-chunked sessions still gets its
    // subagent history filled in rather than being gated behind the main cap.
    let parsedThisSweep = 0;
    let subagentParsedThisSweep = 0;
    for (const sessionId of sessionIds) {
      if (!shouldContinue()) return;
      const mainBudgetLeft = parsedThisSweep < MAX_SESSIONS_PER_SWEEP;
      const subagentBudgetLeft = subagentParsedThisSweep < MAX_SUBAGENT_SESSIONS_PER_SWEEP;
      if (!mainBudgetLeft && !subagentBudgetLeft) return;

      if (mainBudgetLeft) {
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
      }
      if (subagentBudgetLeft) {
        // Same accounting rule: 'skipped' reads nothing (unchanged signature, or
        // an agent with no subagent concept) and stays free.
        const outcome = await this.indexSubagentUsage(projectId, sessionId);
        if (outcome === 'indexed' || outcome === 'error' || outcome === 'missing-source') {
          subagentParsedThisSweep += 1;
        }
      }
      // Yield between sessions so a large sweep never blocks the event loop.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}
