import fs from 'node:fs/promises';
import type { PerToolStat, TranscriptToolCounts, TranscriptUsage } from '../../../../shared/types';
import { touchBounded } from '../../shared/bounded-lru';
import { turnUsageFromTokens } from './transcript-parser';

/**
 * Lifetime token usage, tool-call counts and tool-result token estimates read
 * from Gemini CLI's chat file (`~/.gemini/tmp/<project>/chats/session-*.jsonl`).
 *
 * The record shapes come from the CLI's own source at v0.66.0,
 * https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/services/chatRecordingTypes.ts
 * and chatRecordingService.ts beside it:
 *   - a `gemini` message carries `tokens` (`input` = promptTokenCount, which
 *     includes the cached part; `output` = candidatesTokenCount; `cached`;
 *     `thoughts` = thoughtsTokenCount; `tool`; `total`) and `toolCalls[]`, each
 *     `{ id, name, args, result?, status, timestamp }`;
 *   - a message is appended again under the same `id` when its tool calls or
 *     tokens are recorded, and the later copy replaces the earlier one;
 *   - a tool's result arrives later as `{ $patch: { id, toolCalls: [{ id,
 *     result }] } }`, or inside `$patch.updates[]`;
 *   - a `$set` line may carry a whole `messages[]` (the deprecated checkpoint),
 *     and a legacy `.json` session is one object with `messages[]`.
 *   - resuming a session appends to the same file, so one file holds every run.
 *
 * Built from that source, not yet run against the real CLI.
 *
 * One cursor per path serves all three reads. It keeps a few numbers per
 * message and per call, never the transcript, and resumes from the last
 * complete line, so the tool-call popover's refetch on every tool call reads
 * only the bytes Gemini appended since.
 */

interface GeminiToolCall {
  /** Epoch ms of the call (its own `timestamp`, else its message's). +Infinity when neither parses. */
  timeMs: number;
  toolName: string;
  /** Estimated result tokens, once a result is recorded. */
  resultTokens: number | undefined;
}

interface MessageTokens {
  inputTokens: number;
  outputTokens: number;
}

interface GeminiUsageCursor {
  /** File identity at the last read; a different inode is a replaced file. */
  ino: number;
  mtimeMs: number;
  /** First byte not yet consumed: always just past a complete line. */
  offset: number;
  /** The bytes just before `offset` at the last read, to catch a file rewritten in place. */
  tail: Buffer;
  calls: GeminiToolCall[];
  callById: Map<string, GeminiToolCall>;
  /** The last `tokens` each message id carried. Rewinds are NOT applied: a rewound turn was still billed. */
  tokensByMessageId: Map<string, MessageTokens>;
  /** Tokens of messages with no id, which cannot be re-emitted and are summed as read. */
  anonymousTokens: MessageTokens;
}

const CURSOR_LIMIT = 16;
const BYTES_PER_ENTRY = 128;
const CURSOR_BYTE_BUDGET = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 64;
/** About four characters a token, the estimate claude/tool-result-tokens.ts also makes. */
const CHARACTERS_PER_TOKEN = 4;

const cursorByPath = new Map<string, GeminiUsageCursor>();
const readByPath = new Map<string, Promise<void>>();

/** Test-only: drop every cursor between cases. */
export function resetGeminiUsageCursorsForTests(): void {
  cursorByPath.clear();
  readByPath.clear();
}

/**
 * Cumulative tokens for the whole chat file: for each message id, the last
 * `tokens` it carried. Input is the full input side (`input`, which already
 * includes the cached tokens); output is `output` plus `thoughts`, since
 * thinking tokens are billed as output. Null when the file cannot be read or
 * holds no token record.
 */
export function geminiTranscriptUsage(filePath: string): Promise<TranscriptUsage | null> {
  return withCursor(filePath, (cursor) => {
    let inputTokens = cursor.anonymousTokens.inputTokens;
    let outputTokens = cursor.anonymousTokens.outputTokens;
    for (const tokens of cursor.tokensByMessageId.values()) {
      inputTokens += tokens.inputTokens;
      outputTokens += tokens.outputTokens;
    }
    if (cursor.tokensByMessageId.size === 0 && inputTokens === 0 && outputTokens === 0) return null;
    return { inputTokens, outputTokens };
  });
}

