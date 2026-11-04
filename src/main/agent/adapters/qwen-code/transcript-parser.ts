import path from 'node:path';
import type { TranscriptEntry, TranscriptBlock, TranscriptTurnUsage } from '../../../../shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../agent-adapter';
import { countNewlinesBefore, readJsonlWindow } from '../../shared/history-scan';
import { jsonlEarlierHistory, readJsonlHistoryPage, splitJsonlLines, stampOrigin, type JsonlLine } from '../../shared/jsonl-history-page';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { qwenChatsDir } from './session-history-parser';
import type { CliPlace } from '../../shared/cli-target';

/** A Qwen record without its own uuid is named by its line, so the tail, its notice and every page count lines. */
const UUIDS_NUMBER_LINES = true;

/**
 * Parse Qwen Code's native session JSONL into agent-agnostic
 * `TranscriptEntry[]` for the MCP `get_transcript` structured format.
 *
 * Path: `<runtime>/projects/<sanitized-cwd>/chats/<sessionId>.jsonl` (see
 * `qwenChatsDir`). Append-only JSONL; each line is one event:
 *   - `type: 'user'`   -> `message: { role: 'user', parts: [...] }`
 *   - `type: 'assistant'` -> `message: { role: 'model', parts: [...] }`,
 *      plus model + usage telemetry (read elsewhere).
 *   - `type: 'system'` (ui_telemetry) -> skipped.
 *
 * `parts[]` shapes (Gemini/GenAI lineage):
 *   - `{ text }`                       -> text block
 *   - `{ text, thought: true }`        -> thinking block (verified on disk)
 *   - `{ functionCall: { id?, name, args } }`     -> tool_use     (schema-derived)
 *   - `{ functionResponse: { id?, response } }`   -> tool_result  (schema-derived)
 *
 * The functionCall/functionResponse shapes are inferred from the upstream
 * GenAI part schema (no real tool-call sessions were available locally to
 * pin them); they are handled defensively and degrade to text if absent.
 */
export async function parseQwenTranscript(
  agentSessionId: string,
  filePath: string,
): Promise<TranscriptEntry[]> {
  // Bounded tail read rather than a whole-file one: a transcript has no size
  // ceiling, and reading one whole is what OOM'd the main process.
  const window = await readJsonlWindow(filePath, {
    maxBytes: parseWindowBytes(),
    countOmittedLines: UUIDS_NUMBER_LINES,
  });
  if (window.totalBytes === 0) return [];
  // The line count is only used when a record turns out to lack its own
  // `uuid`. Resolved up front rather than lazily: the scan is free below the
  // cap and ~27ms on the largest transcript measured, which is not worth a
  // second code shape.
  const entries = parseQwenLines(agentSessionId, splitJsonlLines(window.text, window.startByte, window.omittedLineCount));
  // The notice carries the cursor the Conversation viewer pages the left-out
  // history from (`readQwenTranscriptPage`), with the line count the uuids need.
  return prependTruncationMarker(entries, window.omittedBytes, window.totalBytes, jsonlEarlierHistory(agentSessionId, window, UUIDS_NUMBER_LINES));
}

/**
 * Parse ONE bounded byte window of a Qwen transcript
 * (`AgentAdapter.parseTranscriptWindow`), for the conversation indexer's walk
 * of the whole file. Retains nothing between calls, and needs no
 * `attributedMessageIds` carry: each assistant record holds one API
 * response's usage, so no turn's tokens span two lines.
 *
 * Every record Qwen writes carries its own `uuid` (`ChatRecord.uuid` in
 * https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/services/chatRecordingService.ts,
 * and every line of the 0.15.3 fixture), so a window rarely needs a line count. Only when one
 * holds a record without one are the lines before it counted, so that
 * record's fallback uuid (`<sessionId>:<line>`) is the one the tail and the
 * pages mint. Without that, the turn-usage ledger would key one turn twice.
 */
