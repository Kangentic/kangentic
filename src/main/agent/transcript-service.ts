import type Database from 'better-sqlite3';
import { SessionRepository } from '../db/repositories/session-repository';
import { agentRegistry } from './agent-registry';
import { RetrievalStore } from '../retrieval/retrieval-store';
import type {
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
