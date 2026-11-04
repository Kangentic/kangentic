import type DatabaseType from 'better-sqlite3';
import fs from 'node:fs';
import type { PerToolStat, TranscriptBlock, TranscriptEntry, TranscriptToolCounts, TranscriptUsage } from '../../../../shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../agent-adapter';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { findGooseSession, withGooseDatabase } from './session-store';

/**
 * A Goose session's conversation out of its `messages` rows (`session-store.ts`
 * says where the database is and how a session is found).
 *
 * `content_json` holds the message's content blocks, tagged by `type` in
 * camelCase (Goose's source at 1.57.0,
 * `crates/goose-provider-types/src/conversation/message.rs`):
 * - `text` {text}
 * - `thinking` {thinking}, or `reasoning` {text} in a row an older Goose wrote,
 *   which Goose's own reader turns into `thinking`
 * - `toolRequest` {id, toolCall: {status: "success", value: {name, arguments}}}
 * - `toolResponse` {id, toolResult: {status: "success", value: {content: [{type: "text", text}], isError}}}
 *   or `{status: "error", error}` when the call failed outright
 * and others (`image`, `redactedThinking`, `toolConfirmationRequest`,
 * `systemNotification`, ...) that the viewer has no row for. A tool's response
 * arrives in the next user-role message, as the model APIs Goose speaks expect.
 * `metadata_json`'s `userVisible: false` marks a message Goose keeps for the
 * model only (a compaction summary); the viewer skips it, as Goose's own does.
 *
 * Built from Goose's source; no real Goose database was read.
 *
 * Positions are the bytes of `content_json`, in message order, the unit the
 * page and tail budgets are in: the Conversation viewer places an entry on a
 * scrollbar spanning the whole session by them. SQLite's `octet_length()`
 * answers a value's size from the record header without reading the text,
 * where `length()` on TEXT must read every character to count them, so sizing
 * a session costs no read of its messages. A cursor names a message by its row
 * id, which only grows.
 */

/** One `messages` row as read. */
export interface GooseMessageRow {
  id: number;
  role: string;
  content_json: string;
  created_timestamp: number;
  metadata_json?: string | null;
}

/** Goose stores seconds, but treats values above 1e10 as milliseconds (session_manager.rs). */
const MILLISECOND_TIMESTAMP_THRESHOLD = 10_000_000_000;

/** A `created_timestamp` as epoch milliseconds. */
export function gooseTimestampMs(createdTimestamp: number): number {
  return createdTimestamp > MILLISECOND_TIMESTAMP_THRESHOLD ? createdTimestamp : createdTimestamp * 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentBlocks(contentJson: string): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(contentJson);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function isUserVisible(metadataJson: string | null | undefined): boolean {
  if (!metadataJson) return true;
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    return !(isRecord(parsed) && parsed.userVisible === false);
  } catch {
    return true;
  }
}

/** The tool name and arguments of a `toolRequest`, or a generic name when the call did not parse. */
function toolCallOf(block: Record<string, unknown>): { name: string; input: unknown } {
  const toolCall = isRecord(block.toolCall) ? block.toolCall : {};
  const value = isRecord(toolCall.value) ? toolCall.value : {};
  return {
    name: typeof value.name === 'string' && value.name.length > 0 ? value.name : 'tool',
    input: value.arguments ?? {},
  };
}

/** The text of a `toolResponse` and whether it failed. */
function toolResultOf(block: Record<string, unknown>): { content: string; isError: boolean } {
  const toolResult = isRecord(block.toolResult) ? block.toolResult : {};
  if (toolResult.status === 'error') {
    return { content: typeof toolResult.error === 'string' ? toolResult.error : 'Tool call failed', isError: true };
  }
  const value = isRecord(toolResult.value) ? toolResult.value : {};
  const parts = Array.isArray(value.content) ? value.content.filter(isRecord) : [];
  const content = parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
  return { content, isError: value.isError === true };
}

/**
 * Map rows to entries. Pure, so tests need no database. Each entry's uuid is
 * derived from its row id (`goose:<id>`, and `goose:<id>:<call id>` for a tool
 * result), so the tail and a page mint the same uuids for the same rows.
 * `positionOf` stamps each entry's `origin`; `model` labels assistant turns.
 */
