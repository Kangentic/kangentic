import type Database from 'better-sqlite3';
import { SessionRepository } from '../db/repositories/session-repository';
import { agentRegistry } from './agent-registry';
import { RetrievalStore } from '../retrieval/retrieval-store';
import {
  clampSpan,
  getCachedTranscript,
  resetForTests as resetTranscriptCacheForTests,
} from './transcript-cache';
import type {
  ConversationSessionMeta,
  SessionRecord,
  TranscriptEntry,
  TranscriptSource,
  TranscriptUnavailableReason,
} from '../../shared/types';

export interface ResolvedTranscript {
  record: SessionRecord;
  taskTitle: string;
  agentName: string;
  source: TranscriptSource;
  sourcePath: string | null;
  entries: TranscriptEntry[];
  degraded: boolean;
  unavailableReason?: TranscriptUnavailableReason;
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
}

/** Reconstruct lossy display entries from indexed chunks when the native
 *  history file is gone. Block structure is not recoverable, so each chunk maps
 *  to a single-block entry of its recorded role. */
function entriesFromIndex(db: Database.Database, docId: string): TranscriptEntry[] {
  const store = new RetrievalStore(db);
  const chunks = store.getChunksForDoc('conversation', docId);
  return chunks.map((chunk) => {
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
 * Resolve a session's structured conversation for the viewer. Live-parse
 * primary (freshest, full block structure), indexed-chunk fallback when the
 * native history has been pruned, `source: 'none'` when neither is available.
 * Returns null only when the session id resolves to no record.
 *
 * No agent-name branching: the structured-parse capability is read from the
 * adapter (agent-adapters-boundary).
 */
export async function resolveSessionTranscript(
  db: Database.Database,
  sessionId: string,
): Promise<ResolvedTranscript | null> {
  const sessionRepo = new SessionRepository(db);
  const record = sessionRepo.findByAnyId(sessionId);
  if (!record) return null;

  const taskRow = db.prepare('SELECT title FROM tasks WHERE id = ?').get(record.task_id) as
    | { title: string }
    | undefined;
  const taskTitle = taskRow?.title ?? '(unknown task)';
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
    let entries: TranscriptEntry[] = [];
    let sourcePath: string | null = null;
    try {
      const cached = await getCachedTranscript(
        record.session_type,
        agentSessionId,
        () => adapter.parseTranscript!(agentSessionId, record.cwd),
      );
      entries = cached.entries;
      sourcePath = cached.sourcePath;
    } catch (error) {
      // A genuine parser failure (permission error, corrupt JSONL, adapter
      // regression) must not look identical to "session has no transcript yet":
      // log it, then fall through to the index fallback.
      console.warn(`transcript live-parse failed for session ${agentSessionId}:`, error);
      entries = [];
    }
    if (entries.length > 0) {
      // Already truncated inside the cache.
      return { ...base, source: 'live', sourcePath, entries, degraded: false };
    }
    // Native file located but empty/pruned: try the index fallback.
    const indexed = entriesFromIndex(db, record.agent_session_id ?? record.id);
    if (indexed.length > 0) {
      return { ...base, source: 'index', sourcePath, entries: indexed, degraded: true };
    }
    return {
      ...base,
      source: 'none',
      sourcePath,
      entries: [],
      degraded: false,
      unavailableReason: 'file_missing',
    };
  }

  // No structured parser, or no agent_session_id yet: index fallback, else none.
  const indexed = entriesFromIndex(db, record.agent_session_id ?? record.id);
  if (indexed.length > 0) {
    return { ...base, source: 'index', sourcePath: null, entries: indexed, degraded: true };
  }
  return {
    ...base,
    source: 'none',
    sourcePath: null,
    entries: [],
    degraded: false,
    unavailableReason: adapter?.parseTranscript ? 'no_agent_session_id' : 'unsupported_agent',
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
}

/** Task-level stitch memo, capped so a long-running app does not grow this
 *  unbounded across many opened tasks. */
const STITCH_MEMO_LIMIT = 64;
const stitchMemoByTaskId = new Map<string, StitchMemoRecord>();

function touchStitchMemo(taskId: string, record: StitchMemoRecord): void {
  stitchMemoByTaskId.delete(taskId);
  stitchMemoByTaskId.set(taskId, record);
  while (stitchMemoByTaskId.size > STITCH_MEMO_LIMIT) {
    const oldestTaskId = stitchMemoByTaskId.keys().next().value;
    if (oldestTaskId === undefined) break;
    stitchMemoByTaskId.delete(oldestTaskId);
  }
}

/** Test-only: clear both the file-level transcript cache and the task-level
 *  stitch memo between test cases. */
export function resetForTests(): void {
  resetTranscriptCacheForTests();
  stitchMemoByTaskId.clear();
  nextEntriesArrayToken = 1;
}

function toSessionMeta(record: SessionRecord, agentName: string): ConversationSessionMeta {
  return {
    sessionId: record.id,
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
 * by uuid keeping the FIRST occurrence. Unique uuids are also what the viewer
 * keys its rows and its virtualizer measurement cache on, so a duplicate would
 * otherwise break React reconciliation and stack rows on top of each other.
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
  const anchor = sessionRepo.findByAnyId(anchorSessionId);
  if (!anchor) return null;

  const sessions = anchor.task_id
    ? sessionRepo.listForTaskNewestFirst(anchor.task_id).reverse() // oldest first
    : [anchor];

  const sessionMetas: ConversationSessionMeta[] = [];
  const depsParts: string[] = [];
  const resolvedBySession: Array<{ session: SessionRecord; resolved: ResolvedTranscript }> = [];
  let anyDegraded = false;
  let latest: ResolvedTranscript | null = null;

  for (const session of sessions) {
    const resolved = await resolveSessionTranscript(db, session.id);
    if (!resolved) continue;
    latest = resolved;
    anyDegraded = anyDegraded || resolved.degraded;
    sessionMetas.push(toSessionMeta(session, resolved.agentName));
    resolvedBySession.push({ session, resolved });
    depsParts.push(`${session.id}:${tokenForEntries(resolved.entries)}`);
  }

  if (!latest) return null;

  const taskId = anchor.task_id;
  const depsFingerprint = depsParts.join('|');

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
      };
    }
  }

  // Collect every deduped turn, tagged with the session that first contributed
  // it (for the chronological merge + transition boundaries below).
  interface TaggedEntry {
    entry: TranscriptEntry;
    sessionId: string;
  }
  const tagged: TaggedEntry[] = [];
  const seenUuids = new Set<string>();
  for (const { session, resolved } of resolvedBySession) {
    for (const entry of resolved.entries) {
      if (seenUuids.has(entry.uuid)) continue; // a resume replays parent turns verbatim
      seenUuids.add(entry.uuid);
      tagged.push({
        entry: entry.kind === 'assistant' ? { ...entry, agentName: resolved.agentName } : entry,
        sessionId: session.id,
      });
    }
  }

  // Merge chronologically by each turn's own ts (stable: equal-ts turns keep
  // oldest-session-first order via the index tiebreaker), then walk the sorted
  // turns emitting a boundary at every session crossing.
  const orderedTagged = tagged
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.entry.ts - b.item.entry.ts || a.index - b.index)
    .map((wrapped) => wrapped.item);

  const entries: TranscriptEntry[] = [];
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

  const revision = taskId ? (stitchMemoByTaskId.get(taskId)?.revision ?? 0) + 1 : 0;
  if (taskId) {
    touchStitchMemo(taskId, { depsFingerprint, revision, entries });
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
  };
}
