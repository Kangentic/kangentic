import fs from 'node:fs';
import { streamJsonlRecords } from '../../shared/history-scan';
import { touchBounded } from '../../shared/bounded-lru';
import { forEachCompleteLine } from '../../shared/jsonl-complete-lines';
import type { PerToolStat, TranscriptToolCounts, TranscriptUsage } from '../../../../shared/types';

/**
 * Lifetime tokens, tool-call counts and per-tool result-size estimates read
 * from a Codex rollout, for the per-task stats (`transcriptUsage`,
 * `transcriptToolCounts`, `transcriptToolResultTokens`).
 *
 * Built from documentation for codex-cli 0.163.0 and not yet run against a
 * signed-in Codex. Sources, all at
 * https://raw.githubusercontent.com/openai/codex/rust-v0.163.0/codex-rs/:
 * - `history/src/lib.rs` `RolloutLine`: every line carries `timestamp`.
 * - `history/src/rollout_payload.rs`: the line types, `token_usage_record`
 *   among them (one per model response in 0.163, with `thread_id`,
 *   `response_id` and that response's `usage`).
 * - `protocol/src/protocol.rs` `TokenCountEvent`: an older rollout's only usage
 *   is `event_msg` `token_count`, whose `info.total_token_usage` is the thread's
 *   running total. Local rollouts date the records: 0.141.0 wrote none, 0.154.0 did.
 * - `protocol/src/models.rs` `ResponseItem`: `function_call`, `custom_tool_call`
 *   (every `apply_patch`, a FREEFORM tool per `core/src/tools/handlers/apply_patch_spec.rs`),
 *   `local_shell_call`, and their outputs, joined by `call_id`.
 * - `rollout/src/recorder.rs`: a resume appends to the same rollout
 *   (`open_rollout_for_append`), which is why every read here honors a time window.
 */

// ---------- Usage ----------

/**
 * The rollout's lifetime input and output tokens. Sums each
 * `token_usage_record`'s `usage` once per `response_id`, for the rollout's own
 * thread only (its `session_meta.payload.id`): a record of another thread, such
 * as a nested turn's, never adds to this one. A rollout with no such records
 * takes the last `token_count.info.total_token_usage`. One an older Codex
 * started and a newer one resumed has both, so the sum starts from the last
 * total written before its first record: a response's record comes before its
 * `token_count`, so that total holds none of the responses the records sum.
 * Codex's `input_tokens` already includes cached input, the same total Claude's
 * reader sums from its three input buckets. Null when the file could not be
 * read to the end or holds no usage.
 */
export async function codexTranscriptUsage(filePath: string): Promise<TranscriptUsage | null> {
  let threadId: string | null = null;
  const seenResponses = new Set<string>();
  let recordInput = 0;
  let recordOutput = 0;
  let sawRecord = false;
  let lastTotal: TranscriptUsage | null = null;
  let totalBeforeRecords: TranscriptUsage = { inputTokens: 0, outputTokens: 0 };
  const readWholeFile = await streamJsonlRecords(filePath, (line) => {
    const payload = line.payload;
    if (!isRecord(payload)) return;
    if (line.type === 'session_meta') {
      if (threadId === null && typeof payload.id === 'string') threadId = payload.id;
      return;
    }
    if (line.type === 'token_usage_record') {
      if (!belongsToThread(payload, threadId)) return;
      const responseId = typeof payload.response_id === 'string' ? payload.response_id : null;
      if (responseId) {
        if (seenResponses.has(responseId)) return;
        seenResponses.add(responseId);
      }
      const usage = payload.usage;
      if (!isRecord(usage)) return;
      if (!sawRecord && lastTotal) totalBeforeRecords = lastTotal;
      sawRecord = true;
      recordInput += numberOrZero(usage.input_tokens);
      recordOutput += numberOrZero(usage.output_tokens);
      return;
    }
    if (line.type === 'event_msg' && payload.type === 'token_count' && isRecord(payload.info)) {
      const total = payload.info.total_token_usage;
      if (isRecord(total)) {
        lastTotal = { inputTokens: numberOrZero(total.input_tokens), outputTokens: numberOrZero(total.output_tokens) };
      }
    }
  });
  if (!readWholeFile) return null;
  if (sawRecord) {
    return {
      inputTokens: totalBeforeRecords.inputTokens + recordInput,
      outputTokens: totalBeforeRecords.outputTokens + recordOutput,
    };
  }
  return lastTotal;
}