export function mapGooseRows(
  rows: ReadonlyArray<GooseMessageRow>,
  options: { conversationId?: string; model?: string | null; positionOf?: (rowId: number) => number | undefined } = {},
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const row of rows) {
    if (!isUserVisible(row.metadata_json)) continue;
    const uuid = `goose:${row.id}`;
    const timestampMs = gooseTimestampMs(row.created_timestamp);
    const position = options.positionOf?.(row.id);
    const origin = options.conversationId !== undefined && position !== undefined
      ? { origin: { conversationId: options.conversationId, position } }
      : {};
    const blocks = contentBlocks(row.content_json);

    if (row.role === 'user') {
      const text = blocks
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('')
        .trim();
      if (text.length > 0) entries.push({ kind: 'user', uuid, ts: timestampMs, text, ...origin });
      for (const block of blocks) {
        if (block.type !== 'toolResponse' || typeof block.id !== 'string') continue;
        const { content, isError } = toolResultOf(block);
        entries.push({ kind: 'tool_result', uuid: `${uuid}:${block.id}`, ts: timestampMs, toolUseId: block.id, content, isError, ...origin });
      }
      continue;
    }

    if (row.role !== 'assistant') continue;
    const assistantBlocks: TranscriptBlock[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        if (block.text.trim().length > 0) assistantBlocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        if (block.thinking.trim().length > 0) assistantBlocks.push({ type: 'thinking', text: block.thinking });
      } else if (block.type === 'reasoning' && typeof block.text === 'string') {
        if (block.text.trim().length > 0) assistantBlocks.push({ type: 'thinking', text: block.text });
      } else if (block.type === 'toolRequest' && typeof block.id === 'string') {
        const { name, input } = toolCallOf(block);
        assistantBlocks.push({ type: 'tool_use', id: block.id, name, input });
      }
    }
    if (assistantBlocks.length > 0) {
      entries.push({
        kind: 'assistant',
        uuid,
        ts: timestampMs,
        ...(options.model ? { model: options.model } : {}),
        blocks: assistantBlocks,
        ...origin,
      });
    }
  }
  return entries;
}

/** A message's place in its session: its row id, its size, and where it starts. */
interface MessageExtent {
  id: number;
  size: number;
  position: number;
}

function messageExtents(database: DatabaseType.Database, sessionId: string): MessageExtent[] {
  let position = 0;
  return database
    .prepare<[string], { id: number; size: number | null }>(
      'SELECT id, octet_length(content_json) AS size FROM messages WHERE session_id = ? ORDER BY id ASC',
    )
    .all(sessionId)
    .map((message) => {
      const extent = { id: message.id, size: message.size ?? 0, position };
      position += extent.size;
      return extent;
    });
}

/**
 * Read and map the messages `extents[from, to)` of Goose's session `sessionId`.
 * Entries name their conversation by `conversationId`, the name Kangentic
 * passed and keeps on the session record, never Goose's internal id, so a
 * reader matching it to a record finds one.
 */
function readRows(
  database: DatabaseType.Database,
  sessionId: string,
  conversationId: string,
  extents: ReadonlyArray<MessageExtent>,
  from: number,
  to: number,
  model: string | null,
): TranscriptEntry[] {
  if (from >= to) return [];
  const positionById = new Map(extents.slice(from, to).map((extent) => [extent.id, extent.position]));
  const rows = database
    .prepare<[string, number, number], GooseMessageRow>(
      'SELECT * FROM messages WHERE session_id = ? AND id >= ? AND id <= ? ORDER BY id ASC',
    )
    .all(sessionId, extents[from].id, extents[to - 1].id);
  return mapGooseRows(rows, { conversationId, model, positionOf: (rowId) => positionById.get(rowId) });
}

/** A cursor names the message a stretch starts at; the end of the session has its own. */
const END_CURSOR = 'g:end';

function encodeCursor(extent: MessageExtent | undefined): string {
  return extent ? `g:${extent.id}` : END_CURSOR;
}

function indexOfCursor(extents: ReadonlyArray<MessageExtent>, cursor: string | undefined): number | null {
  if (cursor === END_CURSOR) return extents.length;
  const match = cursor ? /^g:(\d+)$/.exec(cursor) : null;
  if (!match) return null;
  const id = Number(match[1]);
  const index = extents.findIndex((extent) => extent.id === id);
  return index < 0 ? null : index;
}

/** A session's tail and its whole size, in the position unit above. */
export interface GooseTranscript {
  entries: TranscriptEntry[];
  totalPosition: number;
}

/**
 * The session's tail: its newest messages, at least one, within
 * `parseWindowBytes()` of `content_json`, behind the shared truncation notice
 * whose cursor pages the rest. `conversationId` on each entry is the name
 * Kangentic passed (`sessionName`).
 */
