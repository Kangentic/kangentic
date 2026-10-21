import os from 'node:os';
import path from 'node:path';
import type { TranscriptEntry, TranscriptBlock, TranscriptEntryOrigin } from '../../../../shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../agent-adapter';
import { readJsonlWindow } from '../../shared/history-scan';
import { encodeJsonlCursor, readJsonlHistoryPage, splitJsonlLines, type JsonlLine } from '../../shared/jsonl-history-page';
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
export async function parseKimiTranscript(
  agentSessionId: string,
  filePath: string,
): Promise<TranscriptEntry[]> {
  // Bounded tail read rather than a whole-file one: a transcript has no size
  // ceiling, and reading one whole is what OOM'd the main process.
  // `countOmittedLines` because the uuids below embed the ABSOLUTE physical
  // line index. `wire.jsonl` is an append-only event stream, so it is stable.
  const window = await readJsonlWindow(filePath, {
    maxBytes: parseWindowBytes(),
    countOmittedLines: true,
  });
  if (window.totalBytes === 0) return [];

  // Line indices stay absolute within the FILE, so the lines are numbered from
  // the count before the window.
  const entries = parseKimiLines(agentSessionId, splitJsonlLines(window.text, window.startByte, window.omittedLineCount));
  // The notice carries the cursor the Conversation viewer pages the left-out
  // history from (`readKimiTranscriptPage`), with the line count the uuids need.
  return prependTruncationMarker(entries, window.omittedBytes, window.totalBytes, {
    conversationId: agentSessionId,
    cursor: encodeJsonlCursor({ byte: window.startByte, line: window.omittedLineCount }),
  });
}

/**
 * One page of a Kimi wire file's history for the Conversation viewer
 * (`AgentAdapter.readTranscriptPage`). Every uuid is named by its line, so
 * cursors carry a line count.
 */
export function readKimiTranscriptPage(
  agentSessionId: string,
  filePath: string,
  request: TranscriptPageReadRequest,
): Promise<TranscriptPageReadResult> {
  return readJsonlHistoryPage({
    filePath,
    request,
    countLines: true,
    parseLines: (lines) => parseKimiLines(agentSessionId, lines),
  });
}

/**
 * Parse whole lines into entries. A single-record entry is stamped with the
 * byte its own line starts at; a flushed text run with the byte its first
 * fragment's line starts at, the same line its uuid names.
 */
function parseKimiLines(agentSessionId: string, lines: ReadonlyArray<JsonlLine>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let pendingAssistantText = '';
  let pendingTs = 0;
  // The line the CURRENT pending run of ContentPart fragments started on,
  // captured alongside `pendingTs` for the same reason: the flushed entry
  // belongs to where its text began, not to the boundary record that happened
  // to trigger the flush. It is also what keeps the uuid unique - a boundary
  // line emits at most its own entry plus this flush, and the two therefore
  // never claim the same line.
  //
  // KNOWN RESIDUAL, over-cap transcripts only. This is the line the run starts
  // on IN THESE LINES, which is its true start only while the whole run is
  // visible. The tail's start and each history page's edges are seams, and
  // nothing crosses one. A seam between two fragments of one run cuts it in
  // two: the lines before it flush their fragments at their end, under the
  // run's own first line (the uuid a whole-file parse gives the run), and the
  // lines after it start a fresh run named after the first fragment they hold.
  // The viewer shows the two halves as two rows, and each half is trimmed on
  // its own, so whitespace at the cut is lost. As the tail slides, its first
  // run re-anchors the same way. Usually harmless for citations: the dropped
  // fragment also changes the flushed text, so the chunk diverges and is
  // re-inserted with the new anchor rather than keeping a stale one. It goes
  // stale only when the dropped leading fragment contributes nothing after
  // `.trim()` (a whitespace-only fragment), leaving byte-identical text under a
  // shifted uuid. Resolving any of it means carrying the run's start across
  // reads, which this deliberately stateless parser has no place to keep.
  let pendingLineNumber = 0;
  let pendingOrigin: TranscriptEntryOrigin = { conversationId: agentSessionId, position: 0 };
  // Session-scoped and ABSOLUTE; see the fuller note in the Codex parser, which
  // has the identical shape and the identical two bugs behind it. Kimi's wire
  // records carry no per-record id either (only ToolCall/ToolResult do, as a
  // shared pair).
  const uuidForLine = (lineNumber: number): string => `${agentSessionId}:${lineNumber}`;

  const flushAssistantText = (): void => {
    const text = pendingAssistantText.trim();
    if (text.length > 0) {
      entries.push({
        kind: 'assistant',
        uuid: uuidForLine(pendingLineNumber),
        ts: pendingTs,
        blocks: [{ type: 'text', text }],
        origin: pendingOrigin,
      });
    }
    pendingAssistantText = '';
  };

  for (const { text: line, byte, line: countedLine } of lines) {
    if (line.length === 0) continue;
    // A page's first pass parses without line numbers only to find where its
    // entries begin, then parses again numbered.
    const lineNumber = countedLine ?? 0;
    const origin: TranscriptEntryOrigin = { conversationId: agentSessionId, position: byte };
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
      if (text) entries.push({ kind: 'user', uuid: uuidForLine(lineNumber), ts, text, origin });
      continue;
    }

    if (type === 'ContentPart') {
      const fragment = extractContentPartText(payload);
      if (fragment) {
        if (pendingAssistantText.length === 0) {
          pendingTs = ts;
          pendingLineNumber = lineNumber;
          pendingOrigin = origin;
        }
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
      entries.push({ kind: 'assistant', uuid: uuidForLine(lineNumber), ts, blocks, origin });
      continue;
    }

    if (type === 'ToolResult') {
      const toolUseId = typeof payload.tool_call_id === 'string' ? payload.tool_call_id : '';
      const returnValue = isRecord(payload.return_value) ? payload.return_value : {};
      entries.push({
        kind: 'tool_result',
        uuid: uuidForLine(lineNumber),
        ts,
        toolUseId,
        content: extractToolResultContent(returnValue),
        isError: returnValue.is_error === true,
        origin,
      });
      continue;
    }

    // TurnEnd closes out any pending assistant text. Other events (StatusUpdate,
    // hooks) pass through a run without ending it.
    if (type === 'TurnEnd') flushAssistantText();
  }

  // Also where a run a seam cuts flushes its first half (see above).
  flushAssistantText();
  return entries;
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
