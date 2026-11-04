import type { PerToolStat, TranscriptBlock, TranscriptEntry, TranscriptToolCounts, TranscriptUsage } from '../../../../shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../agent-adapter';
import { readJsonlWindow, streamJsonlRecords } from '../../shared/history-scan';
import { jsonlEarlierHistory, readJsonlHistoryPage, splitJsonlLines, stampOrigin, type JsonlLine } from '../../shared/jsonl-history-page';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';

/**
 * Copilot CLI's session event log, `<config home>/session-state/<id>/events.jsonl`
 * (config directory reference,
 * https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference),
 * read into agent-agnostic transcript entries.
 *
 * The record shape is the Copilot SDK's session event
 * (https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md):
 * an envelope `{ id, timestamp, parentId, agentId?, ephemeral?, type, data }`.
 * Persisted events are "saved to the session event log on disk and replayed on
 * resume"; ephemeral ones (`assistant.usage`, deltas, `session.idle`) are not.
 * The events read here are all persisted:
 *
 * - `user.message`: `data.content`
 * - `assistant.message`: `data.content`, `data.reasoningText`,
 *   `data.toolRequests[] { toolCallId, name, arguments }`
 * - `tool.execution_start`: `data.toolCallId`, `data.toolName`
 * - `tool.execution_complete`: `data.toolCallId`, `data.success`,
 *   `data.result.content`, `data.error.message`
 * - `session.compaction_complete`: `data.summaryContent`
 * - `session.resume`: a run of the same conversation starting again
 * - `session.shutdown`: `data.modelMetrics[model].usage.{inputTokens,outputTokens}`
 *
 * Built from those docs (no CLI version stated; changelog 1.0.105 current).
 * The fields read here match local logs of Copilot 1.0.24 through 1.0.98,
 * which held no `session.compaction_complete` or `session.resume`. Two
 * sanitized 1.0.88 logs (`tests/fixtures/copilot-events/copilot-1.0.88-*`)
 * pin the captured shape; the doc-shaped fixture covers only those two events.
 */

/** Pages need no line count: every record carries its own `id` for its uuid. */
const PAGES_COUNT_LINES = false;

/** The tail of a Copilot session's event log, as transcript entries. */
export async function parseCopilotTranscript(agentSessionId: string, filePath: string): Promise<TranscriptEntry[]> {
  // Bounded tail read: a session's log has no size ceiling.
  const window = await readJsonlWindow(filePath, {
    maxBytes: parseWindowBytes(),
    countOmittedLines: PAGES_COUNT_LINES,
  });
  if (window.totalBytes === 0) return [];
  const entries = parseCopilotLines(agentSessionId, splitJsonlLines(window.text, window.startByte, null));
  return prependTruncationMarker(entries, window.omittedBytes, window.totalBytes, jsonlEarlierHistory(agentSessionId, window, PAGES_COUNT_LINES));
}

/** One page of a Copilot session's history for the Conversation viewer. */
export function readCopilotTranscriptPage(
  agentSessionId: string,
  filePath: string,
  request: TranscriptPageReadRequest,
): Promise<TranscriptPageReadResult> {
  return readJsonlHistoryPage({
    filePath,
    request,
    countLines: PAGES_COUNT_LINES,
    parseLines: (lines) => parseCopilotLines(agentSessionId, lines),
  });
}

/** Parse whole lines into entries, each stamped with the byte its line starts at. */
export function parseCopilotLines(agentSessionId: string, lines: ReadonlyArray<JsonlLine>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const { text, byte } of lines) {
    if (text.length === 0) continue;
    const firstNew = entries.length;
    parseCopilotRecord(agentSessionId, text, byte, entries);
    stampOrigin(entries, firstNew, agentSessionId, byte);
  }
  return entries;
}

/**
 * Parse one event, appending what it yields. Keeps no state between lines, so
 * a page mints exactly the entries a whole-file parse mints for its lines.
 */