export function readGooseTail(dbPath: string, sessionName: string): GooseTranscript {
  return withGooseDatabase(dbPath, { entries: [], totalPosition: 0 }, (database) => {
    const session = findGooseSession(database, sessionName);
    if (!session) return { entries: [], totalPosition: 0 };
    const extents = messageExtents(database, session.id);
    if (extents.length === 0) return { entries: [], totalPosition: 0 };
    const last = extents[extents.length - 1];
    const totalPosition = last.position + last.size;
    const budget = parseWindowBytes();
    let start = extents.length - 1;
    while (start > 0 && totalPosition - extents[start - 1].position <= budget) start -= 1;
    const entries = readRows(database, session.id, sessionName, extents, start, extents.length, session.modelName);
    prependTruncationMarker(entries, extents[start].position, totalPosition, {
      conversationId: sessionName,
      cursor: encodeCursor(extents[start]),
    });
    return { entries, totalPosition };
  });
}

/**
 * One page of a session's history for the Conversation viewer: whole messages
 * up to `maxBytes` of `content_json` before a cursor, after it, or around a
 * position, never past `untilPosition`. A message larger than a page is a page
 * of its own. Same shape as OpenCode's database pager.
 */
export function readGooseTranscriptPage(
  dbPath: string,
  sessionName: string,
  request: TranscriptPageReadRequest,
): TranscriptPageReadResult {
  if (!fs.existsSync(dbPath)) return { status: 'unavailable', reason: 'file_missing' };
  const unavailable: TranscriptPageReadResult = { status: 'unavailable', reason: 'read_failed' };
  return withGooseDatabase<TranscriptPageReadResult>(dbPath, unavailable, (database) => {
    const session = findGooseSession(database, sessionName);
    if (!session) return { status: 'unavailable', reason: 'not_found' };
    const extents = messageExtents(database, session.id);
    if (extents.length === 0) return { status: 'unavailable', reason: 'not_found' };
    const sourceToken = `goose:${session.id}:${extents[0].id}`;
    if (request.sourceToken && request.sourceToken !== sourceToken) return { status: 'reset' };
    const last = extents[extents.length - 1];
    const totalPosition = last.position + last.size;
    const maxBytes = Math.max(1, Math.floor(request.maxBytes));
    const untilIndex = (() => {
      const until = request.untilPosition ?? totalPosition;
      const index = extents.findIndex((extent) => extent.position >= until);
      return index < 0 ? extents.length : index;
    })();
    const span = (start: number, end: number): number => (end > start
      ? extents[end - 1].position + extents[end - 1].size - extents[start].position
      : 0);

    let from: number;
    let to: number;
    if (request.direction === 'before') {
      const end = indexOfCursor(extents, request.cursor);
      if (end === null) return { status: 'reset' };
      to = end;
      from = to;
      while (from > 0 && (from === to || span(from - 1, to) <= maxBytes)) from -= 1;
    } else if (request.direction === 'after') {
      const start = indexOfCursor(extents, request.cursor);
      if (start === null) return { status: 'reset' };
      from = start;
      to = from;
      while (to < untilIndex && (to === from || span(from, to + 1) <= maxBytes)) to += 1;
    } else {
      const target = Math.max(0, request.position ?? 0);
      let center = extents.findIndex((extent) => extent.position + extent.size > target);
      if (center < 0 || center >= untilIndex) center = Math.max(0, untilIndex - 1);
      from = center;
      to = Math.min(center + 1, untilIndex);
      let grew = true;
      while (grew) {
        grew = false;
        if (from > 0 && span(from - 1, to) <= maxBytes) {
          from -= 1;
          grew = true;
        }
        if (to < untilIndex && span(from, to + 1) <= maxBytes) {
          to += 1;
          grew = true;
        }
      }
    }

    return {
      status: 'ok',
      page: {
        sourceToken,
        startCursor: encodeCursor(extents[from]),
        endCursor: encodeCursor(extents[to]),
        startPosition: from < extents.length ? extents[from].position : totalPosition,
        endPosition: to < extents.length ? extents[to].position : totalPosition,
        totalPosition,
        reachedStart: from === 0,
        reachedEnd: to >= untilIndex,
        entries: readRows(database, session.id, sessionName, extents, from, to, session.modelName),
      },
    };
  });
}

/**
 * Lifetime tokens of a session: the row's `accumulated_*` sums, which Goose
 * adds every turn to, across resumes. Null when the session is not there.
 */
