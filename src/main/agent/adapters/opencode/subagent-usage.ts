import type DatabaseType from 'better-sqlite3';
import type { ParsedSubagentUsage, SubagentSpawnLink, SubagentTranscriptSignature, SubagentUsageTurn } from '../../agent-adapter';
import { isRecord, openCodeTurnUsage, parseJsonRecord, withDatabase } from './transcript-parser';

/**
 * An OpenCode 1 session's `task` subagents, read from `opencode.db`.
 *
 * OpenCode's `task` tool runs a subagent in a CHILD session: it creates the
 * session with `parentID` set to the calling session, and its part's
 * `state.metadata.sessionId` names the child (`packages/opencode/src/tool/task.ts`
 * at v1.18.31). The child's row in the `session` table carries that parent in
 * `parent_id` (`packages/core/src/session/sql.ts`), and its messages and parts
 * are in `message` and `part` like any session's. A subagent may spawn its own,
 * so the children are walked to every depth. These tables and fields were
 * checked against a real 1.18.31 `opencode.db`.
 *
 * OpenCode 2 keeps its sessions in `session_v2`, which has a `parent_id` too,
 * but its child messages and `task` records have not been read, so an
 * OpenCode 2 session reports no subagents.
 */

/** The deepest a subagent chain is followed. */
const MAX_DEPTH = 8;

interface ChildSession {
  id: string;
  depth: number;
}

