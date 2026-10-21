/**
 * The Conversation viewer's history reads: one page of a conversation's
 * earlier (or, after a jump, later) history, the page holding one turn, and a
 * coarse position-to-time map. Runs in the retrieval worker only, one read at
 * a time (`worker/history-read-queue.ts`).
 *
 * The viewer polls each session's newest `MAX_PARSE_SOURCE_BYTES` exactly as
 * before (`resolveTaskTranscript`); these reads are separate calls only the
 * viewer makes, so the phone, `kangentic_get_transcript` and the recap tail
 * read what they always read. Nothing here is cached except the timeline,
 * which is a few dozen numbers per conversation: a page is read, clamped and
 * returned.
 *
 * No agent-name branching: an adapter pages through `readTranscriptPage`, and
 * a conversation whose file is gone pages from Kangentic's archive.
 */
import type Database from 'better-sqlite3';
import { agentRegistry } from './agent-registry';
import type { AgentAdapter, TranscriptPageReadResult } from './agent-adapter';
import { findTranscriptRecord, resolveSessionTranscript, stampAgent } from './transcript-service';
import { truncateEntries } from './transcript-cache';
import { decodeJsonlCursor, encodeJsonlCursor } from './shared/jsonl-history-page';
import { readArchivedPage } from '../retrieval/archive/transcript-archive';
import { touchBounded } from './shared/bounded-lru';
import { SessionRepository } from '../db/repositories/session-repository';
import { HISTORY_PAGE_BYTES } from '../../shared/conversation-history';
import type {
  TranscriptEntry,
  TranscriptHistoryPage,
  TranscriptLocateResponse,
  TranscriptPageDirection,
  TranscriptPageResponse,
  TranscriptTimelineResponse,
} from '../../shared/types';
import { transcriptEntryKey } from '../../shared/types';

export interface HistoryPageRequest {
  conversationId: string;
  direction: TranscriptPageDirection;
  cursor?: string;
  position?: number;
  untilPosition?: number;
  sourceToken?: string;
  /** Test seam: the page's span. The viewer always reads `HISTORY_PAGE_BYTES`. */
  maxBytes?: number;
}

interface ResolvedConversation {
  conversationId: string;
  agentName: string;
  adapter: AgentAdapter | undefined;
  agentSessionId: string | null;
  cwd: string;
}

/** The record behind a conversation id, by its agent session id (or any session id). */
function resolveConversation(db: Database.Database, conversationId: string): ResolvedConversation | null {
  const found = findTranscriptRecord(db, conversationId);
  if (!found) return null;
  const { record } = found;
  const adapter = agentRegistry.getBySessionType(record.session_type);
  return {
    conversationId: record.agent_session_id ?? conversationId,
    agentName: adapter?.displayName ?? record.session_type,
    adapter,
    agentSessionId: record.agent_session_id,
    cwd: record.cwd,
  };
}

/** A page's entries as the tail's are: clamped, stamped with their agent, deduplicated as the stitch does. */
function displayEntries(entries: TranscriptEntry[], agentName: string): TranscriptEntry[] {
  const seen = new Set<string>();
  const result: TranscriptEntry[] = [];
  for (const entry of truncateEntries(entries)) {
    const key = transcriptEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(stampAgent(entry, agentName));
  }
  return result;
}

const ARCHIVE_TOKEN_PREFIX = 'archive:';