export async function parseQwenTranscriptWindow(
  agentSessionId: string,
  filePath: string,
  startByte: number,
  maxBytes: number,
): Promise<{ entries: TranscriptEntry[]; nextByteOffset: number; totalBytes: number; firstByteOffset: number; endByte: number }> {
  const window = await readJsonlWindow(filePath, { startByte, maxBytes });
  let lines = splitJsonlLines(window.text, window.startByte, 0);
  if (lines.some((line) => line.text.length > 0 && !RECORD_UUID_PATTERN.test(line.text))) {
    const omittedLineCount = await countNewlinesBefore(filePath, window.startByte);
    lines = splitJsonlLines(window.text, window.startByte, omittedLineCount);
  }
  return {
    entries: parseQwenLines(agentSessionId, lines),
    nextByteOffset: window.nextByteOffset,
    totalBytes: window.totalBytes,
    firstByteOffset: window.startByte,
    endByte: window.endByte,
  };
}

/**
 * A record line naming its own non-empty `uuid`. Qwen writes `uuid` as each
 * record's first key, so the match is anchored there: a `"uuid"` nested in a
 * tool's args or response must not pass for the record's own. A record whose
 * uuid sits elsewhere only costs the line count.
 */
const RECORD_UUID_PATTERN = /^\{\s*"uuid"\s*:\s*"[^"]/;

/**
 * One page of a Qwen transcript's history for the Conversation viewer
 * (`AgentAdapter.readTranscriptPage`). A record without its own uuid is named
 * by its line, so cursors carry a line count.
 */
export function readQwenTranscriptPage(
  agentSessionId: string,
  filePath: string,
  request: TranscriptPageReadRequest,
): Promise<TranscriptPageReadResult> {
  return readJsonlHistoryPage({
    filePath,
    request,
    countLines: UUIDS_NUMBER_LINES,
    parseLines: (lines) => parseQwenLines(agentSessionId, lines),
  });
}

/** Parse whole lines into entries, each stamped with the byte its line starts at. */
function parseQwenLines(agentSessionId: string, lines: ReadonlyArray<JsonlLine>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const { text: line, byte, line: lineNumber } of lines) {
    if (line.length === 0) continue;
    const firstNew = entries.length;
    parseQwenRecord(agentSessionId, line, lineNumber ?? 0, entries);
    stampOrigin(entries, firstNew, agentSessionId, byte);
  }
  return entries;
}

/** Parse one JSONL record, appending what it yields. */
function parseQwenRecord(agentSessionId: string, line: string, lineNumber: number, entries: TranscriptEntry[]): void {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(raw)) return;

  const type = raw.type;
  // `tool_result` is its own record type in current Qwen (`ChatRecord.type`
  // is `user | assistant | tool_result | system`, and `recordToolResult`
  // writes `functionResponse` parts:
  // https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/services/chatRecordingService.ts,
  // not yet seen in a real Qwen transcript). Older writers put the same parts in a
  // `user` record, which is still read. `system` (ui_telemetry and the rest)
  // is skipped.
  if (type !== 'user' && type !== 'assistant' && type !== 'tool_result') return;
  const message = raw.message;
  if (!isRecord(message)) return;
  const parts = message.parts;
  if (!Array.isArray(parts)) return;

  // The record's own `uuid` is the best anchor available: intrinsic, stable
  // across re-parses, and already unique per session (real sessions carry
  // `uuid` / `parentUuid` / `sessionId` per line). Older or partial writers
  // may omit it, so fall back to the session-scoped absolute line index the
  // Codex and Kimi parsers use - see the fuller note there for why both
  // halves matter. Sharing one uuid across the several entries a single
  // record can emit is deliberate and pre-existing (Droid does the same).
  const uuid = typeof raw.uuid === 'string' && raw.uuid.length > 0
    ? raw.uuid
    : `${agentSessionId}:${lineNumber}`;
  const ts = parseTimestamp(raw.timestamp);

  if (type === 'user' || type === 'tool_result') {
    const textParts: string[] = [];
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (isRecord(part.functionResponse)) {
        const response = part.functionResponse;
        entries.push({
          kind: 'tool_result',
          uuid,
          ts,
          toolUseId: typeof response.id === 'string' ? response.id : '',
          content: qwenFunctionResponseText(response.response),
        });
      } else if (typeof part.text === 'string') {
        textParts.push(part.text);
      }
    }
    // A tool result's text parts are the tool's output, not something the
    // user typed.
    const text = textParts.join('').trim();
    if (type === 'user' && text.length > 0) entries.push({ kind: 'user', uuid, ts, text });
    return;
  }

  // assistant
  const model = typeof raw.model === 'string' ? raw.model : undefined;
  const blocks: TranscriptBlock[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (isRecord(part.functionCall)) {
      const call = part.functionCall;
      blocks.push({
        type: 'tool_use',
        id: typeof call.id === 'string' ? call.id : '',
        name: typeof call.name === 'string' ? call.name : 'tool',
        input: call.args,
      });
    } else if (part.thought === true && typeof part.text === 'string') {
      if (part.text.trim().length > 0) blocks.push({ type: 'thinking', text: part.text });
    } else if (typeof part.text === 'string') {
      if (part.text.trim().length > 0) blocks.push({ type: 'text', text: part.text });
    }
  }
  if (blocks.length > 0) {
    const usage = qwenTurnUsage(raw.usageMetadata);
    entries.push({ kind: 'assistant', uuid, ts, model, blocks, ...(usage ? { usage } : {}) });
  }
}

