import type Database from 'better-sqlite3';
import { SessionRepository } from '../db/repositories/session-repository';
import { agentRegistry } from './agent-registry';
import { RetrievalStore } from '../retrieval/retrieval-store';
import type {
  ConversationSessionMeta,
  SessionRecord,
  TranscriptEntry,
  TranscriptSource,
  TranscriptUnavailableReason,
} from '../../shared/types';

/** Per-block/content clamp so a multi-MB transcript never ships whole over IPC
 *  into React state. Individual spans over this are truncated with a marker. */
const MAX_SPAN_CHARS = 20_000;

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
 *  polling watches; `entries` and `sessions` span all of them. */
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
}

function clampSpan(text: string): string {
  if (text.length <= MAX_SPAN_CHARS) return text;
  return `${text.slice(0, MAX_SPAN_CHARS)}\n[truncated ${text.length - MAX_SPAN_CHARS} chars]`;
}

/** Apply the per-span clamp across every entry's text/blocks/content. */
function truncateEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) => {
    switch (entry.kind) {
      case 'user':
        return { ...entry, text: clampSpan(entry.text) };
      case 'assistant':
        return {
          ...entry,
          blocks: entry.blocks.map((block) =>
            block.type === 'tool_use' ? block : { ...block, text: clampSpan(block.text) },
          ),
        };
      case 'tool_result':
        return { ...entry, content: clampSpan(entry.content) };
      case 'system':
        return { ...entry, text: clampSpan(entry.text) };
    }
  });
}

/** Reconstruct lossy display entries from indexed chunks when the native
 *  history file is gone. Block structure is not recoverable, so each chunk maps
 *  to a single-block entry of its recorded role. */
function entriesFromIndex(db: Database.Database, sessionId: string): TranscriptEntry[] {
  const store = new RetrievalStore(db);
  const chunks = store.getChunksForDoc('conversation', sessionId);
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

  // Live parse via the adapter's structured-parse capability.
  if (adapter?.parseTranscript && record.agent_session_id) {
    let entries: TranscriptEntry[] = [];
    let sourcePath: string | null = null;
    try {
      const parsed = await adapter.parseTranscript(record.agent_session_id, record.cwd);
      entries = parsed.entries;
      sourcePath = parsed.sourcePath;
    } catch {
      entries = [];
    }
    if (entries.length > 0) {
      return { ...base, source: 'live', sourcePath, entries: truncateEntries(entries), degraded: false };
    }
    // Native file located but empty/pruned: try the index fallback.
    const indexed = entriesFromIndex(db, record.id);
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
  const indexed = entriesFromIndex(db, record.id);
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

  // Swimlane names for a readable boundary message ("isolated: Executing").
  const swimlaneIds = [
    ...new Set(
      sessions
        .map((session) => session.isolated_swimlane_id)
        .filter((id): id is string => id !== null),
    ),
  ];
  const swimlaneNames = new Map<string, string>();
  if (swimlaneIds.length > 0) {
    const placeholders = swimlaneIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, name FROM swimlanes WHERE id IN (${placeholders})`)
      .all(...swimlaneIds) as Array<{ id: string; name: string }>;
    for (const row of rows) swimlaneNames.set(row.id, row.name);
  }

  const entries: TranscriptEntry[] = [];
  const sessionMetas: ConversationSessionMeta[] = [];
  let anyDegraded = false;
  let latest: ResolvedTranscript | null = null;

  for (const [index, session] of sessions.entries()) {
    const resolved = await resolveSessionTranscript(db, session.id);
    if (!resolved) continue;
    latest = resolved;
    anyDegraded = anyDegraded || resolved.degraded;
    sessionMetas.push(toSessionMeta(session, resolved.agentName));

    if (index > 0) {
      const swimlaneLabel = session.isolated_swimlane_id
        ? ` (isolated: ${swimlaneNames.get(session.isolated_swimlane_id) ?? 'unknown column'})`
        : '';
      entries.push({
        kind: 'system',
        uuid: `session-boundary-${session.id}`,
        ts: new Date(session.started_at).getTime(),
        subtype: 'session_boundary',
        text: `New session - ${resolved.agentName}${swimlaneLabel}`,
      });
    }

    for (const entry of resolved.entries) {
      entries.push(entry.kind === 'assistant' ? { ...entry, agentName: resolved.agentName } : entry);
    }
  }

  if (!latest) return null;

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
  };
}