/** One page from Kangentic's archive, for a conversation whose file is gone. */
async function readArchivePage(
  db: Database.Database,
  conversation: ResolvedConversation,
  request: HistoryPageRequest,
): Promise<TranscriptPageResponse> {
  let position: number;
  if (request.direction === 'around') {
    position = Math.max(0, request.position ?? 0);
  } else {
    const cursor = decodeJsonlCursor(request.cursor);
    if (!cursor) return { status: 'unavailable', reason: 'file_missing' };
    position = cursor.byte;
  }
  const page = await readArchivedPage(db, conversation.conversationId, request.direction, position);
  if (!page) return { status: 'unavailable', reason: 'file_missing' };
  const sourceToken = `${ARCHIVE_TOKEN_PREFIX}${page.revision}`;
  // A live file's pages and the archive share one byte space, so moving from
  // one to the other is not a reset; an archive rewritten under the caller is.
  if (request.sourceToken?.startsWith(ARCHIVE_TOKEN_PREFIX) && request.sourceToken !== sourceToken) {
    return { status: 'reset', conversationId: conversation.conversationId };
  }
  const until = Math.min(page.totalPosition, request.untilPosition ?? page.totalPosition);
  return {
    status: 'ok',
    conversationId: conversation.conversationId,
    sourceToken,
    startCursor: encodeJsonlCursor({ byte: page.startPosition, line: null }),
    endCursor: encodeJsonlCursor({ byte: page.endPosition, line: null }),
    startPosition: page.startPosition,
    endPosition: page.endPosition,
    totalPosition: page.totalPosition,
    reachedStart: page.reachedStart,
    reachedEnd: page.endPosition >= until,
    entries: displayEntries(page.entries, conversation.agentName),
  };
}

/**
 * One page of a conversation's history: the live source through its adapter,
 * else the archive. Never throws.
 */
export async function readHistoryPage(db: Database.Database, request: HistoryPageRequest): Promise<TranscriptPageResponse> {
  const conversation = resolveConversation(db, request.conversationId);
  if (!conversation) return { status: 'unavailable', reason: 'not_found' };
  let result: TranscriptPageReadResult = { status: 'unavailable', reason: 'unsupported_agent' };
  if (conversation.adapter?.readTranscriptPage && conversation.agentSessionId) {
    try {
      result = await conversation.adapter.readTranscriptPage(conversation.agentSessionId, conversation.cwd, {
        direction: request.direction,
        cursor: request.cursor,
        position: request.position,
        untilPosition: request.untilPosition,
        maxBytes: request.maxBytes ?? HISTORY_PAGE_BYTES,
        // An archive token belongs to the archive, not the live file.
        sourceToken: request.sourceToken?.startsWith(ARCHIVE_TOKEN_PREFIX) ? undefined : request.sourceToken,
      });
    } catch {
      result = { status: 'unavailable', reason: 'read_failed' };
    }
  }
  if (result.status === 'unavailable' && (result.reason === 'file_missing' || result.reason === 'unsupported_agent')) {
    const archived = await readArchivePage(db, conversation, request);
    if (archived.status !== 'unavailable') return archived;
    return result.reason === 'unsupported_agent' ? result : archived;
  }
  if (result.status === 'reset') return { status: 'reset', conversationId: conversation.conversationId };
  if (result.status === 'unavailable') return result;
  return {
    status: 'ok',
    conversationId: conversation.conversationId,
    ...result.page,
    entries: displayEntries(result.page.entries, conversation.agentName),
  };
}

function pageOf(response: TranscriptPageResponse): TranscriptHistoryPage | null {
  if (response.status !== 'ok') return null;
  return {
    conversationId: response.conversationId,
    sourceToken: response.sourceToken,
    startCursor: response.startCursor,
    endCursor: response.endCursor,
    startPosition: response.startPosition,
    endPosition: response.endPosition,
    totalPosition: response.totalPosition,
    reachedStart: response.reachedStart,
    reachedEnd: response.reachedEnd,
    entries: response.entries,
  };
}

/** Positions sampled per timeline. */
const TIMELINE_PROBES = 64;
/** Bytes read per probe at most: enough for a record or two of a large file. */
const TIMELINE_PROBE_MAX_BYTES = 64 * 1024;
/** Bytes read per probe at least, so a probe of a small file still reaches a whole line. */
const TIMELINE_PROBE_MIN_BYTES = 1024;

/** A probe's span: about one probe's share of the file, so probes of a small
 *  file do not all read the same first lines. */
function timelineProbeBytes(totalPosition: number): number {
  return Math.max(TIMELINE_PROBE_MIN_BYTES, Math.min(TIMELINE_PROBE_MAX_BYTES, Math.floor(totalPosition / TIMELINE_PROBES)));
}