/**
 * A usage record names its thread; one that names none is taken as the
 * rollout's own. This reader sees the whole file, so it compares with the
 * `session_meta` id. The live tail parser (`session-history-parser.ts`) sees
 * only appended chunks with no `session_meta`, so it compares the record's own
 * `thread_id` and `session_id`: the same answer for a record that carries both.
 */
function belongsToThread(payload: Record<string, unknown>, threadId: string | null): boolean {
  if (threadId === null || typeof payload.thread_id !== 'string') return true;
  return payload.thread_id === threadId;
}

// ---------- Tool names ----------

/**
 * The tool a hook reports for this call, so a count from the rollout lands on
 * the same row as the live count the hooks feed. From codex-cli 0.163.0's
 * source (`codex-rs/core/src/tools/`):
 * - `exec_command` (and the `local_shell_call` item): `Bash`
 *   (`handlers/unified_exec.rs`, `HookToolName::bash()`), which the captured
 *   PreToolUse in `tests/fixtures/codex-hooks/` shows too.
 * - `apply_patch` and `spawn_agent` keep their names (`hook_names.rs`).
 * - An MCP call is `mcp__<namespace>__<name>`, its namespace's trailing and the
 *   name's leading underscores trimmed (`handlers/mcp.rs`, `join_tool_name` and
 *   `ensure_mcp_prefix`).
 * - Anything else keeps the name the rollout records.
 */
export function codexHookToolName(name: string, namespace: string | null): string {
  if (name === 'exec_command' || name === 'local_shell') return 'Bash';
  if (namespace && namespace.startsWith('mcp__')) {
    const joined = `${namespace.replace(/_+$/, '')}__${name.replace(/^_+/, '')}`;
    return joined.startsWith('mcp__') ? joined : `mcp__${joined}`;
  }
  return name;
}

/**
 * Calls no hook reports, left out of the counts so the rollout and the live
 * count agree: a `write_stdin` poll fires no PreToolUse (measured on 0.163.0,
 * see hook-manager.ts).
 */
const UNHOOKED_TOOLS: ReadonlySet<string> = new Set(['write_stdin']);

/** One tool call in a rollout line, or null for any other line. */
interface RolloutToolCall {
  callId: string;
  toolName: string;
}

function toolCallOf(line: Record<string, unknown>): RolloutToolCall | null {
  if (line.type !== 'response_item' || !isRecord(line.payload)) return null;
  const payload = line.payload;
  const callId = typeof payload.call_id === 'string' && payload.call_id.length > 0 ? payload.call_id : null;
  if (!callId) return null;
  if (payload.type === 'local_shell_call') return { callId, toolName: codexHookToolName('local_shell', null) };
  if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') return null;
  const name = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : null;
  if (!name || UNHOOKED_TOOLS.has(name)) return null;
  const namespace = typeof payload.namespace === 'string' && payload.namespace.length > 0 ? payload.namespace : null;
  return { callId, toolName: codexHookToolName(name, namespace) };
}

