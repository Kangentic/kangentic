/**
 * The conversation viewer's transcript reader: parse each of a task's sessions
 * (through the stat-validated cache) and stitch them into one timeline.
 *
 * Runs in the retrieval worker (`worker/transcript-methods.ts`), never on
 * main: a 16 MB tail parse was 47 ms of main's time on a 448 MB transcript,
 * and the Conversation window, the phone and MCP read it while an agent runs.
 * The worker also parses the same files for the index, so both share one
 * cache. Entries keep their object identity across reads while their source
 * is unchanged, which the delta a viewer receives is built on.
 */
import type Database from 'better-sqlite3';
import { SessionRepository } from '../db/repositories/session-repository';
import { agentRegistry } from './agent-registry';
import { workflowAgentSessionRecord } from '../workflows/workflow-agent-record';
import { RetrievalStore } from '../retrieval/retrieval-store';
import type { StoredChunk } from '../retrieval/types';
import { touchBounded, heldBytes } from './shared/bounded-lru';
import { timeSyncWork } from '../diagnostics/event-loop-lag';
import {
  clampSpan,
  getCachedTranscript,
  isCachedFileUnchanged,
  peekCachedFileSignature,
  resetForTests as resetTranscriptCacheForTests,
  retainedSourceBytes,
  truncateEntries,
} from './transcript-cache';
import {
  archiveRowLineStart,
  readArchivedConversation,
  type ArchivedConversation,
} from '../retrieval/archive/transcript-archive';
import { parseWindowBytes, prependTruncationMarker } from './shared/transcript-truncation';
import { encodeJsonlCursor } from './shared/jsonl-history-page';
import type { AgentAdapter } from './agent-adapter';
import type {
  ConversationExtent,
  ConversationSessionMeta,
  SessionRecord,
  TranscriptEntry,
  TranscriptSource,
  TranscriptUnavailableReason,
} from '../../shared/types';
import { transcriptEntryKey } from '../../shared/types';

export interface ResolvedTranscript {
  record: SessionRecord;
  taskTitle: string;
  agentName: string;
  source: TranscriptSource;
  sourcePath: string | null;
  entries: TranscriptEntry[];
  degraded: boolean;
  unavailableReason?: TranscriptUnavailableReason;
  /** The conversation's extent for a paging viewer, or null when it has no
   *  source to page (the index fallback, no history, no agent session id). */
  extent: ConversationExtent | null;
}

/** A task's entire lifecycle, stitched from every session it has ever
 *  accumulated. The "latest" fields (record/agentName/source/sourcePath)
 *  describe the newest contributing session, since that is the one live
 *  polling watches; `entries` and `sessions` span all of them. `revision`
 *  bumps only when the stitched `entries` array actually changes content
 *  (see the stitch memo below), letting the IPC layer short-circuit an idle
 *  poll. */
export interface ResolvedTaskTranscript {
  record: SessionRecord;
  taskTitle: string;
  agentName: string;
  source: TranscriptSource;
  sourcePath: string | null;
  entries: TranscriptEntry[];
  degraded: boolean;
  unavailableReason?: TranscriptUnavailableReason;
  sessions: ConversationSessionMeta[];
  revision: number;
  /**
   * The agent of the newest session read from Kangentic's archive because its
   * own file is gone, or null when no session was. `source` describes only the
   * latest session, so the viewer's banner reads this instead.
   */
  archivedAgentName: string | null;
  /** Each contributing conversation's extent, once per agent session id. */
  conversations: ConversationExtent[];
}

/** A conversation's indexed chunks, in order: the fields the fallback reads. */
export type IndexedChunk = Pick<StoredChunk, 'id' | 'role' | 'text' | 'tsStart' | 'turnUuidStart'>;

/**
 * Reads a conversation's indexed chunks from the project's index, on the
 * worker's own connection to it. Tests set another reader.
 */
let readIndexedChunks = async (db: Database.Database, docId: string): Promise<IndexedChunk[]> => {
  try {
    return new RetrievalStore(db).getChunksForDoc('conversation', docId);
  } catch {
    // No index tables yet: nothing to fall back on.
    return [];
  }
};

export function setIndexedChunkReaderForTests(reader: typeof readIndexedChunks): void {
  readIndexedChunks = reader;
}

/** The clamped, marked entries made from one archived read, so a poll at the
 *  same archive revision hands the stitch the SAME array (its token is by
 *  reference) and nothing is re-stitched. */
