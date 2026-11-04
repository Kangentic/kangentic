import fs from 'node:fs';
import type DatabaseType from 'better-sqlite3';
import type { TranscriptEntry, TranscriptBlock, TranscriptTurnUsage } from '../../../../shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../agent-adapter';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { loadBetterSqlite3, openCodeDbPath } from './session-history-parser';
import type { OpenCodeRemoteMessageEntry } from './remote-client';
import { openCodeV2RowEntries, type OpenCodeV2MessageRow } from './v2-messages';

/**
 * Parse an OpenCode session into agent-agnostic `TranscriptEntry[]` for the
 * MCP `get_transcript` structured format.
 *
 * Unlike the file-based agents, OpenCode persists every session in a shared
 * SQLite database (`~/.local/share/opencode/opencode.db`). An OpenCode 2
 * session is in `session_message` instead (`storeOf`, `v2-messages.ts`).
 * OpenCode 1 schema (verified read-only against OpenCode on disk, 2026-06):
 *   - `message(id, session_id, time_created, time_updated, data)` where
 *     `data` is JSON `{ role: 'user'|'assistant', time, modelID, ... }`.
 *   - `part(id, message_id, session_id, time_created, time_updated, data)`
 *     where `data.type` is one of `text`, `reasoning`, `step-start`,
 *     `step-finish`, `tool`.
 *
 * Part mapping:
 *   - `text`      -> text block (joined onto the user entry for user messages)
 *   - `reasoning` -> thinking block (non-empty only)
 *   - `tool`      -> tool_use block + tool_result entry, read from the part's
 *                    `state` (`callID`, `tool`, `state.input`, `state.output`,
 *                    `state.status === 'error'`). Schema-derived: no real tool
 *                    parts were available locally, so this is handled
 *                    defensively.
 *   - `step-start` / `step-finish` and unknown types: skipped.
 *
 * Opens the DB read-only (WAL-friendly). Returns `[]` when better-sqlite3 is
 * unavailable (the module is lazy-loaded by design so unit tests under a
 * stand-alone Node runtime stay loadable) or the DB/session is missing.
 *
 * Reads a bounded TAIL, like every file-based agent: the newest messages up to
 * `parseWindowBytes()` of stored data, behind the shared truncation notice. A
 * session's position is the characters of `data` its messages and their parts
 * hold, in message order, which is how the Conversation viewer places it on a
 * scrollbar spanning the whole session; the left-out history pages through
 * `readOpenCodeTranscriptPage`.
 */
export async function parseOpenCodeTranscript(sessionId: string): Promise<OpenCodeTranscript> {
  return readOpenCodeTailAtPath(openCodeDbPath(), sessionId);
}

/** A session's tail and its whole size, in the position unit above. */
export interface OpenCodeTranscript {
  entries: TranscriptEntry[];
  totalPosition: number;
}

/** The DB path used for a parse; informational, for the response header. */
export function openCodeTranscriptSourcePath(): string {
  return openCodeDbPath();
}

/**
 * Parse from an explicit DB path. Exported so unit tests can point at a
 * fixture database built with the same lazy-loaded better-sqlite3.
 */
export function parseOpenCodeTranscriptAtPath(dbPath: string, sessionId: string): TranscriptEntry[] {
  return readOpenCodeTailAtPath(dbPath, sessionId).entries;
}

/** Run a read-only query against the database, or answer `fallback` when it cannot be opened or read. */
export function withDatabase<Value>(dbPath: string, fallback: Value, read: (database: DatabaseType.Database) => Value): Value {
  if (!fs.existsSync(dbPath)) return fallback;
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) return fallback;

  let database: DatabaseType.Database | null = null;
  try {
    database = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
    return read(database);
  } catch {
    return fallback;
  } finally {
    if (database) {
      try {
        database.close();
      } catch {
        // ignore
      }
    }
  }
}

export interface OpenCodeMessageRow {
  id: string;
  time_created: number;
  data: string;
}
export interface OpenCodePartRow {
  message_id: string;
  data: string;
}