interface CachedTimeline {
  sourceToken: string;
  totalPosition: number;
  samples: Array<{ position: number; ts: number }>;
}

/** Timelines by conversation. A few dozen numbers each, so the count bound binds first. */
const timelineByConversation = new Map<string, CachedTimeline>();
const timelineCacheOptions = {
  limit: 32,
  byteBudget: 1024 * 1024,
  // Two numbers a sample, eight bytes each.
  sizeOf: (timeline: CachedTimeline) => timeline.samples.length * 16,
  minRetained: 1,
};

/**
 * How long one timeline build may probe, the budget a locate call has. A probe
 * skips any line longer than itself, so a file of huge lines could otherwise
 * hold the history queue for 64 page budgets.
 */
const TIMELINE_MAX_MS = 6_000;

/** A cached timeline is reused until the source has grown by this factor. */
const TIMELINE_REUSE_GROWTH = 1.25;

/**
 * A coarse position-to-time map of one conversation, for the scrollbar's drag
 * label and for finding a turn by its time: 64 probes of at most 64 KiB through
 * the adapter's page read, at most about 4 MiB of reads. Reused while the source keeps its
 * token and has grown less than a quarter since, since an append moves no
 * earlier sample. A build cut short by `deadline` answers the samples it has
 * and is not cached.
 */
export async function readHistoryTimeline(
  db: Database.Database,
  conversationId: string,
  deadline: number = Date.now() + TIMELINE_MAX_MS,
): Promise<TranscriptTimelineResponse> {
  const conversation = resolveConversation(db, conversationId);
  if (!conversation) return { status: 'unavailable', reason: 'not_found' };
  const { adapter, agentSessionId } = conversation;
  if (!adapter?.readTranscriptPage || !agentSessionId || adapter.transcriptHasTimestamps === false) {
    return { status: 'unavailable', reason: 'unsupported_agent' };
  }
  const resolved = await resolveSessionTranscript(db, conversationId);
  const totalPosition = resolved?.extent?.totalPosition ?? 0;
  if (!resolved || resolved.source !== 'live' || totalPosition <= 0) {
    return { status: 'unavailable', reason: 'file_missing' };
  }

  const cached = timelineByConversation.get(conversation.conversationId);
  if (cached && totalPosition >= cached.totalPosition && totalPosition < cached.totalPosition * TIMELINE_REUSE_GROWTH) {
    // A probe-sized read, never a tiny one: a page skips any line longer than
    // itself, so a 1-byte check walked the whole file a byte at a time and held
    // the worker's history queue until main killed the worker.
    const check = await adapter.readTranscriptPage(agentSessionId, conversation.cwd, {
      direction: 'around', position: 0, maxBytes: timelineProbeBytes(totalPosition), sourceToken: cached.sourceToken, probe: true,
    });
    if (check.status !== 'reset') {
      touchBounded(timelineByConversation, conversation.conversationId, cached, timelineCacheOptions);
      return { status: 'ok', conversationId: conversation.conversationId, samples: cached.samples };
    }
  }

  const samples: Array<{ position: number; ts: number }> = [];
  let sourceToken: string | null = null;
  let complete = true;
  const probeBytes = timelineProbeBytes(totalPosition);
  for (let probe = 0; probe < TIMELINE_PROBES; probe += 1) {
    if (Date.now() >= deadline) {
      complete = false;
      break;
    }
    const position = Math.floor((totalPosition * probe) / TIMELINE_PROBES);
    const result = await adapter.readTranscriptPage(agentSessionId, conversation.cwd, {
      direction: 'around', position, maxBytes: probeBytes, untilPosition: totalPosition, probe: true,
    });
    if (result.status !== 'ok') continue;
    sourceToken ??= result.page.sourceToken;
    const dated = result.page.entries.find((entry) => entry.ts > 0);
    if (!dated) continue;
    const samplePosition = dated.origin?.position ?? result.page.startPosition;
    if (samples.length === 0 || samplePosition > samples[samples.length - 1].position) {
      samples.push({ position: samplePosition, ts: dated.ts });
    }
  }
  // The tail's own first dated entry pins the map's newest end exactly.
  const tailDated = resolved.entries.find((entry) => entry.ts > 0 && entry.origin);
  if (tailDated?.origin && (samples.length === 0 || tailDated.origin.position > samples[samples.length - 1].position)) {
    samples.push({ position: tailDated.origin.position, ts: tailDated.ts });
  }
  if (sourceToken && complete) {
    touchBounded(timelineByConversation, conversation.conversationId, { sourceToken, totalPosition, samples }, timelineCacheOptions);
  }
  return { status: 'ok', conversationId: conversation.conversationId, samples };
}