const displayEntriesByArchivedRead = new WeakMap<ArchivedConversation, TranscriptEntry[]>();

/**
 * A conversation's entries from Kangentic's archive (`transcript-archive.ts`),
 * for when the agent's own file is gone: structured like a live read, bounded
 * to the same newest `parseWindowBytes()` of source, with the same notice when
 * older rows were left out and the same per-span clamp. Empty when the archive
 * does not hold it.
 */
async function entriesFromArchive(
  db: Database.Database,
  agentSessionId: string,
): Promise<{ entries: TranscriptEntry[]; totalPosition: number }> {
  let archived: ArchivedConversation | null;
  try {
    archived = await readArchivedConversation(db, agentSessionId, parseWindowBytes());
  } catch (error) {
    console.warn(`transcript archive read failed for ${agentSessionId}:`, error);
    return { entries: [], totalPosition: 0 };
  }
  if (!archived || archived.entries.length === 0) return { entries: [], totalPosition: 0 };
  return { entries: archivedDisplayEntries(archived, agentSessionId), totalPosition: archived.totalBytes };
}

function archivedDisplayEntries(archived: ArchivedConversation, agentSessionId: string): TranscriptEntry[] {
  const known = displayEntriesByArchivedRead.get(archived);
  if (known) return known;
  // The archive's row offsets point at the newline before a row's first line;
  // the notice and its cursor use that line's own start, as a live read does.
  const firstLineStart = archiveRowLineStart(archived.omittedBytes);
  const display = prependTruncationMarker(truncateEntries(archived.entries), firstLineStart, archived.totalBytes, {
    conversationId: agentSessionId,
    cursor: encodeJsonlCursor({ byte: firstLineStart, line: null }),
  });
  displayEntriesByArchivedRead.set(archived, display);
  return display;
}

/** Where a conversation's tail begins: its `truncated` notice's position, or 0
 *  when the tail holds the whole conversation. */
function tailStartPositionOf(entries: TranscriptEntry[]): number {
  for (const entry of entries) {
    if (entry.kind === 'system' && entry.subtype === 'truncated' && entry.earlierHistory) {
      return entry.earlierHistory.position;
    }
  }
  return 0;
}

/** A conversation's extent, from what its read returned. */
function extentOf(
  adapter: AgentAdapter | undefined,
  conversationId: string,
  entries: TranscriptEntry[],
  totalPosition: number,
  pageable: boolean,
): ConversationExtent {
  return {
    conversationId,
    totalPosition,
    tailStartPosition: tailStartPositionOf(entries),
    pageable,
    hasTimestamps: adapter?.transcriptHasTimestamps !== false,
  };
}

/** Reconstruct lossy display entries from indexed chunks when the native
 *  history file is gone. Block structure is not recoverable, so each chunk maps
 *  to a single-block entry of its recorded role. */
async function entriesFromIndex(db: Database.Database, docId: string): Promise<TranscriptEntry[]> {
  const chunks = await readIndexedChunks(db, docId);
  return chunks.map((chunk): TranscriptEntry => {
    const uuid = chunk.turnUuidStart ?? `chunk-${chunk.id}`;
    const ts = chunk.tsStart ?? 0;
    const text = clampSpan(chunk.text);
    if (chunk.role === 'user') return { kind: 'user', uuid, ts, text };
    if (chunk.role === 'tool_result') {
      return { kind: 'tool_result', uuid, ts, toolUseId: '', content: text };
    }
    if (chunk.role === 'system') {
      return { kind: 'system', uuid, ts, subtype: 'command', text };
    }
    // assistant + mixed render as assistant text.
    return { kind: 'assistant', uuid, ts, blocks: [{ type: 'text', text }] };
  });
}

/**
 * What Kangentic kept of a conversation whose file the agent deleted, and
 * where from: the structured archive, else the index's text-only chunks. Null
 * when neither holds it. `kangentic_get_transcript` says which it read, and the
 * recap of a session started in its place reads its tail from it
 * (`transcript.recapTail`).
 */
export async function readSavedConversation(
  db: Database.Database,
  agentSessionId: string,
): Promise<{ entries: TranscriptEntry[]; source: 'archive' | 'index'; totalPosition?: number } | null> {
  const archived = await entriesFromArchive(db, agentSessionId);
  if (archived.entries.length > 0) return { entries: archived.entries, source: 'archive', totalPosition: archived.totalPosition };
  const indexed = await entriesFromIndex(db, agentSessionId);
  if (indexed.length > 0) return { entries: indexed, source: 'index' };
  return null;
}