/**
 * One message's place in its session: its key, its size (message plus parts), and where it starts.
 * `order` is the column the session's messages sort by: `time_created` for an
 * OpenCode 1 session, `seq` for an OpenCode 2 one.
 */
interface MessageExtent {
  id: string;
  order: number;
  size: number;
  position: number;
}

/**
 * Where a session's messages are stored. OpenCode 1 writes `message` and
 * `part`. OpenCode 2 (measured on 2.2.5) keeps the same database, leaves those
 * tables as they were, and writes a session's messages to `session_message`
 * only, one row per message ordered by `seq`.
 *
 * A session can be in both. OpenCode 2's migration copies every OpenCode 1
 * session's messages into `session_message`, and each major then writes only
 * its own table, so a session continued on either major after the migration
 * has its newest turns in one table alone. The store with the newer message
 * holds the whole conversation, and a tie (a session no one continued) reads
 * `message` as before. A session whose newest turn moves to the other store
 * changes its cursors, and the viewer starts it again (`reset`).
 */
export type MessageStore = 'v1' | 'v2';

/** The session's newest `time_created` in `table`, or null for none or no such table. */
function newestMessageAt(database: DatabaseType.Database, table: 'message' | 'session_message', sessionId: string): number | null {
  try {
    return database
      .prepare<[string], { newest: number | null }>(`SELECT MAX(time_created) AS newest FROM ${table} WHERE session_id = ?`)
      .get(sessionId)?.newest ?? null;
  } catch (error) {
    // An OpenCode 1 database has no `session_message`, and a fresh OpenCode 2
    // one may have no `message`. Any other failure is a failed read.
    if (error instanceof Error && /no such table/i.test(error.message)) return null;
    throw error;
  }
}

export function storeOf(database: DatabaseType.Database, sessionId: string): MessageStore {
  const v1Newest = newestMessageAt(database, 'message', sessionId);
  const v2Newest = newestMessageAt(database, 'session_message', sessionId);
  if (v2Newest === null) return 'v1';
  return v1Newest === null || v2Newest > v1Newest ? 'v2' : 'v1';
}

/** Every message of a session in order, sized from SQLite's own `length()`, without reading any data. */
function messageExtents(database: DatabaseType.Database, sessionId: string, store: MessageStore): MessageExtent[] {
  if (store === 'v2') {
    let position = 0;
    return database
      .prepare<[string], { id: string; order: number; size: number }>(
        'SELECT id, seq AS "order", length(data) AS size FROM session_message WHERE session_id = ? ORDER BY seq ASC, id ASC',
      )
      .all(sessionId)
      .map((message) => {
        const extent = { id: message.id, order: message.order, size: message.size ?? 0, position };
        position += extent.size;
        return extent;
      });
  }
  const messages = database
    .prepare<[string], { id: string; order: number; size: number }>(
      'SELECT id, time_created AS "order", length(data) AS size FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC',
    )
    .all(sessionId);
  const partSizes = new Map<string, number>();
  for (const row of database
    .prepare<[string], { messageId: string; size: number }>(
      'SELECT message_id AS messageId, SUM(length(data)) AS size FROM part WHERE session_id = ? GROUP BY message_id',
    )
    .all(sessionId)) {
    partSizes.set(row.messageId, row.size ?? 0);
  }
  let position = 0;
  return messages.map((message) => {
    const size = (message.size ?? 0) + (partSizes.get(message.id) ?? 0);
    const extent = { id: message.id, order: message.order, size, position };
    position += size;
    return extent;
  });
}

/** An OpenCode 2 session's `session_message` rows `[first, last]`, mapped like an export's messages. */
function readV2Messages(database: DatabaseType.Database, sessionId: string, first: MessageExtent, last: MessageExtent): TranscriptEntry[] {
  const rows = database
    .prepare<[string, number, string, number, string], OpenCodeV2MessageRow>(
      `SELECT id, type, time_created, data FROM session_message
       WHERE session_id = ? AND (seq, id) >= (?, ?) AND (seq, id) <= (?, ?)
       ORDER BY seq ASC, id ASC`,
    )
    .all(sessionId, first.order, first.id, last.order, last.id);
  return mapOpenCodeRemoteEntries(openCodeV2RowEntries(rows));
}