/**
 * Distinct tool calls (by call id) made at or after `sinceMs` and before
 * `untilMs`, by tool name, with their estimated result tokens. Null when the
 * file cannot be read or no call falls in the window, so the caller keeps the
 * live count.
 */
export function geminiTranscriptToolCounts(
  filePath: string,
  sinceMs?: number | null,
  untilMs?: number | null,
): Promise<TranscriptToolCounts | null> {
  return withCursor(filePath, (cursor) => {
    const countByTool = new Map<string, number>();
    const resultTokensByTool = new Map<string, number>();
    let toolCallCount = 0;
    for (const call of callsInWindow(cursor, sinceMs, untilMs)) {
      toolCallCount += 1;
      countByTool.set(call.toolName, (countByTool.get(call.toolName) ?? 0) + 1);
      if (call.resultTokens !== undefined) {
        resultTokensByTool.set(call.toolName, (resultTokensByTool.get(call.toolName) ?? 0) + call.resultTokens);
      }
    }
    if (toolCallCount === 0) return null;
    const toolBreakdown: PerToolStat[] = Array.from(countByTool, ([toolName, callCount]) => {
      const stat: PerToolStat = { toolName, callCount, totalDurationMs: 0, interruptedCount: 0 };
      const resultTokens = resultTokensByTool.get(toolName);
      if (resultTokens !== undefined) stat.resultTokens = resultTokens;
      return stat;
    });
    return { toolCallCount, toolBreakdown };
  });
}

/**
 * Estimated result tokens per tool name for the calls in the window. A tool
 * with no result yet is absent. Null only when the file cannot be read.
 */
export function geminiTranscriptToolResultTokens(
  filePath: string,
  sinceMs?: number | null,
  untilMs?: number | null,
): Promise<Record<string, number> | null> {
  return withCursor(filePath, (cursor) => {
    const resultTokensByTool: Record<string, number> = {};
    for (const call of callsInWindow(cursor, sinceMs, untilMs)) {
      if (call.resultTokens === undefined) continue;
      resultTokensByTool[call.toolName] = (resultTokensByTool[call.toolName] ?? 0) + call.resultTokens;
    }
    return resultTokensByTool;
  });
}

/**
 * The calls with `sinceMs <= time < untilMs`; a missing bound is open. A call
 * with no time counts under an open window and is left out of a closed one,
 * which cannot claim a call it cannot place.
 */
function* callsInWindow(
  cursor: GeminiUsageCursor,
  sinceMs: number | null | undefined,
  untilMs: number | null | undefined,
): Generator<GeminiToolCall> {
  const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) ? sinceMs : Number.NEGATIVE_INFINITY;
  const until = typeof untilMs === 'number' && Number.isFinite(untilMs) ? untilMs : Number.POSITIVE_INFINITY;
  const closed = until !== Number.POSITIVE_INFINITY;
  for (const call of cursor.calls) {
    if (call.timeMs < since) continue;
    if (closed && !(call.timeMs < until)) continue;
    yield call;
  }
}

/**
 * Advance the path's cursor to the end of the file, then answer `view` from it
 * in the same step. Steps for one path run one after another, so overlapping
 * refetches never read the same bytes twice. Null when the read failed.
 */
function withCursor<T>(filePath: string, view: (cursor: GeminiUsageCursor) => T | null): Promise<T | null> {
  const previous = readByPath.get(filePath) ?? Promise.resolve();
  const step = async (): Promise<T | null> => {
    const cursor = await advanceCursor(filePath);
    return cursor ? view(cursor) : null;
  };
  // Run after the previous read either way: a failure there must not fail this one.
  const next = previous.then(step, step);
  const settled = next.then(() => undefined, () => undefined);
  readByPath.set(filePath, settled);
  void settled.then(() => {
    if (readByPath.get(filePath) === settled) readByPath.delete(filePath);
  });
  return next;
}

function emptyCursor(ino: number, mtimeMs: number): GeminiUsageCursor {
  return {
    ino,
    mtimeMs,
    offset: 0,
    tail: Buffer.alloc(0),
    calls: [],
    callById: new Map(),
    tokensByMessageId: new Map(),
    anonymousTokens: { inputTokens: 0, outputTokens: 0 },
  };
}