/** Every session under `sessionId`, nearest first. An OpenCode 1 database only. */
function childSessions(database: DatabaseType.Database, sessionId: string): ChildSession[] {
  let statement: DatabaseType.Statement<[string], { id: string }>;
  try {
    statement = database.prepare<[string], { id: string }>('SELECT id FROM session WHERE parent_id = ? ORDER BY time_created ASC, id ASC');
  } catch (error) {
    // A database with no `session` table (or no `parent_id`) has no subagents to read.
    if (error instanceof Error && /no such (table|column)/i.test(error.message)) return [];
    throw error;
  }
  const children: ChildSession[] = [];
  let frontier: ChildSession[] = [{ id: sessionId, depth: 0 }];
  const seen = new Set([sessionId]);
  while (frontier.length > 0) {
    const next: ChildSession[] = [];
    for (const parent of frontier) {
      if (parent.depth >= MAX_DEPTH) continue;
      for (const row of statement.all(parent.id)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        next.push({ id: row.id, depth: parent.depth + 1 });
      }
    }
    children.push(...next);
    frontier = next;
  }
  return children;
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/**
 * Staleness signature for a session's subagents: how many there are, the bytes
 * of their stored messages and parts, and the newest update. Null when the
 * session has none, or the database cannot be read. Synchronous, and the hang
 * check calls it on the main thread, so the size is `octet_length`, which
 * SQLite reads from each row's header without loading the value (a
 * character `length` would read every tool output).
 */
export function statOpenCodeSubagentsAtPath(dbPath: string, sessionId: string): SubagentTranscriptSignature | null {
  return withDatabase<SubagentTranscriptSignature | null>(dbPath, null, (database) => {
    const children = childSessions(database, sessionId);
    if (children.length === 0) return null;
    const ids = children.map((child) => child.id);
    const inList = placeholders(ids.length);
    const messages = database
      .prepare<string[], { size: number | null; newest: number | null }>(
        `SELECT SUM(octet_length(data)) AS size, MAX(time_updated) AS newest FROM message WHERE session_id IN (${inList})`,
      )
      .get(...ids);
    const parts = database
      .prepare<string[], { size: number | null; newest: number | null }>(
        `SELECT SUM(octet_length(data)) AS size, MAX(time_updated) AS newest FROM part WHERE session_id IN (${inList})`,
      )
      .get(...ids);
    return {
      fileCount: children.length,
      totalSize: (messages?.size ?? 0) + (parts?.size ?? 0),
      maxMtimeMs: Math.max(messages?.newest ?? 0, parts?.newest ?? 0),
    };
  });
}

/** One `task` call: its id, the message that made it, the child session it ran, and its subagent type. */
interface TaskCall {
  callId: string;
  messageId: string;
  childId: string | null;
  agentType: string | null;
}

/** The `task` calls in these sessions. */
function taskCalls(database: DatabaseType.Database, sessionIds: string[]): TaskCall[] {
  if (sessionIds.length === 0) return [];
  // Filtered and picked in SQLite, so no other part (a tool's output) is copied out and parsed.
  const rows = database
    .prepare<string[], { message_id: string; callId: unknown; childId: unknown; agentType: unknown }>(
      `SELECT message_id, json_extract(data, '$.callID') AS callId,
              json_extract(data, '$.state.metadata.sessionId') AS childId,
              json_extract(data, '$.state.input.subagent_type') AS agentType
       FROM part WHERE session_id IN (${placeholders(sessionIds.length)})
         AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.tool') = 'task'`,
    )
    .all(...sessionIds);
  const calls: TaskCall[] = [];
  for (const row of rows) {
    if (typeof row.callId !== 'string') continue;
    calls.push({
      callId: row.callId,
      messageId: row.message_id,
      childId: typeof row.childId === 'string' ? row.childId : null,
      agentType: typeof row.agentType === 'string' ? row.agentType : null,
    });
  }
  return calls;
}

/**
 * Each subagent answer's tokens, one turn per assistant message (OpenCode
 * stores a message once and updates it in place, so there is nothing to fold),
 * keyed by the message id, which no main-thread turn shares. A turn names its
 * child session as the subagent, the `task` call that spawned it, and the
 * subagent's type from that call's `subagent_type`. The `task` calls the
 * subagents make are the spawn links. An answer with no tokens is left out.
 */
export function readOpenCodeSubagentUsageAtPath(dbPath: string, sessionId: string): ParsedSubagentUsage {
  const unread: ParsedSubagentUsage = { directoryPresent: false, complete: false, sourcePath: dbPath, turns: [], spawnLinks: [] };
  return withDatabase<ParsedSubagentUsage>(dbPath, unread, (database) => {
    const children = childSessions(database, sessionId);
    if (children.length === 0) return { directoryPresent: false, complete: true, sourcePath: dbPath, turns: [], spawnLinks: [] };
    const childIds = children.map((child) => child.id);

    // The calls that spawned these children are in their parents: the main
    // session and every child that spawned one of its own.
    const spawningCalls = taskCalls(database, [sessionId, ...childIds]);
    const spawnByChild = new Map<string, { callId: string; agentType: string | null }>();
    for (const call of spawningCalls) {
      if (call.childId) spawnByChild.set(call.childId, { callId: call.callId, agentType: call.agentType });
    }
    const subagentMessageIds = new Set<string>();
    const turns: SubagentUsageTurn[] = [];
    const childMessages = database.prepare<[string], { id: string; time_created: number; data: string }>(
      'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC',
    );
    for (const child of children) {
      const spawn = spawnByChild.get(child.id) ?? null;
      for (const row of childMessages.all(child.id)) {
        subagentMessageIds.add(row.id);
        const data = parseJsonRecord(row.data);
        if (!data || data.role !== 'assistant') continue;
        const usage = openCodeTurnUsage(data.tokens);
        if (!usage || usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens === 0) continue;
        const created = isRecord(data.time) && typeof data.time.created === 'number' ? data.time.created : row.time_created;
        turns.push({
          turnUuid: row.id,
          subagentId: child.id,
          agentType: spawn?.agentType ?? (typeof data.mode === 'string' ? data.mode : null),
          spawnDepth: child.depth,
          parentToolUseId: spawn?.callId ?? null,
          ts: typeof created === 'number' ? created : null,
          model: typeof data.modelID === 'string' ? data.modelID : null,
          usage,
        });
      }
    }

    // A link is a `task` call a SUBAGENT made, whatever its turn's usage.
    const spawnLinks: SubagentSpawnLink[] = [];
    for (const call of spawningCalls) {
      if (subagentMessageIds.has(call.messageId)) spawnLinks.push({ toolUseId: call.callId, turnUuid: call.messageId });
    }
    return { directoryPresent: true, complete: true, sourcePath: dbPath, turns, spawnLinks };
  });
}