/** Read and map the messages `extents[from, to)`, each entry stamped with its message's position. */
function readMessages(
  database: DatabaseType.Database,
  sessionId: string,
  extents: ReadonlyArray<MessageExtent>,
  from: number,
  to: number,
  store: MessageStore,
): TranscriptEntry[] {
  if (from >= to) return [];
  const first = extents[from];
  const last = extents[to - 1];
  const positionById = new Map(extents.slice(from, to).map((extent) => [extent.id, extent.position]));
  const stamp = (entries: TranscriptEntry[]): TranscriptEntry[] => {
    for (const entry of entries) {
      const position = positionById.get(entry.uuid);
      if (position !== undefined) entry.origin = { conversationId: sessionId, position };
    }
    return entries;
  };
  if (store === 'v2') return stamp(readV2Messages(database, sessionId, first, last));
  const range = '(time_created, id) >= (?, ?) AND (time_created, id) <= (?, ?)';
  const bounds = [first.order, first.id, last.order, last.id] as const;
  const messageRows = database
    .prepare<[string, number, string, number, string], OpenCodeMessageRow>(
      `SELECT id, time_created, data FROM message WHERE session_id = ? AND ${range} ORDER BY time_created ASC, id ASC`,
    )
    .all(sessionId, ...bounds);
  const partRows = database
    .prepare<[string, string, number, string, number, string], OpenCodePartRow>(
      `SELECT message_id, data FROM part WHERE session_id = ? AND message_id IN (
         SELECT id FROM message WHERE session_id = ? AND ${range}
       ) ORDER BY time_created ASC, id ASC`,
    )
    .all(sessionId, sessionId, ...bounds);
  return stamp(mapOpenCodeRows(messageRows, partRows));
}

/** A cursor names the message a stretch starts at; the end of the session has its own. */
const END_CURSOR = 'o:end';

function encodeMessageCursor(extent: MessageExtent | undefined): string {
  return extent ? `o:${extent.order}:${encodeURIComponent(extent.id)}` : END_CURSOR;
}

/** The index a cursor names, the length for the end, or null for a message the session no longer has. */
function indexOfCursor(extents: ReadonlyArray<MessageExtent>, cursor: string | undefined): number | null {
  if (cursor === END_CURSOR) return extents.length;
  const match = cursor ? /^o:(-?\d+):(.*)$/.exec(cursor) : null;
  if (!match) return null;
  const order = Number(match[1]);
  let id: string;
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    // A malformed escape names no message: the caller answers `reset`.
    return null;
  }
  const index = extents.findIndex((extent) => extent.id === id && extent.order === order);
  return index < 0 ? null : index;
}

/** The session's tail: its newest messages, at least one, within `parseWindowBytes()` of stored data. */
export function readOpenCodeTailAtPath(dbPath: string, sessionId: string): OpenCodeTranscript {
  return withDatabase(dbPath, { entries: [], totalPosition: 0 }, (database) => {
    const store = storeOf(database, sessionId);
    const extents = messageExtents(database, sessionId, store);
    if (extents.length === 0) return { entries: [], totalPosition: 0 };
    const totalPosition = extents[extents.length - 1].position + extents[extents.length - 1].size;
    const budget = parseWindowBytes();
    let start = extents.length - 1;
    while (start > 0 && totalPosition - extents[start - 1].position <= budget) start -= 1;
    const entries = readMessages(database, sessionId, extents, start, extents.length, store);
    const tailStart = extents[start].position;
    prependTruncationMarker(entries, tailStart, totalPosition, {
      conversationId: sessionId,
      cursor: encodeMessageCursor(extents[start]),
    });
    return { entries, totalPosition };
  });
}