/** The position a time falls at, interpolated between the timeline's samples. */
function positionForTime(samples: Array<{ position: number; ts: number }>, ts: number): number | null {
  if (samples.length === 0) return null;
  if (ts <= samples[0].ts) return samples[0].position;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const next = samples[index];
    if (ts <= next.ts) {
      const span = next.ts - previous.ts;
      const fraction = span > 0 ? (ts - previous.ts) / span : 0;
      return Math.round(previous.position + fraction * (next.position - previous.position));
    }
  }
  return samples[samples.length - 1].position;
}

/** Bounds on the fallback walk for a turn the timeline did not land on. */
const LOCATE_WALK_MAX_BYTES = 512 * 1024 * 1024;
/**
 * One deadline for a whole locate call, every conversation together. The queue
 * lets a read start up to `maxWaitMs` (5 s) late and main gives the call 15 s,
 * so 6 s of work plus one page read past the deadline stays well inside it. A
 * call that ran into main's timer would kill the worker.
 */
const LOCATE_MAX_MS = 6_000;
/** Conversations of a task tried when a hit names none. */
const LOCATE_MAX_CONVERSATIONS = 3;

export interface LocateRequest {
  /** Any session of the task (Kangentic or agent id). */
  sessionId: string;
  turnUuid: string;
  turnTs?: number | null;
  chunkId?: number | null;
}

/** The conversation and time a search hit's chunk records, when it records them. */
function chunkFacts(db: Database.Database, chunkId: number): { conversationId: string; ts: number | null } | null {
  try {
    const row = db.prepare('SELECT agent_session_id AS conversationId, ts_start AS ts FROM memory_chunks WHERE id = ?')
      .get(chunkId) as { conversationId: string | null; ts: number | null } | undefined;
    return row?.conversationId ? { conversationId: row.conversationId, ts: row.ts } : null;
  } catch {
    return null;
  }
}

/**
 * The conversation and time the index records for a turn, for a hit that
 * carries only its uuid (the palette hands the window nothing else). A chunk
 * opens at the turn a hit lands on, so its first turn names it. The uuid column
 * has no index and the table holds every chunk's text, so the read goes through
 * `idx_memory_chunks_session` over the task's own sessions.
 */