/** A line's own time, or null when it carries none (it then counts only in an open window). */
function lineTimeMs(line: Record<string, unknown>): number | null {
  if (typeof line.timestamp !== 'string') return null;
  const parsed = Date.parse(line.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether a call at `timeMs` falls in `[sinceMs, untilMs)`. A call with no time
 * counts in an open window and is left out of a closed one, the contract
 * `transcriptToolCounts` states.
 */
function inWindow(timeMs: number | null, sinceMs: number | null | undefined, untilMs: number | null | undefined): boolean {
  if (timeMs === null) return untilMs === null || untilMs === undefined;
  if (typeof sinceMs === 'number' && timeMs < sinceMs) return false;
  if (typeof untilMs === 'number' && timeMs >= untilMs) return false;
  return true;
}

// ---------- Tool counts ----------

/**
 * Distinct tool calls by hook name, made at or after `sinceMs` and before
 * `untilMs`. Null when the file could not be read to the end or holds no call.
 */
export async function codexTranscriptToolCounts(
  filePath: string,
  sinceMs?: number | null,
  untilMs?: number | null,
): Promise<TranscriptToolCounts | null> {
  const seenCalls = new Set<string>();
  const countsByTool = new Map<string, number>();
  const readWholeFile = await streamJsonlRecords(filePath, (line) => {
    const call = toolCallOf(line);
    if (!call || seenCalls.has(call.callId)) return;
    if (!inWindow(lineTimeMs(line), sinceMs, untilMs)) return;
    seenCalls.add(call.callId);
    countsByTool.set(call.toolName, (countsByTool.get(call.toolName) ?? 0) + 1);
  });
  if (!readWholeFile || countsByTool.size === 0) return null;
  const toolBreakdown: PerToolStat[] = Array.from(countsByTool.entries())
    .map(([toolName, callCount]) => ({ toolName, callCount, totalDurationMs: 0, interruptedCount: 0 }))
    .sort((first, second) => (second.callCount - first.callCount) || first.toolName.localeCompare(second.toolName));
  const toolCallCount = toolBreakdown.reduce((sum, stat) => sum + stat.callCount, 0);
  return { toolCallCount, toolBreakdown };
}

// ---------- Result tokens ----------

/**
 * The chars/4 estimate, the same rule as `retrieval/token-estimate.ts`. Kept
 * here rather than imported: this module is reached from the agent registry,
 * which the pty host bundles, and the host's graph may not reach
 * `src/main/retrieval/` (`tests/unit/pty-host-boundary.test.ts`). An output's
 * image items are not estimated: a rollout records them as data URLs, and
 * their bytes say nothing about the tokens the model was billed for.
 */
function estimateOutputTokens(output: unknown): number {
  if (typeof output === 'string') return Math.ceil(output.length / 4);
  if (!Array.isArray(output)) return 0;
  let total = 0;
  for (const item of output) {
    if (isRecord(item) && typeof item.text === 'string') total += Math.ceil(item.text.length / 4);
  }
  return total;
}

/** One output's estimate, kept with its tool and time. */
interface ResultEstimate {
  toolName: string;
  timeMs: number | null;
  tokens: number;
}

/** What one rollout's earlier reads found, so a repeat reads only what was appended since. */
interface ResultCursor {
  /** Bytes consumed through the last whole line. */
  offset: number;
  /** The file's size at the last read: a smaller file was rewritten, and is read again from the start. */
  size: number;
  /** Tool name by `call_id`, for outputs still to come. */
  callTools: Map<string, string>;
  results: ResultEstimate[];
}

/** Cursors by path, oldest dropped first. The popover asks for a handful of live sessions. */
const resultCursors = new Map<string, ResultCursor>();
/**
 * Each path's latest read. A new call chains onto it, so two overlapping
 * popover refetches never advance one cursor at once (both would push the same
 * outputs and move the offset past bytes neither read).
 */
const resultReads = new Map<string, Promise<void>>();
const RESULT_CURSOR_LIMIT = 16;
/** Retained bytes per kept output or pending call, with headroom (Claude's cursor measured about 88). */
const RESULT_BYTES_PER_ENTRY = 128;
const RESULT_CURSOR_BYTE_BUDGET = 32 * 1024 * 1024;

/** Forget every cursor. For tests. */
export function resetCodexResultCursorsForTests(): void {
  resultCursors.clear();
  resultReads.clear();
}

function resultCursorBytes(cursor: ResultCursor): number {
  return (cursor.results.length + cursor.callTools.size) * RESULT_BYTES_PER_ENTRY;
}

function retainResultCursor(filePath: string, cursor: ResultCursor): void {
  touchBounded(resultCursors, filePath, cursor, {
    limit: RESULT_CURSOR_LIMIT,
    byteBudget: RESULT_CURSOR_BYTE_BUDGET,
    sizeOf: resultCursorBytes,
    // The rollout being polled live; evicting it would re-read it whole on the next refetch.
    minRetained: 1,
  });
}

/** Record one rollout line on the cursor: a call's tool name, or an output's estimate. */
function applyResultLine(cursor: ResultCursor, lineText: string): void {
  let line: unknown;
  try {
    line = JSON.parse(lineText);
  } catch {
    return;
  }
  if (!isRecord(line)) return;
  const call = toolCallOf(line);
  if (call) {
    cursor.callTools.set(call.callId, call.toolName);
    return;
  }
  if (line.type !== 'response_item' || !isRecord(line.payload)) return;
  const payload = line.payload;
  if (payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output') return;
  const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
  const toolName = callId ? cursor.callTools.get(callId) : undefined;
  if (!callId || !toolName) return;
  cursor.callTools.delete(callId);
  cursor.results.push({ toolName, timeMs: lineTimeMs(line), tokens: estimateOutputTokens(payload.output) });
}

/**
 * Bring the cursor for `filePath` up to the file's end, in the shared reader's
 * fixed-size chunks. Only whole lines are consumed, so a line still being
 * written is read on the next call. Null when the file cannot be read, which
 * drops the cursor.
 */
async function advanceCursor(filePath: string): Promise<ResultCursor | null> {
  let size: number;
  try {
    size = (await fs.promises.stat(filePath)).size;
  } catch {
    resultCursors.delete(filePath);
    return null;
  }
  const existing = resultCursors.get(filePath);
  const cursor: ResultCursor = existing && size >= existing.size
    ? existing
    : { offset: 0, size: 0, callTools: new Map(), results: [] };
  if (size === cursor.offset) {
    cursor.size = size;
    retainResultCursor(filePath, cursor);
    return cursor;
  }
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, 'r');
    cursor.offset = await forEachCompleteLine(handle, filePath, cursor.offset, size, (lineText) => {
      applyResultLine(cursor, lineText);
    });
    cursor.size = size;
    retainResultCursor(filePath, cursor);
    return cursor;
  } catch {
    resultCursors.delete(filePath);
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Advance `filePath`'s cursor, then answer `view` from it, in one step that
 * runs after the path's previous step, so no other read moves the cursor in
 * between. Null when the read failed.
 */
function withResultCursor<T>(filePath: string, view: (cursor: ResultCursor) => T): Promise<T | null> {
  const previous = resultReads.get(filePath) ?? Promise.resolve();
  const step = async (): Promise<T | null> => {
    const cursor = await advanceCursor(filePath);
    return cursor ? view(cursor) : null;
  };
  // Run after the previous read either way: a failure there must not fail this one.
  const next = previous.then(step, step);
  const settled = next.then(() => undefined, () => undefined);
  resultReads.set(filePath, settled);
  void settled.then(() => {
    if (resultReads.get(filePath) === settled) resultReads.delete(filePath);
  });
  return next;
}

/**
 * Estimated result tokens per hook tool name for the outputs written at or
 * after `sinceMs` and before `untilMs`. Cheap to repeat: each call reads only
 * the bytes appended since the last one. Null when the file cannot be read.
 */
export function codexTranscriptToolResultTokens(
  filePath: string,
  sinceMs?: number | null,
  untilMs?: number | null,
): Promise<Record<string, number> | null> {
  return withResultCursor(filePath, (cursor) => {
    // A Map, not a plain object: a tool name is rollout text, and `constructor`
    // or `__proto__` would read or write Object.prototype's member.
    const tokensByTool = new Map<string, number>();
    for (const result of cursor.results) {
      if (!inWindow(result.timeMs, sinceMs, untilMs)) continue;
      tokensByTool.set(result.toolName, (tokensByTool.get(result.toolName) ?? 0) + result.tokens);
    }
    return Object.fromEntries(tokensByTool);
  });
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