/**
 * One bounded window of a session for the conversation indexer
 * (`AgentAdapter.parseTranscriptWindow`): the whole messages that start at or
 * after `startByte`, up to `maxBytes` of stored data, at least one. Positions are
 * the tail's and the viewer's unit (characters of `data`), so `nextByteOffset`
 * is where the next message starts and the walk ends at `totalBytes`. Every
 * message carries its own usage, so no attribution carry is needed between
 * windows. Retains nothing between calls.
 */
export function readOpenCodeTranscriptWindowAtPath(
  dbPath: string,
  sessionId: string,
  startByte: number,
  maxBytes: number,
): { entries: TranscriptEntry[]; nextByteOffset: number; totalBytes: number; firstByteOffset: number; endByte: number } {
  const empty = { entries: [], nextByteOffset: startByte, totalBytes: 0, firstByteOffset: startByte, endByte: startByte };
  return withDatabase(dbPath, empty, (database) => {
    const store = storeOf(database, sessionId);
    const extents = messageExtents(database, sessionId, store);
    if (extents.length === 0) return empty;
    const totalBytes = extents[extents.length - 1].position + extents[extents.length - 1].size;
    const from = extents.findIndex((extent) => extent.position >= startByte);
    if (from < 0) return { entries: [], nextByteOffset: totalBytes, totalBytes, firstByteOffset: totalBytes, endByte: totalBytes };
    let to = from + 1;
    while (to < extents.length && extents[to].position + extents[to].size - extents[from].position <= maxBytes) to += 1;
    const endByte = to < extents.length ? extents[to].position : totalBytes;
    return {
      entries: readMessages(database, sessionId, extents, from, to, store),
      nextByteOffset: endByte,
      totalBytes,
      firstByteOffset: extents[from].position,
      endByte,
    };
  });
}

/**
 * One page of an OpenCode session's history for the Conversation viewer
 * (`AgentAdapter.readTranscriptPage`): whole messages up to `maxBytes` of
 * stored data before a cursor, after it, or around a position. A message
 * larger than a page is a page of its own. Entries carry their message ids,
 * so they are the same entries the tail parse mints.
 */