/**
 * The record a transcript resolves from, by any id: the session row, or, for a
 * workflow's own agent, which has no sessions row, one assembled from its
 * workflow when the id is that workflow's conversation id
 * (`workflowAgentSessionRecord`). `title` names the workflow.
 */
export function findTranscriptRecord(db: Database.Database, anyId: string): { record: SessionRecord; title: string | null } | null {
  const record = new SessionRepository(db).findByAnyId(anyId);
  if (record) return { record, title: null };
  let row: { title: string; agent_name: string | null; agent_session_id: string; agent_cwd: string | null; created_at: string } | undefined;
  try {
    row = db.prepare('SELECT title, agent_name, agent_session_id, agent_cwd, created_at FROM workflows WHERE agent_session_id = ?')
      .get(anyId) as typeof row;
  } catch {
    return null;
  }
  const adapter = row?.agent_name ? agentRegistry.get(row.agent_name) : undefined;
  if (!row || !adapter || !row.agent_cwd) return null;
  return {
    title: `Workflow agent: ${row.title}`,
    record: workflowAgentSessionRecord({
      agentSessionId: row.agent_session_id,
      sessionType: adapter.sessionType,
      cwd: row.agent_cwd,
      startedAt: row.created_at,
    }),
  };
}

/**
 * Resolve a session's structured conversation for the viewer. Live-parse
 * primary (freshest, full block structure). When the native history is gone,
 * Kangentic's archived copy, then the index's text-only chunks
 * (`readSavedConversation`). `source: 'none'` when none of them holds it.
 * Returns null only when the session id resolves to no record.
 *
 * No agent-name branching: the structured-parse capability is read from the
 * adapter (agent-adapters-boundary).
 */
export async function resolveSessionTranscript(
  db: Database.Database,
  sessionId: string,
): Promise<ResolvedTranscript | null> {
  const found = findTranscriptRecord(db, sessionId);
  if (!found) return null;
  const { record } = found;

  const taskRow = db.prepare('SELECT title FROM tasks WHERE id = ?').get(record.task_id) as
    | { title: string }
    | undefined;
  const taskTitle = found.title ?? taskRow?.title ?? '(unknown task)';
  const adapter = agentRegistry.getBySessionType(record.session_type);
  const agentName = adapter?.displayName ?? record.session_type;

  const base = {
    record,
    taskTitle,
    agentName,
  };

  // Live parse via the adapter's structured-parse capability, wrapped in the
  // stat-validated cache so an unchanged file costs one fs.stat instead of a
  // full re-parse.
  if (adapter?.parseTranscript && record.agent_session_id) {
    const agentSessionId = record.agent_session_id;
    let entries: TranscriptEntry[];
    let sourcePath: string | null = null;
    let totalPosition = 0;
    try {
      const cached = await getCachedTranscript(
        record.session_type,
        agentSessionId,
        () => adapter.parseTranscript!(agentSessionId, record.cwd),
      );
      entries = cached.entries;
      sourcePath = cached.sourcePath;
      totalPosition = cached.totalPosition ?? 0;
    } catch (error) {
      // A genuine parser failure (permission error, corrupt JSONL, adapter
      // regression) must not look identical to "session has no transcript yet":
      // log it, then fall through to the index fallback.
      console.warn(`transcript live-parse failed for session ${agentSessionId}:`, error);
      entries = [];
    }
    if (entries.length > 0) {
      // Already truncated inside the cache.
      return {
        ...base,
        source: 'live',
        sourcePath,
        entries,
        degraded: false,
        extent: extentOf(adapter, agentSessionId, entries, totalPosition, !!adapter.readTranscriptPage),
      };
    }
    // Native file gone or empty: the archived copy first, which keeps the
    // structure and is not degraded, then the index's chunks, which keep the
    // text only and are.
    const saved = await readSavedConversation(db, agentSessionId);
    if (saved) {
      return {
        ...base,
        source: saved.source,
        sourcePath,
        entries: saved.entries,
        degraded: saved.source === 'index',
        extent: saved.source === 'archive'
          ? extentOf(adapter, agentSessionId, saved.entries, saved.totalPosition ?? 0, true)
          : null,
      };
    }
    return {
      ...base,
      source: 'none',
      sourcePath,
      entries: [],
      degraded: false,
      unavailableReason: 'file_missing',
      extent: null,
    };
  }

  // No structured parser, or no agent_session_id yet: archive, then index
  // fallback, else none.
  const savedId = record.agent_session_id ?? record.id;
  const saved = await readSavedConversation(db, savedId);
  if (saved) {
    return {
      ...base,
      source: saved.source,
      sourcePath: null,
      entries: saved.entries,
      degraded: saved.source === 'index',
      extent: saved.source === 'archive' ? extentOf(adapter, savedId, saved.entries, saved.totalPosition ?? 0, true) : null,
    };
  }
  return {
    ...base,
    source: 'none',
    sourcePath: null,
    entries: [],
    degraded: false,
    unavailableReason: adapter?.parseTranscript ? 'no_agent_session_id' : 'unsupported_agent',
    extent: null,
  };
}

