import type DatabaseType from 'better-sqlite3';
import type { PerToolStat, TranscriptToolCounts, TranscriptUsage } from '../../../../shared/types';
import { isRecord, openCodeTurnUsage, parseJsonRecord, storeOf, withDatabase } from './transcript-parser';

/**
 * Lifetime token usage and tool calls for one OpenCode session, read from the
 * local `opencode.db` (the store `storeOf` picks: OpenCode 1's `message` and
 * `part` tables, or OpenCode 2's `session_message`).
 *
 * Shapes, from `@opencode-ai/sdk` at v1.18.31 (`AssistantMessage`,
 * `ToolPart`) and the OpenCode 2 records `v2-messages.ts` reads:
 *  - an assistant message's `data` carries `tokens: { input, output,
 *    reasoning, cache: { read, write } }` and `cost`;
 *  - an OpenCode 1 tool part's `data` is `{ type: 'tool', callID, tool, state }`;
 *  - an OpenCode 2 assistant record's `content` holds `{ type: 'tool', id, name }`.
 *
 * The OpenCode 1 tables and fields were checked against a real 1.18.31
 * `opencode.db`; the OpenCode 2 `content` walk was built from the schema.
 */

/** Characters per estimated token, the rate Claude's tool-result estimate uses (`claude/tool-result-tokens.ts`). */
const CHARS_PER_TOKEN = 4;

/**
 * One assistant message's tokens, the way Claude's transcript usage counts
 * them: input is what was sent (fresh input plus the cache read and written),
 * output is what came back (OpenCode keeps reasoning apart from output; both
 * are generated tokens).
 */
function assistantUsage(tokens: unknown): TranscriptUsage | null {
  const usage = openCodeTurnUsage(tokens);
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
    outputTokens: usage.outputTokens,
  };
}

/** Sum every assistant message's tokens. Null when the session has none with usage. */
export function readOpenCodeTranscriptUsageAtPath(dbPath: string, sessionId: string): TranscriptUsage | null {
  return withDatabase<TranscriptUsage | null>(dbPath, null, (database) => {
    // Only `tokens` leaves SQLite, so an OpenCode 2 record's content is never copied out.
    const rows = storeOf(database, sessionId) === 'v2'
      ? database
        .prepare<[string], { tokens: string | null }>(`SELECT json_extract(data, '$.tokens') AS tokens FROM session_message WHERE session_id = ? AND type = 'assistant'`)
        .all(sessionId)
      : database
        .prepare<[string], { tokens: string | null }>(`SELECT json_extract(data, '$.tokens') AS tokens FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'`)
        .all(sessionId);
    let messagesWithUsage = 0;
    const total: TranscriptUsage = { inputTokens: 0, outputTokens: 0 };
    for (const row of rows) {
      const usage = row.tokens ? assistantUsage(parseJsonRecord(row.tokens)) : null;
      if (!usage) continue;
      messagesWithUsage += 1;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
    }
    return messagesWithUsage > 0 ? total : null;
  });
}

/** A time window over `time_created`, both ends optional. */
interface TimeWindow {
  sinceMs?: number | null;
  untilMs?: number | null;
}

function windowClause(window: TimeWindow, column: string): { sql: string; values: number[] } {
  const parts: string[] = [];
  const values: number[] = [];
  if (typeof window.sinceMs === 'number') {
    parts.push(`${column} >= ?`);
    values.push(window.sinceMs);
  }
  if (typeof window.untilMs === 'number') {
    parts.push(`${column} < ?`);
    values.push(window.untilMs);
  }
  return { sql: parts.length > 0 ? ` AND ${parts.join(' AND ')}` : '', values };
}

/** OpenCode 1 tool parts in the window: only the call id and tool name leave SQLite. */
function v1ToolCalls(database: DatabaseType.Database, sessionId: string, window: TimeWindow): Array<{ id: string; name: string }> {
  const clause = windowClause(window, 'time_created');
  const rows = database
    .prepare<Array<string | number>, { callId: unknown; tool: unknown }>(
      `SELECT json_extract(data, '$.callID') AS callId, json_extract(data, '$.tool') AS tool
       FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'${clause.sql}`,
    )
    .all(sessionId, ...clause.values);
  const calls: Array<{ id: string; name: string }> = [];
  for (const row of rows) {
    if (typeof row.callId === 'string' && typeof row.tool === 'string') calls.push({ id: row.callId, name: row.tool });
  }
  return calls;
}