export function readOpenCodeTranscriptPage(
  dbPath: string,
  sessionId: string,
  request: TranscriptPageReadRequest,
): TranscriptPageReadResult {
  // An absent database is a missing source (the caller tries the archive); one
  // that is there but fails to open or read is a failed read the viewer retries.
  if (!fs.existsSync(dbPath)) return { status: 'unavailable', reason: 'file_missing' };
  const unavailable: TranscriptPageReadResult = { status: 'unavailable', reason: 'read_failed' };
  return withDatabase<TranscriptPageReadResult>(dbPath, unavailable, (database) => {
    const store = storeOf(database, sessionId);
    const extents = messageExtents(database, sessionId, store);
    if (extents.length === 0) return { status: 'unavailable', reason: 'not_found' };
    const sourceToken = `opencode:${extents[0].id}`;
    if (request.sourceToken && request.sourceToken !== sourceToken) return { status: 'reset' };
    const totalPosition = extents[extents.length - 1].position + extents[extents.length - 1].size;
    const maxBytes = Math.max(1, Math.floor(request.maxBytes));
    const untilIndex = (() => {
      const until = request.untilPosition ?? totalPosition;
      const index = extents.findIndex((extent) => extent.position >= until);
      return index < 0 ? extents.length : index;
    })();

    let from: number;
    let to: number;
    if (request.direction === 'before') {
      const end = indexOfCursor(extents, request.cursor);
      if (end === null) return { status: 'reset' };
      to = end;
      from = to;
      while (from > 0 && (from === to || extents[to - 1].position + extents[to - 1].size - extents[from - 1].position <= maxBytes)) from -= 1;
    } else if (request.direction === 'after') {
      const start = indexOfCursor(extents, request.cursor);
      if (start === null) return { status: 'reset' };
      from = start;
      to = from;
      while (to < untilIndex && (to === from || extents[to].position + extents[to].size - extents[from].position <= maxBytes)) to += 1;
    } else {
      const target = Math.max(0, request.position ?? 0);
      let center = extents.findIndex((extent) => extent.position + extent.size > target);
      if (center < 0 || center >= untilIndex) center = Math.max(0, untilIndex - 1);
      from = center;
      to = Math.min(center + 1, untilIndex);
      // Grow both ways around the target until the next message would pass the page.
      let grew = true;
      while (grew) {
        grew = false;
        const span = (start: number, end: number) => (end > start ? extents[end - 1].position + extents[end - 1].size - extents[start].position : 0);
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

    const startPosition = from < extents.length ? extents[from].position : totalPosition;
    const endPosition = to < extents.length ? extents[to].position : totalPosition;
    return {
      status: 'ok',
      page: {
        sourceToken,
        startCursor: encodeMessageCursor(extents[from]),
        endCursor: encodeMessageCursor(extents[to]),
        startPosition,
        endPosition,
        totalPosition,
        reachedStart: from === 0,
        reachedEnd: to >= untilIndex,
        entries: readMessages(database, sessionId, extents, from, to, store),
      },
    };
  });
}

/**
 * Pure row-to-entry mapping, separated from the SQLite I/O so it can be unit
 * tested without a database. `messageRows` and `partRows` must already be
 * ordered by `time_created` ascending.
 */
export function mapOpenCodeRows(
  messageRows: OpenCodeMessageRow[],
  partRows: OpenCodePartRow[],
): TranscriptEntry[] {
  // Group parts by message id, preserving time_created order.
  const partsByMessage = new Map<string, Record<string, unknown>[]>();
  for (const row of partRows) {
    const data = tryParseJson(row.data);
    if (!isRecord(data)) continue;
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(data);
    partsByMessage.set(row.message_id, list);
  }

  const entries: TranscriptEntry[] = [];
  for (const messageRow of messageRows) {
    const messageData = tryParseJson(messageRow.data);
    if (!isRecord(messageData)) continue;
    const role = messageData.role;
    const ts = typeof messageRow.time_created === 'number' ? messageRow.time_created : Date.now();
    const uuid = messageRow.id;
    const parts = partsByMessage.get(messageRow.id) ?? [];

    if (role === 'user') {
      const text = parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('')
        .trim();
      if (text.length > 0) entries.push({ kind: 'user', uuid, ts, text });
      continue;
    }

    if (role !== 'assistant') continue;

    const model = typeof messageData.modelID === 'string' ? messageData.modelID : undefined;
    const blocks: TranscriptBlock[] = [];
    const toolResults: TranscriptEntry[] = [];

    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        if (part.text.trim().length > 0) blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'reasoning' && typeof part.text === 'string') {
        if (part.text.trim().length > 0) blocks.push({ type: 'thinking', text: part.text });
      } else if (part.type === 'tool') {
        const callId = typeof part.callID === 'string' ? part.callID : '';
        const name = typeof part.tool === 'string' ? part.tool : 'tool';
        const state = isRecord(part.state) ? part.state : {};
        blocks.push({ type: 'tool_use', id: callId, name, input: state.input });
        toolResults.push({
          kind: 'tool_result',
          uuid,
          ts,
          toolUseId: callId,
          content: stringifyOutput(state.output),
          isError: state.status === 'error',
        });
      }
    }

    const usage = openCodeTurnUsage(messageData.tokens);
    if (blocks.length > 0) entries.push({ kind: 'assistant', uuid, ts, model, ...(usage ? { usage } : {}), blocks });
    for (const result of toolResults) entries.push(result);
  }

  return entries;
}

/**
 * One answer's tokens as a `TranscriptTurnUsage`, from an assistant message's
 * `tokens: { input, output, reasoning, cache: { read, write } }`
 * (`AssistantMessage` in `@opencode-ai/sdk` at v1.18.31; OpenCode 2's records
 * keep a `tokens` of their own, read the same way). OpenCode counts reasoning
 * apart from output; both are generated, so both are output here. Undefined
 * when the message reports none.
 */