/**
 * Identity token for a resolved session's `entries` array, used to build the
 * task-level stitch memo's dependency fingerprint below. `getCachedTranscript`
 * returns the SAME array reference across calls when the underlying file is
 * unchanged, so tokening by reference (not content) is both cheap and exact
 * for the 'live' source - a genuine content change always produces a new
 * array from the cache. The index/none sources build a fresh array on every
 * call (no file-level cache backs them), so their token changes every poll;
 * that is an acceptable cost since a degraded session's entries are rare and
 * few.
 */
const entriesArrayTokens = new WeakMap<TranscriptEntry[], number>();
let nextEntriesArrayToken = 1;
function tokenForEntries(entries: TranscriptEntry[]): number {
  let token = entriesArrayTokens.get(entries);
  if (token === undefined) {
    token = nextEntriesArrayToken;
    nextEntriesArrayToken += 1;
    entriesArrayTokens.set(entries, token);
  }
  return token;
}

interface StitchMemoRecord {
  depsFingerprint: string;
  revision: number;
  entries: TranscriptEntry[];
  /**
   * The file signatures this stitch was built from, captured HERE rather than
   * read back out of the file cache. That independence is the whole point:
   * the file cache is a small LRU, and a busy board evicts it constantly (one
   * measured Home refresh touched 20 files against a 16-entry cache), so a
   * fast path that depended on it would go dark exactly when it is needed
   * most. Empty when any contributing session had no file to stat (an
   * index/none source), which disables the fast path for that task rather
   * than letting it return a stitch it cannot prove is current.
   */
  fileSignatures: Array<{ sourcePath: string; mtimeMs: number; size: number }>;
  /** File-derived fields, safe to reuse when every file is untouched. */
  fileDerived: {
    source: TranscriptSource;
    sourcePath: string | null;
    degraded: boolean;
    unavailableReason: TranscriptUnavailableReason | undefined;
    agentName: string;
    archivedAgentName: string | null;
    conversations: ConversationExtent[];
  };
}

/** Task-level stitch memo, capped so a long-running app does not grow this
 *  unbounded across many opened tasks. */
const STITCH_MEMO_LIMIT = 64;

/**
 * Byte budget across all retained stitch memos, in SOURCE bytes, summed from
 * the `fileSignatures` each record already carries.
 *
 * A memo's `entries` array is NEW, but its ELEMENTS are the very objects the
 * file cache holds: the stitch pushes cached entries by reference (an assistant
 * entry gets a shallow-spread shell, but shares its `blocks` and `usage`). So
 * this budget double-counts with `CACHE_BYTE_BUDGET` for as long as both hold
 * the same objects, and it is deliberately budgeted anyway - the memo is an
 * INDEPENDENT RETENTION ROOT. It is designed to outlive file-cache eviction
 * (see the `fileSignatures` note above: that independence "is the whole
 * point"), which means the file cache's budget provably does not bound it, and
 * 64 tasks x the union of every resumed session's entries had no byte bound at
 * all.
 *
 * Matched to the file cache rather than sized independently, precisely because
 * the two overlap: a memo holding entries the cache also holds costs nothing
 * extra, and one holding entries the cache has already evicted is the case this
 * is here to bound.
 *
 * Mutable only so tests can exercise eviction against a few KB of stitched
 * entries instead of writing 192MB of temp transcripts (mirrors
 * `incrementalStateByteBudget` in the Claude transcript parser).
 */