export function readGooseTranscriptUsage(dbPath: string, sessionName: string): TranscriptUsage | null {
  return withGooseDatabase(dbPath, null, (database) => {
    const session = findGooseSession(database, sessionName);
    if (!session) return null;
    const inputTokens = session.accumulatedInputTokens ?? session.inputTokens;
    const outputTokens = session.accumulatedOutputTokens ?? session.outputTokens;
    if (inputTokens === null && outputTokens === null) return null;
    return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
  });
}

/** Result tokens of a response's text, estimated at four characters a token as Claude's reader does. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface ToolCallTally {
  callCountByTool: Map<string, number>;
  resultTokensByTool: Map<string, number>;
}

/**
 * Count a session's tool calls made at or after `sinceMs` and before
 * `untilMs`, by a message's `created_timestamp`, and the tokens of the
 * responses that arrived in that window. Distinct `toolRequest` ids: a call is
 * counted once whatever re-emits it. A response in the window is named by its
 * request wherever that request sits, so a call made just before `sinceMs`
 * still has its result tokens counted. Only rows that carry a tool block are
 * read, and the window is applied to each row here rather than in the query.
 */
function tallyToolCalls(database: DatabaseType.Database, sessionId: string, sinceMs: number | null, untilMs: number | null): ToolCallTally {
  const rows = database
    .prepare<[string], { content_json: string; created_timestamp: number }>(
      "SELECT content_json, created_timestamp FROM messages WHERE session_id = ? AND (content_json LIKE '%\"toolRequest\"%' OR content_json LIKE '%\"toolResponse\"%') ORDER BY id ASC",
    )
    .all(sessionId);

  const toolById = new Map<string, string>();
  const countedCallIds = new Set<string>();
  const callCountByTool = new Map<string, number>();
  const resultTokensByTool = new Map<string, number>();
  for (const row of rows) {
    const createdMs = gooseTimestampMs(row.created_timestamp);
    const inWindow = (sinceMs === null || createdMs >= sinceMs) && (untilMs === null || createdMs < untilMs);
    for (const block of contentBlocks(row.content_json)) {
      if (typeof block.id !== 'string') continue;
      if (block.type === 'toolRequest') {
        if (!toolById.has(block.id)) toolById.set(block.id, toolCallOf(block).name);
        if (!inWindow || countedCallIds.has(block.id)) continue;
        countedCallIds.add(block.id);
        const name = toolById.get(block.id) ?? 'tool';
        callCountByTool.set(name, (callCountByTool.get(name) ?? 0) + 1);
      } else if (block.type === 'toolResponse') {
        if (!inWindow) continue;
        const name = toolById.get(block.id);
        if (!name) continue;
        resultTokensByTool.set(name, (resultTokensByTool.get(name) ?? 0) + estimateTokens(toolResultOf(block).content));
      }
    }
  }
  return { callCountByTool, resultTokensByTool };
}

/** Tool-call count and per-tool breakdown, scoped to `[sinceMs, untilMs)` when given. Null when nothing was called. */
export function readGooseToolCounts(
  dbPath: string,
  sessionName: string,
  sinceMs: number | null = null,
  untilMs: number | null = null,
): TranscriptToolCounts | null {
  return withGooseDatabase(dbPath, null, (database) => {
    const session = findGooseSession(database, sessionName);
    if (!session) return null;
    const { callCountByTool, resultTokensByTool } = tallyToolCalls(database, session.id, sinceMs, untilMs);
    if (callCountByTool.size === 0) return null;
    const toolBreakdown: PerToolStat[] = [...callCountByTool].map(([toolName, callCount]) => ({
      toolName,
      callCount,
      totalDurationMs: 0,
      interruptedCount: 0,
      ...(resultTokensByTool.has(toolName) ? { resultTokens: resultTokensByTool.get(toolName) } : {}),
    }));
    const toolCallCount = toolBreakdown.reduce((sum, row) => sum + row.callCount, 0);
    return { toolCallCount, toolBreakdown };
  });
}

/**
 * Estimated result tokens per tool name in `[sinceMs, untilMs)`. Null only when
 * the database or the session cannot be read; an empty object is an answer.
 */
export function readGooseToolResultTokens(
  dbPath: string,
  sessionName: string,
  sinceMs: number | null = null,
  untilMs: number | null = null,
): Record<string, number> | null {
  return withGooseDatabase(dbPath, null, (database) => {
    const session = findGooseSession(database, sessionName);
    if (!session) return null;
    return Object.fromEntries(tallyToolCalls(database, session.id, sinceMs, untilMs).resultTokensByTool);
  });
}