function turnFacts(db: Database.Database, sessionId: string, turnUuid: string): { conversationId: string; ts: number | null } | null {
  try {
    const anchor = findTranscriptRecord(db, sessionId)?.record;
    if (!anchor) return null;
    const sessionIds = (anchor.task_id ? new SessionRepository(db).listForTaskNewestFirst(anchor.task_id) : [anchor])
      .map((session) => session.id);
    if (sessionIds.length === 0) return null;
    const row = db.prepare(
      `SELECT agent_session_id AS conversationId, ts_start AS ts FROM memory_chunks
       WHERE session_id IN (${sessionIds.map(() => '?').join(', ')})
         AND turn_uuid_start = ? AND agent_session_id IS NOT NULL
       LIMIT 1`,
    ).get(...sessionIds, turnUuid) as { conversationId: string; ts: number | null } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** The task's conversations, newest first, once each. */
function taskConversations(db: Database.Database, sessionId: string): string[] {
  const anchor = findTranscriptRecord(db, sessionId)?.record;
  if (!anchor) return [];
  const sessions = anchor.task_id ? new SessionRepository(db).listForTaskNewestFirst(anchor.task_id) : [anchor];
  const conversations: string[] = [];
  for (const session of sessions) {
    if (session.agent_session_id && !conversations.includes(session.agent_session_id)) {
      conversations.push(session.agent_session_id);
    }
  }
  return conversations;
}

function holds(page: TranscriptHistoryPage | null, turnUuid: string): boolean {
  return !!page && page.entries.some((entry) => entry.uuid === turnUuid);
}

/**
 * The page holding one turn, for a search palette hit in history the viewer
 * has not loaded: `in_tail` when the polled tail already holds it. Narrows by
 * the turn's time through the timeline, checks the page there and one each
 * side, then walks back from the tail page by page within a read and time
 * budget. Never throws.
 */
export async function locateHistoryTurn(db: Database.Database, request: LocateRequest): Promise<TranscriptLocateResponse> {
  const startedAt = Date.now();
  const outOfTime = (): boolean => Date.now() - startedAt >= LOCATE_MAX_MS;
  const fromChunk = request.chunkId != null
    ? chunkFacts(db, request.chunkId)
    : turnFacts(db, request.sessionId, request.turnUuid);
  const turnTs = request.turnTs ?? fromChunk?.ts ?? null;
  const conversations = fromChunk
    ? [fromChunk.conversationId]
    : taskConversations(db, request.sessionId).slice(0, LOCATE_MAX_CONVERSATIONS);

  for (const conversationId of conversations) {
    if (outOfTime()) break;
    const resolved = await resolveSessionTranscript(db, conversationId);
    if (!resolved) continue;
    if (resolved.entries.some((entry) => entry.uuid === request.turnUuid)) return { status: 'in_tail' };
    const extent = resolved.extent;
    if (!extent?.pageable || extent.tailStartPosition <= 0) continue;
    const until = extent.tailStartPosition;

    if (turnTs !== null && extent.hasTimestamps) {
      // The timeline shares the locate call's deadline rather than adding its own.
      const timeline = await readHistoryTimeline(db, conversationId, startedAt + LOCATE_MAX_MS);
      const position = timeline.status === 'ok' ? positionForTime(timeline.samples, turnTs) : null;
      if (position !== null && !outOfTime()) {
        const around = pageOf(await readHistoryPage(db, {
          conversationId, direction: 'around', position: Math.min(position, until), untilPosition: until,
        }));
        if (holds(around, request.turnUuid)) return { status: 'found', page: around! };
        if (around && !around.reachedStart && !outOfTime()) {
          const before = pageOf(await readHistoryPage(db, { conversationId, direction: 'before', cursor: around.startCursor, untilPosition: until }));
          if (holds(before, request.turnUuid)) return { status: 'found', page: before! };
        }
        if (around && !around.reachedEnd && !outOfTime()) {
          const after = pageOf(await readHistoryPage(db, { conversationId, direction: 'after', cursor: around.endCursor, untilPosition: until }));
          if (holds(after, request.turnUuid)) return { status: 'found', page: after! };
        }
      }
    }

    // The timeline missed (timestamps out of order, or none): walk back from
    // the tail one page at a time, within a budget.
    const marker = resolved.entries.find((entry) => entry.kind === 'system' && entry.subtype === 'truncated' && entry.earlierHistory);
    let cursor = marker?.kind === 'system' ? marker.earlierHistory?.cursor : undefined;
    let walked = 0;
    while (cursor && walked < LOCATE_WALK_MAX_BYTES && !outOfTime()) {
      const page = pageOf(await readHistoryPage(db, { conversationId, direction: 'before', cursor, untilPosition: until }));
      if (!page) break;
      if (holds(page, request.turnUuid)) return { status: 'found', page };
      if (page.reachedStart || page.startPosition >= page.endPosition) break;
      walked += page.endPosition - page.startPosition;
      cursor = page.startCursor;
    }
  }
  return { status: 'not_found' };
}

/** Test-only: forget every timeline. */
export function resetHistoryTimelinesForTests(): void {
  timelineByConversation.clear();
}
