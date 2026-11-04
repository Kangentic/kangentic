import type { TranscriptToolCounts, TranscriptUsage } from '../../../../shared/types';
import { streamJsonlRecords } from '../../shared/history-scan';
import {
  addToolCall,
  createToolCallCursorStore,
  resultTokensInWindow,
  toolCallTimestampMs,
  toolCountsInWindow,
  type ToolCallCursor,
  type ToolCallEntry,
} from '../../shared/tool-call-cursor';
import { qwenFunctionResponseText, qwenTurnUsage } from './transcript-parser';

/**
 * Lifetime tokens and tool calls read from Qwen Code's own session JSONL
 * (`<runtime>/projects/<slug>/chats/<sessionId>.jsonl`, `qwenChatsDir`), for
 * `AgentAdapter.transcriptUsage`, `transcriptToolCounts` and
 * `transcriptToolResultTokens`.
 *
 * Record shapes
 * (https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/services/chatRecordingService.ts):
 * - `assistant`: `message.parts[]` with `functionCall { id, name, args }`, and
 *   `usageMetadata` for that one API response (`recordAssistantTurn`).
 * - `tool_result`: `message.parts[]` with `functionResponse { id, name,
 *   response }` (`recordToolResult`). Older writers put the same parts in a
 *   `user` record, which is read too.
 * - `system` (ui_telemetry and the rest) repeats counts already on the
 *   assistant record, so it is never read here.
 * Every record carries `uuid` and an ISO `timestamp`. A `--resume` appends to
 * the same file, so a read is scoped to one run by time.
 *
 * Built from Qwen's source and the 0.15.3 fixture. The `tool_result` record
 * and the `functionCall { id }` / `functionResponse { id }` parts match a real
 * capture with tool calls, but no real tool-call sample is replayed in the
 * tests yet (`qwen-real-session-tools.jsonl` is hand-built).
 */

/**
 * Lifetime tokens over the whole transcript: the full input side of every
 * API response (`promptTokenCount`, cached part included, as Claude's
 * lifetime input counts cache reads) and its output (`qwenTurnUsage`, which
 * never counts reasoning twice). Assistant records are deduped by `uuid`.
 * Null on a missing file, a partial read, or no usage: these totals are
 * written to the session row as fact, so a partial sum is a wrong number,
 * not a smaller one.
 */
export async function parseQwenTranscriptUsage(filePath: string): Promise<TranscriptUsage | null> {
  const usageByRecord = new Map<string, { input: number; output: number }>();
  let anonymousIndex = 0;
  const readWholeFile = await streamJsonlRecords(filePath, (raw) => {
    if (raw.type !== 'assistant') return;
    const usage = qwenTurnUsage(raw.usageMetadata);
    if (!usage) return;
    const key = typeof raw.uuid === 'string' && raw.uuid.length > 0 ? raw.uuid : `line-${anonymousIndex++}`;
    usageByRecord.set(key, {
      input: usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
      output: usage.outputTokens,
    });
  });
  if (!readWholeFile || usageByRecord.size === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const entry of usageByRecord.values()) {
    inputTokens += entry.input;
    outputTokens += entry.output;
  }
  return { inputTokens, outputTokens };
}

/** Characters per token for a tool result's text, the estimate Claude's popover uses. */
const CHARACTERS_PER_TOKEN = 4;

/** The shared append cursor (`shared/tool-call-cursor.ts`), over Qwen's record shapes. */
const toolCallCursors = createToolCallCursorStore<ToolCallEntry>(applyToolCallLine);

/** Test-only: drop every tool-call cursor between cases. */
export function resetQwenToolCallCursorsForTests(): void {
  toolCallCursors.reset();
}

/**
 * Distinct tool calls (by `functionCall.id`) and a per-tool breakdown with
 * estimated result tokens, for calls made at or after `sinceMs` and before
 * `untilMs`. Null when the file cannot be read or no call is in scope, so the
 * caller keeps the live count.
 */
export function parseQwenTranscriptToolCounts(
  filePath: string,
  sinceMs?: number | null,
  untilMs?: number | null,
): Promise<TranscriptToolCounts | null> {
  return toolCallCursors.read(filePath, (cursor) => toolCountsInWindow(cursor, sinceMs, untilMs));
}

/**
 * Estimated result tokens per tool name in the same window, from the same
 * cursor. A tool with no result yet in scope is absent. Null when the file
 * cannot be read.
 */
export function parseQwenTranscriptToolResultTokens(
  filePath: string,
  sinceMs?: number | null,
  untilMs?: number | null,
): Promise<Record<string, number> | null> {
  return toolCallCursors.read(filePath, (cursor) => resultTokensInWindow(cursor, sinceMs, untilMs));
}

function applyToolCallLine(cursor: ToolCallCursor<ToolCallEntry>, line: string): void {
  // Most lines carry neither part; skip their JSON.parse entirely.
  const mayHoldCall = line.includes('"functionCall"');
  if (!mayHoldCall && !line.includes('"functionResponse"')) return;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(raw)) return;
  const message = raw.message;
  if (!isRecord(message) || !Array.isArray(message.parts)) return;

  if (raw.type === 'assistant') {
    if (!mayHoldCall) return;
    const ts = toolCallTimestampMs(raw.timestamp);
    for (const part of message.parts) {
      if (!isRecord(part) || !isRecord(part.functionCall)) continue;
      const call = part.functionCall;
      addToolCall(cursor, typeof call.id === 'string' ? call.id : '', {
        ts,
        toolName: typeof call.name === 'string' && call.name.length > 0 ? call.name : 'tool',
        resultTokens: undefined,
      });
    }
    return;
  }

  if (raw.type !== 'tool_result' && raw.type !== 'user') return;
  for (const part of message.parts) {
    if (!isRecord(part) || !isRecord(part.functionResponse)) continue;
    const response = part.functionResponse;
    if (typeof response.id !== 'string') continue;
    const call = cursor.callById.get(response.id);
    if (!call || call.resultTokens !== undefined) continue;
    call.resultTokens = Math.ceil(qwenFunctionResponseText(response.response).length / CHARACTERS_PER_TOKEN);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