function parseCopilotRecord(agentSessionId: string, line: string, byte: number, entries: TranscriptEntry[]): void {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(raw)) return;
  const data = isRecord(raw.data) ? raw.data : null;
  if (!data) return;
  // The envelope's `id` is a UUID per event. A record without one is named by
  // its byte, which is as stable as the line.
  const uuid = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `${agentSessionId}@${byte}`;
  const timestampMs = parseTimestamp(raw.timestamp);

  switch (raw.type) {
    case 'user.message': {
      const text = typeof data.content === 'string' ? data.content.trim() : '';
      if (text.length > 0) entries.push({ kind: 'user', uuid, ts: timestampMs, text });
      return;
    }
    case 'assistant.message': {
      const blocks: TranscriptBlock[] = [];
      if (typeof data.reasoningText === 'string' && data.reasoningText.trim().length > 0) {
        blocks.push({ type: 'thinking', text: data.reasoningText });
      }
      if (typeof data.content === 'string' && data.content.trim().length > 0) {
        blocks.push({ type: 'text', text: data.content });
      }
      if (Array.isArray(data.toolRequests)) {
        for (const request of data.toolRequests) {
          if (!isRecord(request)) continue;
          blocks.push({
            type: 'tool_use',
            id: typeof request.toolCallId === 'string' ? request.toolCallId : '',
            name: typeof request.name === 'string' ? request.name : 'tool',
            input: request.arguments,
          });
        }
      }
      if (blocks.length > 0) entries.push({ kind: 'assistant', uuid, ts: timestampMs, blocks });
      return;
    }
    case 'tool.execution_complete': {
      const succeeded = data.success !== false;
      const result = isRecord(data.result) ? data.result : null;
      const error = isRecord(data.error) ? data.error : null;
      const resultText = result && typeof result.content === 'string' ? result.content : null;
      const errorText = error && typeof error.message === 'string' ? error.message : null;
      entries.push({
        kind: 'tool_result',
        uuid,
        ts: timestampMs,
        toolUseId: typeof data.toolCallId === 'string' ? data.toolCallId : '',
        content: (succeeded ? resultText ?? errorText : errorText ?? resultText) ?? '',
        ...(succeeded ? {} : { isError: true }),
      });
      return;
    }
    case 'session.compaction_complete': {
      if (data.success === false) return;
      const summary = typeof data.summaryContent === 'string' ? data.summaryContent.trim() : '';
      entries.push({ kind: 'system', uuid, ts: timestampMs, subtype: 'compaction', text: summary.length > 0 ? summary : 'Conversation compacted' });
      return;
    }
    case 'session.resume':
      entries.push({ kind: 'system', uuid, ts: timestampMs, subtype: 'session_boundary', text: 'Session resumed' });
      return;
    default:
      return;
  }
}

/**
 * Tokens from the last `session.shutdown`, summed over its `modelMetrics`.
 * Copilot writes it when a run ends, so a session still in its first run has
 * none and this answers null. A later `session.usage_checkpoint` exists "to
 * reconstruct accounting when a session is resumed", which reads as the
 * shutdown totals carrying across resumes; not checked against a real log.
 * Null on a partial read, which would report an earlier run's totals.
 */
export async function copilotTranscriptUsage(filePath: string): Promise<TranscriptUsage | null> {
  let latest: TranscriptUsage | null = null;
  const readWholeFile = await streamJsonlRecords(filePath, (record) => {
    if (record.type !== 'session.shutdown' || !isRecord(record.data)) return;
    const modelMetrics = record.data.modelMetrics;
    if (!isRecord(modelMetrics)) return;
    let inputTokens = 0;
    let outputTokens = 0;
    let counted = false;
    for (const metric of Object.values(modelMetrics)) {
      if (!isRecord(metric) || !isRecord(metric.usage)) continue;
      const usage = metric.usage;
      if (typeof usage.inputTokens === 'number') { inputTokens += usage.inputTokens; counted = true; }
      if (typeof usage.outputTokens === 'number') { outputTokens += usage.outputTokens; counted = true; }
    }
    if (counted) latest = { inputTokens, outputTokens };
  });
  return readWholeFile ? latest : null;
}

/**
 * Distinct tool calls by `tool.execution_start.toolCallId`, per tool name.
 * Calls a subagent makes are in the same log (the envelope's `agentId` names
 * the subagent) and count too. Null on a partial read or a log
 * with no tool calls, so the caller keeps its live count.
 */
export async function copilotTranscriptToolCounts(filePath: string): Promise<TranscriptToolCounts | null> {
  const seenIds = new Set<string>();
  const countsByTool = new Map<string, number>();
  const readWholeFile = await streamJsonlRecords(filePath, (record) => {
    if (record.type !== 'tool.execution_start' || !isRecord(record.data)) return;
    const toolCallId = typeof record.data.toolCallId === 'string' ? record.data.toolCallId : null;
    if (toolCallId) {
      if (seenIds.has(toolCallId)) return;
      seenIds.add(toolCallId);
    }
    const toolName = typeof record.data.toolName === 'string' && record.data.toolName.length > 0 ? record.data.toolName : 'tool';
    countsByTool.set(toolName, (countsByTool.get(toolName) ?? 0) + 1);
  });
  if (!readWholeFile || countsByTool.size === 0) return null;
  const toolBreakdown: PerToolStat[] = Array.from(countsByTool.entries())
    .map(([toolName, callCount]) => ({ toolName, callCount, totalDurationMs: 0, interruptedCount: 0 }))
    .sort((first, second) => second.callCount - first.callCount);
  const toolCallCount = toolBreakdown.reduce((sum, stat) => sum + stat.callCount, 0);
  return { toolCallCount, toolBreakdown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The envelope's ISO 8601 `timestamp`. */
function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