const STITCH_MEMO_BYTE_BUDGET = 192 * 1024 * 1024;
let stitchMemoByteBudget = STITCH_MEMO_BYTE_BUDGET;
const stitchMemoByTaskId = new Map<string, StitchMemoRecord>();

/** Source bytes behind one memo, each file charged only the bytes its entries
 *  can have been parsed from (`retainedSourceBytes`). Zero when the stitch had no
 *  statable file (an index/none source), which is also when its fast path is
 *  disabled. */
function stitchMemoSourceBytes(record: StitchMemoRecord): number {
  let total = 0;
  for (const signature of record.fileSignatures) total += retainedSourceBytes(signature.size);
  return total;
}

function touchStitchMemo(taskId: string, record: StitchMemoRecord): void {
  touchBounded(stitchMemoByTaskId, taskId, record, {
    limit: STITCH_MEMO_LIMIT,
    byteBudget: stitchMemoByteBudget,
    sizeOf: stitchMemoSourceBytes,
    // Evicting a memo only costs a re-stitch from the file cache, never
    // correctness: `resolveTaskTranscript` hands `record.entries` to callers, so
    // dropping the record is safe while removing the field would not be.
    minRetained: 1,
  });
}

/**
 * A task's last few stitched revisions, newest last, so a viewer that holds
 * an earlier one can be sent only what changed since (`entriesAtRevision`).
 * A poll every 2.5 s is normally one revision behind; a few cover a phone and
 * a desktop window reading the same task at their own pace.
 */
const REVISIONS_KEPT = 4;
const revisionHistoryByTaskId = new Map<string, Array<{ revision: number; entries: TranscriptEntry[] }>>();

function recordRevision(taskId: string, revision: number, entries: TranscriptEntry[]): void {
  const history = revisionHistoryByTaskId.get(taskId) ?? [];
  if (history.length > 0 && history[history.length - 1].revision === revision) return;
  history.push({ revision, entries });
  while (history.length > REVISIONS_KEPT) history.shift();
  revisionHistoryByTaskId.set(taskId, history);
  // Kept only for tasks the memo still holds, so its bounds bound this too.
  for (const heldTaskId of revisionHistoryByTaskId.keys()) {
    if (!stitchMemoByTaskId.has(heldTaskId) && heldTaskId !== taskId) revisionHistoryByTaskId.delete(heldTaskId);
  }
}

/** The entries a task had at `revision`, while still kept. */
export function entriesAtRevision(taskId: string, revision: number): TranscriptEntry[] | null {
  return revisionHistoryByTaskId.get(taskId)?.find((held) => held.revision === revision)?.entries ?? null;
}

/** Each entry's JSON, made once per entry object. */
const jsonByEntry = new WeakMap<TranscriptEntry, string>();

export function entryJson(entry: TranscriptEntry): string {
  let json = jsonByEntry.get(entry);
  if (json === undefined) {
    json = JSON.stringify(entry);
    jsonByEntry.set(entry, json);
  }
  return json;
}

/**
 * Whether two entries render the same. The same object always does: a parse
 * keeps an unchanged entry's object (`truncateEntries`). Objects made fresh
 * each read (a session boundary, an index-fallback entry, a parser with no
 * incremental path) compare by content when the uuid lines up.
 */
export function sameEntry(left: TranscriptEntry, right: TranscriptEntry): boolean {
  if (left === right) return true;
  if (left.uuid !== right.uuid || left.kind !== right.kind) return false;
  return entryJson(left) === entryJson(right);
}

/** Each assistant entry stamped with the agent of the session it came from,
 *  made once per entry and agent so a re-stitch keeps the same objects. */
const stampedByEntry = new WeakMap<TranscriptEntry, { agentName: string; stamped: TranscriptEntry }>();

export function stampAgent(entry: TranscriptEntry, agentName: string): TranscriptEntry {
  if (entry.kind !== 'assistant') return entry;
  const known = stampedByEntry.get(entry);
  if (known && known.agentName === agentName) return known.stamped;
  const stamped: TranscriptEntry = { ...entry, agentName };
  stampedByEntry.set(entry, { agentName, stamped });
  return stamped;
}

/** Test-only: clear both the file-level transcript cache and the task-level
 *  stitch memo between test cases, AND restore the byte budget, so a case that
 *  lowered it cannot leak a shrunken cap into the next one. */