export function openCodeTurnUsage(tokens: unknown): TranscriptTurnUsage | undefined {
  if (!isRecord(tokens)) return undefined;
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  return {
    inputTokens: positiveNumber(tokens.input),
    outputTokens: positiveNumber(tokens.output) + positiveNumber(tokens.reasoning),
    cacheCreationInputTokens: positiveNumber(cache.write),
    cacheReadInputTokens: positiveNumber(cache.read),
  };
}

/** A finite number above zero, else 0: a token count or cost read from untrusted JSON. */
export function positiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** A stored `data` column parsed to an object, or null when it is not JSON or not an object. */
export function parseJsonRecord(data: string): Record<string, unknown> | null {
  const parsed = tryParseJson(data);
  return isRecord(parsed) ? parsed : null;
}

/**
 * Map a remote OpenCode server's `GET /session/:id/message` response
 * (`{info, parts}[]`) into the same agent-agnostic `TranscriptEntry[]` shape
 * `mapOpenCodeRows` produces from the local SQLite tables. This is a
 * genuinely different input shape, not a reuse of the SQLite mapper: the
 * remote payload arrives as already-parsed JSON objects (`part.text`,
 * `part.state`) rather than a `data` JSON-string column, so there is no
 * `tryParseJson` step. The per-part-type switch (text / reasoning / tool)
 * mirrors `mapOpenCodeRows` exactly so both code paths stay in sync if the
 * conversation model grows a new block type.
 *
 * UNVERIFIED against a live server - see the field-name caveat on
 * `OpenCodeRemoteMessage`/`OpenCodeRemotePart` in `remote-client.ts`.
 */
export function mapOpenCodeRemoteEntries(messages: OpenCodeRemoteMessageEntry[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  for (const { info, parts } of messages) {
    if (!info || typeof info.id !== 'string') continue;
    const uuid = info.id;
    const ts = typeof info.time?.created === 'number' ? info.time.created : Date.now();

    if (info.role === 'user') {
      const text = parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('')
        .trim();
      if (text.length > 0) entries.push({ kind: 'user', uuid, ts, text });
      continue;
    }

    if (info.role !== 'assistant') continue;

    const model = typeof info.modelID === 'string' ? info.modelID : undefined;
    const blocks: TranscriptBlock[] = [];
    const toolResults: TranscriptEntry[] = [];

    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        if (part.text.trim().length > 0) blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'reasoning' && typeof part.text === 'string') {
        if (part.text.trim().length > 0) blocks.push({ type: 'thinking', text: part.text });
      } else if (part.type === 'tool') {
        const callId = typeof part.callID === 'string' ? part.callID : '';
        const name = typeof part.tool === 'string' ? part.tool : 'tool';
        const state = isRecord(part.state) ? part.state : {};
        blocks.push({ type: 'tool_use', id: callId, name, input: state.input });
        toolResults.push({
          kind: 'tool_result',
          uuid,
          ts,
          toolUseId: callId,
          content: stringifyOutput(state.output),
          isError: state.status === 'error',
        });
      }
    }

    const usage = openCodeTurnUsage(info.tokens);
    if (blocks.length > 0) entries.push({ kind: 'assistant', uuid, ts, model, ...(usage ? { usage } : {}), blocks });
    for (const result of toolResults) entries.push(result);
  }

  return entries;
}

/**
 * Bound a remote session's entries the way every local read is bounded: the
 * newest entries within `parseWindowBytes()` of JSON, behind the shared notice.
 * The server's message API has no paging Kangentic can rely on, so the notice
 * carries no cursor and the left-out history stays out of the viewer.
 */
export function capOpenCodeRemoteEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  const sizes = entries.map((entry) => JSON.stringify(entry).length);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const budget = parseWindowBytes();
  if (total <= budget) return entries;
  let start = entries.length - 1;
  let kept = sizes[start];
  while (start > 0 && kept + sizes[start - 1] <= budget) {
    start -= 1;
    kept += sizes[start];
  }
  return prependTruncationMarker(entries.slice(start), total - kept, total);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