async function advanceCursor(filePath: string): Promise<GeminiUsageCursor | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    cursorByPath.delete(filePath);
    return null;
  }
  const size = Number(stat.size);
  const mtimeMs = Number(stat.mtimeMs);
  const ino = Number(stat.ino);
  const existing = cursorByPath.get(filePath);
  if (existing && size === existing.offset && mtimeMs === existing.mtimeMs && ino === existing.ino) {
    retainCursor(filePath, existing);
    return existing;
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    if (filePath.endsWith('.json')) {
      // A legacy session (Gemini 0.37 and earlier) is one JSON document,
      // pretty-printed and rewritten whole on every message: small, and never
      // a line-by-line read. Any change reads it again from the start.
      const fresh = emptyCursor(ino, mtimeMs);
      const document = parseRecord(await handle.readFile('utf8'));
      if (document) applyRecord(fresh, document);
      fresh.offset = size;
      retainCursor(filePath, fresh);
      return fresh;
    }
    let cursor = existing;
    // A shrink, an mtime going back, a new inode, or changed bytes before the
    // offset (a file rewritten in place) start over.
    if (!cursor || size < cursor.offset || mtimeMs < cursor.mtimeMs || ino !== cursor.ino
        || !(await readTail(handle, cursor.offset)).equals(cursor.tail)) {
      cursor = emptyCursor(ino, mtimeMs);
    }
    const advancing = cursor;
    advancing.offset = await forEachCompleteLine(handle, advancing.offset, size, (line) => applyLine(advancing, line));
    advancing.tail = await readTail(handle, advancing.offset);
    advancing.ino = ino;
    advancing.mtimeMs = mtimeMs;
    retainCursor(filePath, advancing);
    return advancing;
  } catch {
    cursorByPath.delete(filePath);
    return null;
  } finally {
    await handle?.close();
  }
}

function retainCursor(filePath: string, cursor: GeminiUsageCursor): void {
  touchBounded(cursorByPath, filePath, cursor, {
    limit: CURSOR_LIMIT,
    byteBudget: CURSOR_BYTE_BUDGET,
    sizeOf: (held) => (held.calls.length + held.tokensByMessageId.size) * BYTES_PER_ENTRY,
    // The session being polled live is the one most likely to pass the budget
    // alone; evicting it would re-read the whole file on the next refetch.
    minRetained: 1,
  });
}

async function readTail(handle: Awaited<ReturnType<typeof fs.open>>, offset: number): Promise<Buffer> {
  const length = Math.min(TAIL_BYTES, offset);
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
  return buffer.subarray(0, bytesRead);
}

/**
 * Call `onLine` for every complete line in `[startByte, endByte)`, reading in
 * fixed-size chunks. Returns the offset just past the last line consumed, so a
 * line still being written is left for the next read. A final line with no
 * newline is consumed only when it parses as JSON (a legacy single-document
 * session has none). Throws on a short read, so the caller drops its state.
 */
async function forEachCompleteLine(
  handle: Awaited<ReturnType<typeof fs.open>>,
  startByte: number,
  endByte: number,
  onLine: (line: string) => void,
): Promise<number> {
  let position = startByte;
  let consumedTo = startByte;
  let pending: Buffer[] = [];
  while (position < endByte) {
    const length = Math.min(READ_CHUNK_BYTES, endByte - position);
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead < length) throw new Error('short read');
    let lineStart = 0;
    let newline = chunk.indexOf(0x0a, lineStart);
    while (newline !== -1) {
      const piece = chunk.subarray(lineStart, newline);
      const lineBuffer = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      onLine(lineBuffer.toString('utf8'));
      consumedTo = position + newline + 1;
      lineStart = newline + 1;
      newline = chunk.indexOf(0x0a, lineStart);
    }
    if (lineStart < chunk.length) pending.push(chunk.subarray(lineStart));
    position += length;
  }
  if (pending.length > 0) {
    const finalLine = Buffer.concat(pending).toString('utf8');
    if (parseRecord(finalLine) !== null) {
      onLine(finalLine);
      consumedTo = endByte;
    }
  }
  return consumedTo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseTimeMs(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  return Date.parse(value);
}

function applyLine(cursor: GeminiUsageCursor, line: string): void {
  // Most lines carry none of these; skip their JSON.parse.
  if (!line.includes('"tokens"') && !line.includes('"toolCalls"') && !line.includes('"messages"')) return;
  const record = parseRecord(line);
  if (record) applyRecord(cursor, record);
}