export function resetForTests(): void {
  resetTranscriptCacheForTests();
  stitchMemoByTaskId.clear();
  revisionHistoryByTaskId.clear();
  nextEntriesArrayToken = 1;
  stitchMemoByteBudget = STITCH_MEMO_BYTE_BUDGET;
}

/** Test-only: current number of tasks retained in the stitch memo, so a test
 *  can assert the `STITCH_MEMO_LIMIT` count cap holds independently of bytes. */
export function stitchMemoSizeForTests(): number {
  return stitchMemoByTaskId.size;
}

/** Test-only: current SOURCE bytes retained across the stitch memo. The byte
 *  cap is the one this module regressed on (a count cap alone, see the memo
 *  above), and a count-based assertion stays green while it is broken, so
 *  tests must assert on this. */
export function stitchMemoBytesForTests(): number {
  return heldBytes(stitchMemoByTaskId, stitchMemoSourceBytes);
}

/** Test-only: shrink the stitch memo's byte budget so eviction can be
 *  exercised against a few KB of fixtures instead of writing 192MB of temp
 *  transcripts. Pass no argument to restore the default. */
export function setStitchMemoBudgetForTests(bytes?: number): void {
  stitchMemoByteBudget = bytes ?? STITCH_MEMO_BYTE_BUDGET;
}

/** Each conversation's extent once: resume rows share a file and its extent. */
function uniqueExtents(resolved: Array<{ resolved: ResolvedTranscript }>): ConversationExtent[] {
  const byConversation = new Map<string, ConversationExtent>();
  for (const { resolved: item } of resolved) {
    if (item.extent && !byConversation.has(item.extent.conversationId)) {
      byConversation.set(item.extent.conversationId, item.extent);
    }
  }
  return [...byConversation.values()];
}

function toSessionMeta(record: SessionRecord, agentName: string): ConversationSessionMeta {
  return {
    sessionId: record.id,
    agentSessionId: record.agent_session_id,
    agentName,
    startedAt: record.started_at,
    exitedAt: record.exited_at,
    isolatedSwimlaneId: record.isolated_swimlane_id,
    status: record.status,
  };
}

/**
 * Resolve a TASK's entire lifecycle: every session it has ever accumulated
 * (a model switch stays within one session, but an agent change, an isolated
 * swimlane move, or an explicit new spawn each create a new `sessions` row),
 * stitched into one chronological timeline with a `session_boundary` divider
 * between sessions. This is unconditional, not a user setting - "the
 * conversation for this task" always means its full history end to end,
 * regardless of what changed mid-task (model, agent, isolation).
 *
 * `anchorSessionId` resolves only WHICH task to show; the returned entries
 * span every session sharing that task_id, oldest first, each assistant entry
 * stamped with the agentName of the session it came from (the response's own
 * top-level agentName only describes the latest one). A session with no
 * task_id (a rare orphan/transient record) has nothing to unify across, so it
 * degrades to just its own entries. Returns null only when the anchor session
 * id resolves to no record at all.
 *
 * DEDUP: a `--resume` session's native transcript REPLAYS its parent session's
 * full history (identical messages, identical per-message uuids), so naively
 * concatenating every session double-counts every shared turn. We deduplicate
 * by `transcriptEntryKey` keeping the FIRST occurrence: the uuid, plus the call
 * a tool result answers, since one record's reply and its results share a
 * uuid. Unique uuids are also what the viewer keys its rows and its virtualizer
 * measurement cache on; a tool result folds into its call's card and is no row
 * of its own, and the row builder drops any repeat uuid that would be.
 *
 * CHRONOLOGY: a session's turns are NOT contiguous in time. A main session is
 * suspended for an isolated-swimlane excursion and then RESUMED into the same
 * transcript, so its post-excursion turns are timestamped AFTER the isolated
 * session's turns. Grouping the timeline by session would bury those newest
 * turns in the middle (and make live growth look frozen). So we merge every
 * deduped turn by its own `ts` and insert a `session_boundary` divider wherever
 * consecutive turns cross a session - including the return to a session seen
 * earlier, not just the switch into an isolated one. The divider reads simply
 * "New session" the first time a session appears and "Resumed session" when the
 * timeline crosses back into one it already showed. The initial run of turns has
 * no leading divider.
 */