/**
 * One assistant record's tokens in Kangentic's per-turn shape, or undefined
 * when the record carries no usage.
 *
 * Qwen writes `usageMetadata` once per API response on each assistant record
 * (`recordAssistantTurn`,
 * https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/services/chatRecordingService.ts),
 * in the GenAI shape:
 * - `promptTokenCount` includes the cached part, `cachedContentTokenCount`, so
 *   fresh input is the difference and the cached part is a cache read.
 * - Output follows Qwen's own rule (`outputTokenCount`,
 *   https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/telemetry/gen-ai-usage.ts): an
 *   OpenAI-compatible provider counts reasoning inside
 *   `candidatesTokenCount`, Gemini reports it apart in `thoughtsTokenCount`.
 *   `totalTokenCount - promptTokenCount` decides when it falls between the
 *   two conventions; otherwise the candidates count stands, which never
 *   counts reasoning twice.
 * Qwen reports no cache writes. Built from Qwen's source, not yet checked
 * against a real Qwen transcript beyond the 0.15.3 fixture.
 */
export function qwenTurnUsage(value: unknown): TranscriptTurnUsage | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = nonNegative(value.promptTokenCount);
  const cached = nonNegative(value.cachedContentTokenCount);
  const candidates = nonNegative(value.candidatesTokenCount);
  const thoughts = nonNegative(value.thoughtsTokenCount);
  const total = nonNegative(value.totalTokenCount);
  if (prompt === 0 && cached === 0 && candidates === 0 && thoughts === 0) return undefined;
  const derivedOutput = total - prompt;
  const outputTokens = total > 0 && derivedOutput >= candidates && derivedOutput <= candidates + thoughts
    ? derivedOutput
    : candidates;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cached,
  };
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Build the absolute path to Qwen's session JSONL for a known session id and
 * cwd. The filename is exactly `<sessionId>.jsonl` (the adapter owns the id
 * via `--session-id`). Non-polling; the parser tolerates a missing file.
 * `place`: a Qwen in a WSL distro keeps it in the distro (`qwenChatsDir`).
 */
export function locateQwenTranscriptFile(agentSessionId: string, cwd: string, place: CliPlace | null = null): string {
  return path.join(qwenChatsDir(cwd, place), `${agentSessionId}.jsonl`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Stringify a functionResponse `response` (often `{ output }` or a string). */
export function qwenFunctionResponseText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.output === 'string') return value.output;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