function applyRecord(cursor: GeminiUsageCursor, record: Record<string, unknown>): void {
  if (isRecord(record.$patch)) {
    applyPatch(cursor, record.$patch);
    return;
  }
  // The deprecated `$set` checkpoint, or a legacy single-document session.
  const seeded = isRecord(record.$set) ? record.$set.messages : record.messages;
  if (Array.isArray(seeded)) {
    for (const message of seeded) applyMessage(cursor, message);
    return;
  }
  applyMessage(cursor, record);
}

function applyMessage(cursor: GeminiUsageCursor, message: unknown): void {
  if (!isRecord(message) || message.type !== 'gemini') return;
  const messageId = typeof message.id === 'string' && message.id.length > 0 ? message.id : null;
  const turnUsage = turnUsageFromTokens(message.tokens);
  if (turnUsage) {
    // The same arithmetic as the per-turn ledger rows, so the two add up:
    // the full input side is fresh input plus the cached read.
    const tokens: MessageTokens = {
      inputTokens: turnUsage.inputTokens + turnUsage.cacheReadInputTokens,
      outputTokens: turnUsage.outputTokens,
    };
    if (messageId !== null) {
      cursor.tokensByMessageId.set(messageId, tokens);
    } else {
      cursor.anonymousTokens.inputTokens += tokens.inputTokens;
      cursor.anonymousTokens.outputTokens += tokens.outputTokens;
    }
  }
  if (!Array.isArray(message.toolCalls)) return;
  const messageTimeMs = parseTimeMs(message.timestamp);
  for (const rawCall of message.toolCalls) {
    if (!isRecord(rawCall)) continue;
    const callId = typeof rawCall.id === 'string' && rawCall.id.length > 0 ? rawCall.id : null;
    const known = callId !== null ? cursor.callById.get(callId) : undefined;
    const resultTokens = 'result' in rawCall ? estimateResultTokens(rawCall.result) : undefined;
    if (known) {
      // A re-emitted message: keep the call once, take a result it now carries.
      if (resultTokens !== undefined) known.resultTokens = resultTokens;
      continue;
    }
    const callTimeMs = parseTimeMs(rawCall.timestamp);
    const timeMs = Number.isFinite(callTimeMs) ? callTimeMs
      : Number.isFinite(messageTimeMs) ? messageTimeMs
        : Number.POSITIVE_INFINITY;
    const call: GeminiToolCall = {
      timeMs,
      toolName: typeof rawCall.name === 'string' && rawCall.name.length > 0 ? rawCall.name : 'tool',
      resultTokens,
    };
    cursor.calls.push(call);
    if (callId !== null) cursor.callById.set(callId, call);
  }
}

/** A `$patch` record: tool results by call id, on the patch itself or in `updates[]`. */
function applyPatch(cursor: GeminiUsageCursor, patch: Record<string, unknown>): void {
  const patches: unknown[] = [patch, ...(Array.isArray(patch.updates) ? patch.updates : [])];
  for (const single of patches) {
    if (!isRecord(single) || !Array.isArray(single.toolCalls)) continue;
    for (const callPatch of single.toolCalls) {
      if (!isRecord(callPatch) || typeof callPatch.id !== 'string' || !('result' in callPatch)) continue;
      const call = cursor.callById.get(callPatch.id);
      if (!call) continue;
      const resultTokens = estimateResultTokens(callPatch.result);
      if (resultTokens !== undefined) call.resultTokens = resultTokens;
    }
  }
}

/**
 * Estimated tokens of a tool call's `result` (a `PartListUnion`): the text the
 * model reads back, at about four characters a token. A `functionResponse`
 * part's `response.output` is its text, and any other response is counted as
 * its JSON. Undefined for an absent or null result (still pending).
 */
export function estimateResultTokens(result: unknown): number | undefined {
  if (result === undefined || result === null) return undefined;
  let characters = 0;
  const parts = Array.isArray(result) ? result : [result];
  for (const part of parts) {
    if (typeof part === 'string') {
      characters += part.length;
      continue;
    }
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') characters += part.text.length;
    const functionResponse = part.functionResponse;
    if (isRecord(functionResponse) && functionResponse.response !== undefined) {
      const response = functionResponse.response;
      if (isRecord(response) && typeof response.output === 'string') {
        characters += response.output.length;
      } else {
        characters += safeJsonLength(response);
      }
    }
  }
  return Math.ceil(characters / CHARACTERS_PER_TOKEN);
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}
