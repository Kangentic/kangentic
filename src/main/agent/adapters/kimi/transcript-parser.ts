import os from 'node:os';
import path from 'node:path';
import type { TranscriptEntry, TranscriptBlock } from '../../../../shared/types';
import { readJsonlWindow } from '../../shared/history-scan';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { findSessionWireFile } from './session-history-parser';

/**
 * Parse Kimi CLI's `wire.jsonl` event stream into agent-agnostic
 * `TranscriptEntry[]` for the MCP `get_transcript` structured format.
 *
 * Envelope (wire protocol v1.9): line 1 is `{ type: 'metadata' }`; the rest
 * are `{ timestamp: <unix seconds float>, message: { type, payload } }`.
 * See `wire-parser.ts` for the full telemetry mapping.
 *
 * Conversation mapping:
 *   - `TurnBegin` / `SteerInput`: `payload.user_input` (string | ContentPart[])
 *     -> user entry.
 *   - `ContentPart`: assistant text fragments, accumulated and flushed as an
 *     assistant text entry on the next tool/turn boundary.
 *   - `ToolCall`: `{ id, function: { name, arguments } }` -> assistant entry
 *     with a tool_use block.
 *   - `ToolResult`: `{ tool_call_id, return_value: { output, message, is_error } }`
 *     -> tool_result entry.
 * Everything else (StatusUpdate, hooks, subagent chatter) is skipped.
 *
 * NOTE: no real Kimi sessions were available locally to pin the `ContentPart`
 * text shape (all on-disk wire files are mock-derived), so the assistant-text
 * extraction is schema-derived from the upstream wire spec and handled
 * defensively. Tool calls/results and user prompts ARE pinned to the verified
 * on-disk shapes.
 */
export async function parseKimiTranscript(filePath: string): Promise<TranscriptEntry[]> {
  // Bounded tail read rather than a whole-file one: a transcript has no size
  // ceiling, and reading one whole is what OOM'd the main process.
  const window = await readJsonlWindow(filePath, { maxBytes: parseWindowBytes() });
  if (window.totalBytes === 0) return [];

  const entries: TranscriptEntry[] = [];
  let pendingAssistantText = '';
  let pendingTs = 0;
  let entryIndex = 0;

  const flushAssistantText = (): void => {
    const text = pendingAssistantText.trim();
    if (text.length > 0) {
      entries.push({
        kind: 'assistant',
        uuid: `kimi-${entryIndex++}`,
        ts: pendingTs,
        blocks: [{ type: 'text', text }],
      });
    }
    pendingAssistantText = '';
  };

  for (const line of window.text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    if (raw.type === 'metadata') continue;

    const message = raw.message;
    if (!isRecord(message)) continue;
    const type = message.type;
    const payload = isRecord(message.payload) ? message.payload : {};
    const ts = parseTimestamp(raw.timestamp);

    if (type === 'TurnBegin' || type === 'SteerInput') {
      flushAssistantText();
      const text = extractUserInputText(payload.user_input);
      if (text) entries.push({ kind: 'user', uuid: `kimi-${entryIndex++}`, ts, text });
      continue;
    }

    if (type === 'ContentPart') {
      const fragment = extractContentPartText(payload);
      if (fragment) {
        if (pendingAssistantText.length === 0) pendingTs = ts;
        pendingAssistantText += fragment;
      }
      continue;
    }

    if (type === 'ToolCall') {
      flushAssistantText();
      const id = typeof payload.id === 'string' ? payload.id : '';
      const callFunction = isRecord(payload.function) ? payload.function : {};
      const name = typeof callFunction.name === 'string' && callFunction.name.length > 0 ? callFunction.name : 'tool';
      const input = typeof callFunction.arguments === 'string'
        ? (tryParseJson(callFunction.arguments) ?? callFunction.arguments)
        : callFunction.arguments;
      const blocks: TranscriptBlock[] = [{ type: 'tool_use', id, name, input }];
      entries.push({ kind: 'assistant', uuid: `kimi-${entryIndex++}`, ts, blocks });
      continue;
    }

    if (type === 'ToolResult') {
      const toolUseId = typeof payload.tool_call_id === 'string' ? payload.tool_call_id : '';
      const returnValue = isRecord(payload.return_value) ? payload.return_value : {};
      entries.push({
        kind: 'tool_result',
        uuid: `kimi-${entryIndex++}`,
        ts,
        toolUseId,
        content: extractToolResultContent(returnValue),
        isError: returnValue.is_error === true,
      });
      continue;
    }

    // TurnEnd and any other event close out any pending assistant text.
    if (type === 'TurnEnd') flushAssistantText();
  }

  flushAssistantText();
  return prependTruncationMarker(entries, window.omittedBytes, window.totalBytes);
}

/**
 * Locate `wire.jsonl` for a known Kimi session id. Globs across the work-dir
 * hash directories under `~/.kimi/sessions/` and matches the session UUID
 * (reusing the locator's existing helper). Non-polling.
 */
export function locateKimiTranscriptFile(agentSessionId: string): string | null {
  const sessionsRoot = path.join(os.homedir(), '.kimi', 'sessions');
  return findSessionWireFile(sessionsRoot, agentSessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** wire.jsonl timestamps are unix seconds (float); convert to epoch ms. */
function parseTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1000);
  return Date.now();
}

/** Extract user prompt text from a `user_input` (string | ContentPart[]). */
function extractUserInputText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(value)) return null;
  const pieces: string[] = [];
  for (const part of value) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      const trimmed = part.text.trim();
      if (trimmed.length > 0) pieces.push(trimmed);
    }
  }
  return pieces.length > 0 ? pieces.join(' ') : null;
}

/**
 * Extract a streamed assistant text fragment from a `ContentPart` payload.
 * Schema-derived: tolerates `text`, `content` (string), a nested
 * `part.text`, or a `delta` field.
 */
function extractContentPartText(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.delta === 'string') return payload.delta;
  if (isRecord(payload.part) && typeof payload.part.text === 'string') return payload.part.text;
  return '';
}

/** Pull readable text out of a ToolResult `return_value`. */
function extractToolResultContent(returnValue: Record<string, unknown>): string {
  if (typeof returnValue.output === 'string') return returnValue.output;
  if (typeof returnValue.message === 'string') return returnValue.message;
  try {
    return JSON.stringify(returnValue, null, 2);
  } catch {
    return String(returnValue);
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
