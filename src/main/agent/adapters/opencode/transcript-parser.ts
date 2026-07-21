import fs from 'node:fs';
import type DatabaseType from 'better-sqlite3';
import type { TranscriptEntry, TranscriptBlock } from '../../../../shared/types';
import { loadBetterSqlite3, openCodeDbPath } from './session-history-parser';
import type { OpenCodeRemoteMessageEntry } from './remote-client';

/**
 * Parse an OpenCode session into agent-agnostic `TranscriptEntry[]` for the
 * MCP `get_transcript` structured format.
 *
 * Unlike the file-based agents, OpenCode persists every session in a shared
 * SQLite database (`~/.local/share/opencode/opencode.db`). Schema (verified
 * read-only against OpenCode on disk, 2026-06):
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
 */
export async function parseOpenCodeTranscript(sessionId: string): Promise<TranscriptEntry[]> {
  return parseOpenCodeTranscriptAtPath(openCodeDbPath(), sessionId);
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
  if (!fs.existsSync(dbPath)) return [];
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) return [];

  let database: DatabaseType.Database | null = null;
  try {
    database = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
    return readTranscript(database, sessionId);
  } catch {
    return [];
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

function readTranscript(database: DatabaseType.Database, sessionId: string): TranscriptEntry[] {
  const messageRows = database
    .prepare<[string], OpenCodeMessageRow>(
      'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC',
    )
    .all(sessionId);
  if (messageRows.length === 0) return [];

  const partRows = database
    .prepare<[string], OpenCodePartRow>(
      'SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC',
    )
    .all(sessionId);

  return mapOpenCodeRows(messageRows, partRows);
}

/**
 * Pure row-to-entry mapping, separated from the SQLite I/O so it can be unit
 * tested without the native better-sqlite3 module (which cannot load under a
 * stand-alone Node runtime). `messageRows` and `partRows` must already be
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

    if (blocks.length > 0) entries.push({ kind: 'assistant', uuid, ts, model, blocks });
    for (const result of toolResults) entries.push(result);
  }

  return entries;
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

    if (blocks.length > 0) entries.push({ kind: 'assistant', uuid, ts, model, blocks });
    for (const result of toolResults) entries.push(result);
  }

  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