/** Each `{ type: 'tool', id, name, state }` item of OpenCode 2's assistant records in the window, in stored order. */
function* v2ToolItems(database: DatabaseType.Database, sessionId: string, window: TimeWindow): Generator<{ id: string; name: string; state: unknown }> {
  const clause = windowClause(window, 'time_created');
  const rows = database
    .prepare<Array<string | number>, { data: string }>(`SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant'${clause.sql} ORDER BY seq ASC`)
    .all(sessionId, ...clause.values);
  for (const row of rows) {
    const content = parseJsonRecord(row.data)?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (isRecord(item) && item.type === 'tool' && typeof item.id === 'string' && typeof item.name === 'string') {
        yield { id: item.id, name: item.name, state: item.state };
      }
    }
  }
}

/** The text a tool call returned: OpenCode 2's `state.content` text or `state.error.message` (OpenCode 1's is sized in SQL). */
function toolResultText(state: unknown): string {
  if (!isRecord(state)) return '';
  if (typeof state.output === 'string') return state.output;
  if (Array.isArray(state.content)) {
    return state.content.map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : '')).join('');
  }
  if (typeof state.error === 'string') return state.error;
  if (isRecord(state.error) && typeof state.error.message === 'string') return state.error.message;
  return '';
}

/**
 * Estimated result tokens per tool name, for the calls made at or after
 * `sinceMs` and before `untilMs`: each call's returned text at
 * `CHARS_PER_TOKEN` characters a token. A call stored more than once counts
 * once, at its last stored result. Null only when the database cannot be read;
 * a session with no call answers an empty object.
 */
export function readOpenCodeToolResultTokensAtPath(dbPath: string, sessionId: string, window: TimeWindow = {}): Record<string, number> | null {
  return withDatabase<Record<string, number> | null>(dbPath, null, (database) => {
    const resultByCall = new Map<string, { name: string; characters: number }>();
    if (storeOf(database, sessionId) === 'v2') {
      for (const item of v2ToolItems(database, sessionId, window)) {
        resultByCall.set(item.id, { name: item.name, characters: toolResultText(item.state).length });
      }
    } else {
      // Sized in SQLite (`json_extract`), so a session's tool outputs are never
      // copied out and parsed on each of the popover's refetches.
      const clause = windowClause(window, 'time_created');
      const rows = database
        .prepare<Array<string | number>, { callId: unknown; tool: unknown; characters: number | null }>(
          `SELECT json_extract(data, '$.callID') AS callId, json_extract(data, '$.tool') AS tool,
                  length(coalesce(json_extract(data, '$.state.output'), json_extract(data, '$.state.error'), '')) AS characters
           FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'${clause.sql}
           ORDER BY time_created ASC, id ASC`,
        )
        .all(sessionId, ...clause.values);
      for (const row of rows) {
        if (typeof row.callId !== 'string' || typeof row.tool !== 'string') continue;
        resultByCall.set(row.callId, { name: row.tool, characters: row.characters ?? 0 });
      }
    }
    const tokensByName: Record<string, number> = {};
    for (const { name, characters } of resultByCall.values()) {
      tokensByName[name] = (tokensByName[name] ?? 0) + Math.ceil(characters / CHARS_PER_TOKEN);
    }
    return tokensByName;
  });
}

/**
 * Distinct tool calls by name, made at or after `sinceMs` and before
 * `untilMs` (by the stored part's or message's `time_created`). Null when the
 * session has none, so the caller keeps its live count.
 */
export function readOpenCodeToolCountsAtPath(dbPath: string, sessionId: string, window: TimeWindow = {}): TranscriptToolCounts | null {
  return withDatabase<TranscriptToolCounts | null>(dbPath, null, (database) => {
    const calls = storeOf(database, sessionId) === 'v2' ? [...v2ToolItems(database, sessionId, window)] : v1ToolCalls(database, sessionId, window);
    const seen = new Set<string>();
    const countsByName = new Map<string, number>();
    for (const call of calls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      countsByName.set(call.name, (countsByName.get(call.name) ?? 0) + 1);
    }
    if (seen.size === 0) return null;
    const toolBreakdown: PerToolStat[] = [...countsByName]
      .map(([toolName, callCount]) => ({ toolName, callCount, totalDurationMs: 0, interruptedCount: 0 }))
      .sort((first, second) => second.callCount - first.callCount || first.toolName.localeCompare(second.toolName));
    return { toolCallCount: seen.size, toolBreakdown };
  });
}