export async function resolveTaskTranscript(
  db: Database.Database,
  anchorSessionId: string,
): Promise<ResolvedTaskTranscript | null> {
  const sessionRepo = new SessionRepository(db);
  const anchor = findTranscriptRecord(db, anchorSessionId)?.record ?? null;
  if (!anchor) return null;

  const sessions = anchor.task_id
    ? sessionRepo.listForTaskNewestFirst(anchor.task_id).reverse() // oldest first
    : [anchor];

  /**
   * STAT-ONLY FAST PATH.
   *
   * The loop below resolves EVERY session of the task, and a `--resume`
   * session's JSONL replays its parent's full history, so a task resumed five
   * times is five near-identical files. Measured on a live board: one task
   * held 267MB across five files, and a single Home-feed refresh touched
   * 20 files totalling 319MB - all of it re-read to serve tail requests of a
   * few KB, because the memo below could only be consulted AFTER parsing.
   *
   * The file cache already remembers each session's path/mtime/size, so ask
   * it first: when every contributing file is untouched, the previous stitch
   * is still exactly correct. Only the DB-derived fields (task title, session
   * records) are re-read, and those are sub-millisecond.
   */
  if (anchor.task_id) {
    const memo = stitchMemoByTaskId.get(anchor.task_id);
    if (memo && memo.fileSignatures.length > 0 && memo.fileSignatures.length === sessions.length) {
      const freshness = await Promise.all(memo.fileSignatures.map((signature) => isCachedFileUnchanged(signature)));
      if (freshness.every(Boolean)) {
        {
          touchStitchMemo(anchor.task_id, memo);
          const taskRow = db.prepare('SELECT title FROM tasks WHERE id = ?').get(anchor.task_id) as
            | { title: string }
            | undefined;
          return {
            record: sessions[sessions.length - 1] ?? anchor,
            taskTitle: taskRow?.title ?? '(unknown task)',
            agentName: memo.fileDerived.agentName,
            source: memo.fileDerived.source,
            sourcePath: memo.fileDerived.sourcePath,
            entries: memo.entries,
            degraded: memo.fileDerived.degraded,
            unavailableReason: memo.fileDerived.unavailableReason,
            sessions: sessions.map((session) =>
              toSessionMeta(session, agentRegistry.getBySessionType(session.session_type)?.displayName ?? session.session_type),
            ),
            revision: memo.revision,
            archivedAgentName: memo.fileDerived.archivedAgentName,
            conversations: memo.fileDerived.conversations,
          };
        }
      }
    }
  }

  const sessionMetas: ConversationSessionMeta[] = [];
  const depsParts: string[] = [];
  const resolvedBySession: Array<{ session: SessionRecord; resolved: ResolvedTranscript }> = [];
  let anyDegraded = false;
  let archivedAgentName: string | null = null;
  let latest: ResolvedTranscript | null = null;

  for (const session of sessions) {
    const resolved = await resolveSessionTranscript(db, session.id);
    if (!resolved) continue;
    latest = resolved;
    anyDegraded = anyDegraded || resolved.degraded;
    if (resolved.source === 'archive') archivedAgentName = resolved.agentName;
    sessionMetas.push(toSessionMeta(session, resolved.agentName));
    resolvedBySession.push({ session, resolved });
    depsParts.push(`${session.id}:${tokenForEntries(resolved.entries)}`);
  }

  if (!latest) return null;

  const taskId = anchor.task_id;
  const depsFingerprint = depsParts.join('|');
  const conversations = uniqueExtents(resolvedBySession);

  // The expensive part (dedup by uuid, chronological sort, boundary-divider
  // insertion) is memoized per task: when every contributing session's
  // entries array is unchanged (same reference, per the token above), skip
  // straight to the SAME stitched `entries` array and `revision` - this is
  // what keeps `entries` referentially stable across an idle live-poll tick,
  // letting both the IPC revision short-circuit and the renderer's row
  // reconciler bail out cheaply.
  if (taskId) {
    const memo = stitchMemoByTaskId.get(taskId);
    if (memo && memo.depsFingerprint === depsFingerprint) {
      return {
        record: latest.record,
        taskTitle: latest.taskTitle,
        agentName: latest.agentName,
        source: latest.source,
        sourcePath: latest.sourcePath,
        entries: memo.entries,
        degraded: anyDegraded,
        unavailableReason: latest.unavailableReason,
        sessions: sessionMetas,
        revision: memo.revision,
        archivedAgentName,
        conversations,
      };
    }
  }

  // Collect every deduped turn, tagged with the session that first contributed
  // it (for the chronological merge + transition boundaries below).
  interface TaggedEntry {
    entry: TranscriptEntry;
    sessionId: string;
  }
  let entries: TranscriptEntry[] = [];
  timeSyncWork('transcript:stitch', () => {
    const tagged: TaggedEntry[] = [];
    const seenKeys = new Set<string>();
    for (const { session, resolved } of resolvedBySession) {
      for (const entry of resolved.entries) {
        // A resume replays parent turns verbatim. Keyed so the several entries
        // one record yields (a reply and its tool results) all survive.
        const key = transcriptEntryKey(entry);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        tagged.push({ entry: stampAgent(entry, resolved.agentName), sessionId: session.id });
      }
    }

    // Merge chronologically by each turn's own ts (stable: equal-ts turns keep
    // oldest-session-first order via the index tiebreaker), then walk the sorted
    // turns emitting a boundary at every session crossing.
    const orderedTagged = tagged
      .map((item, index) => ({ item, index }))
      .sort((a, b) => a.item.entry.ts - b.item.entry.ts || a.index - b.index)
      .map((wrapped) => wrapped.item);

    const enteredSessions = new Set<string>();
    let previousSessionId: string | null = null;
    for (const item of orderedTagged) {
      if (previousSessionId !== null && item.sessionId !== previousSessionId) {
        // "Resumed" when the timeline crosses back into a session it already
        // showed (a suspended session picked back up); "New" the first time a
        // session appears.
        const resumed = enteredSessions.has(item.sessionId);
        entries.push({
          kind: 'system',
          // Unique per crossing: the same session can be re-entered (main ->
          // isolated -> main), so the entered session id alone is not unique.
          uuid: `session-boundary-${item.sessionId}-${item.entry.uuid}`,
          ts: item.entry.ts,
          subtype: 'session_boundary',
          text: resumed ? 'Resumed session' : 'New session',
        });
      }
      enteredSessions.add(item.sessionId);
      entries.push(item.entry);
      previousSessionId = item.sessionId;
    }
  });

  // A re-stitch that came out the same (a file touched without new turns, an
  // index fallback rebuilt from the same chunks) keeps its revision and its
  // array, so a poll short-circuits and a viewer is sent nothing.
  const previousMemo = taskId ? stitchMemoByTaskId.get(taskId) : undefined;
  const unchanged = previousMemo !== undefined
    && previousMemo.entries.length === entries.length
    && entries.every((entry, index) => sameEntry(previousMemo.entries[index], entry));
  if (unchanged) entries = previousMemo.entries;
  const revision = taskId ? (unchanged ? previousMemo.revision : (previousMemo?.revision ?? 0) + 1) : 0;
  if (taskId) {
    // Only record file keys when EVERY contributing session has a cached file
    // signature. A session resolved from the index (or with no source at all)
    // has no file to stat, so it cannot be revalidated cheaply - leaving the
    // list empty disables the stat-only fast path for this task rather than
    // letting it return a stitch it cannot prove is current.
    const fileSignatures: Array<{ sourcePath: string; mtimeMs: number; size: number }> = [];
    let everySessionHasFile = resolvedBySession.length === sessions.length;
    for (const { session } of resolvedBySession) {
      const agentSessionId = session.agent_session_id;
      const signature = agentSessionId ? peekCachedFileSignature(session.session_type, agentSessionId) : null;
      if (!signature) {
        everySessionHasFile = false;
        break;
      }
      fileSignatures.push(signature);
    }
    touchStitchMemo(taskId, {
      depsFingerprint,
      revision,
      entries,
      fileSignatures: everySessionHasFile ? fileSignatures : [],
      fileDerived: {
        source: latest.source,
        sourcePath: latest.sourcePath,
        degraded: anyDegraded,
        unavailableReason: latest.unavailableReason,
        agentName: latest.agentName,
        archivedAgentName,
        conversations,
      },
    });
    recordRevision(taskId, revision, entries);
  }

  return {
    record: latest.record,
    taskTitle: latest.taskTitle,
    agentName: latest.agentName,
    source: latest.source,
    sourcePath: latest.sourcePath,
    entries,
    degraded: anyDegraded,
    unavailableReason: latest.unavailableReason,
    sessions: sessionMetas,
    revision,
    archivedAgentName,
    conversations,
  };
}
