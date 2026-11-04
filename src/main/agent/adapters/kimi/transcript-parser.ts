import type { TranscriptEntry, TranscriptBlock, TranscriptEntryOrigin } from '../../../../shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../agent-adapter';
import { readJsonlWindow } from '../../shared/history-scan';
import { jsonlEarlierHistory, readJsonlHistoryPage, splitJsonlLines, type JsonlLine } from '../../shared/jsonl-history-page';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { contentPartsText, parseRecordTime } from './wire-parser';

/** Kimi uuids number lines (see below), so the tail, its notice and every page count them. */
const UUIDS_NUMBER_LINES = true;

/**
 * Parse Kimi Code CLI's `agents/main/wire.jsonl` (wire protocol 1.5) into
 * agent-agnostic `TranscriptEntry[]` for `get_transcript`, the Conversation
 * viewer and the conversation index.
 *
 * Records (`packages/agent-core-v2/docs/wire-manifest.d.ts` and
 * `src/agent/contextMemory/loopEventFold.ts`, Kimi Code CLI 2.4.1, read
 * 2026-11-03): each line is `{"type", ...payload, "time"}`.
 *   - `turn.prompt` / `turn.steer`: `input` (ContentPart[]) -> a user entry, or
 *     a compaction note for a `compaction_summary` origin.
 *   - `context.append_loop_event` `content.part`: assistant text runs, flushed
 *     as one entry at the next tool call, step end or turn boundary.
 *   - `context.append_loop_event` `tool.call`: `{toolCallId, name, args}` ->
 *     an assistant `tool_use` block (`args` is already an object).
 *   - `context.append_loop_event` `tool.result`: `{toolCallId, result:
 *     {output, isError}}` -> a tool_result entry.
 *   - `context.apply_compaction`: a compaction note with its summary.
 * Everything else (usage, interactions, subagents) is not conversation.
 * Built from the source, not yet checked against a real file.
 */
export async function parseKimiTranscript(agentSessionId: string, filePath: string): Promise<TranscriptEntry[]> {
  // Bounded tail read: a transcript has no size ceiling, and reading one whole
  // is what OOM'd the main process. The uuids embed the ABSOLUTE line index,
  // so the lines before the window are counted.
  const window = await readJsonlWindow(filePath, {
    maxBytes: parseWindowBytes(),
    countOmittedLines: UUIDS_NUMBER_LINES,
  });
  if (window.totalBytes === 0) return [];
  const entries = parseKimiLines(agentSessionId, splitJsonlLines(window.text, window.startByte, window.omittedLineCount));
  return prependTruncationMarker(entries, window.omittedBytes, window.totalBytes, jsonlEarlierHistory(agentSessionId, window, UUIDS_NUMBER_LINES));
}

/**
 * One bounded window of the file for the conversation indexer's whole-file
 * walk (`AgentAdapter.parseTranscriptWindow`). It counts the lines before the
 * window, so its uuids are the ones the tail and every page mint.
 */
export async function parseKimiTranscriptWindow(
  agentSessionId: string,
  filePath: string,
  startByte: number,
  maxBytes: number,
): Promise<{ entries: TranscriptEntry[]; nextByteOffset: number; totalBytes: number; firstByteOffset: number; endByte: number }> {
  const window = await readJsonlWindow(filePath, { startByte, maxBytes, countOmittedLines: UUIDS_NUMBER_LINES });
  const entries = parseKimiLines(agentSessionId, splitJsonlLines(window.text, window.startByte, window.omittedLineCount));
  return {
    entries,
    nextByteOffset: window.nextByteOffset,
    totalBytes: window.totalBytes,
    firstByteOffset: window.startByte,
    endByte: window.endByte,
  };
}

/** One page of the history for the Conversation viewer. Cursors carry a line count. */
export function readKimiTranscriptPage(
  agentSessionId: string,
  filePath: string,
  request: TranscriptPageReadRequest,
): Promise<TranscriptPageReadResult> {
  return readJsonlHistoryPage({
    filePath,
    request,
    countLines: UUIDS_NUMBER_LINES,
    parseLines: (lines) => parseKimiLines(agentSessionId, lines),
  });
}

/**
 * Parse whole lines into entries. A single-record entry is stamped with the
 * byte its own line starts at; a flushed text run with the byte its first
 * fragment's line starts at, the same line its uuid names. A run a window or
 * page edge cuts comes back as two rows, since this parser keeps nothing
 * between reads.
 */
function parseKimiLines(agentSessionId: string, lines: ReadonlyArray<JsonlLine>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let pendingAssistantText = '';
  let pendingTs = 0;
  let pendingLineNumber = 0;
  let pendingOrigin: TranscriptEntryOrigin = { conversationId: agentSessionId, position: 0 };
  // Session-scoped and ABSOLUTE: the records carry no per-record id (a tool
  // call and its result share one), so the line names the entry.
  const uuidForLine = (lineNumber: number): string => `${agentSessionId}:${lineNumber}`;

  const flushAssistantText = (): void => {
    const text = pendingAssistantText.trim();
    if (text.length > 0) {
      entries.push({ kind: 'assistant', uuid: uuidForLine(pendingLineNumber), ts: pendingTs, blocks: [{ type: 'text', text }], origin: pendingOrigin });
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
    const type = raw.type;
    const ts = parseRecordTime(raw.time);

    if (type === 'turn.prompt' || type === 'turn.steer') {
      flushAssistantText();
      const text = contentPartsText(raw.input)?.trim();
      if (!text) continue;
      if (raw.origin === 'compaction_summary') {
        entries.push({ kind: 'system', uuid: uuidForLine(lineNumber), ts, subtype: 'compaction', text, origin });
      } else {
        entries.push({ kind: 'user', uuid: uuidForLine(lineNumber), ts, text, origin });
      }
      continue;
    }

    if (type === 'context.apply_compaction') {
      flushAssistantText();
      const summary = typeof raw.summary === 'string' ? raw.summary : typeof raw.contextSummary === 'string' ? raw.contextSummary : '';
      entries.push({ kind: 'system', uuid: uuidForLine(lineNumber), ts, subtype: 'compaction', text: summary.trim() || 'Conversation compacted', origin });
      continue;
    }

    if (type === 'turn.ended') {
      flushAssistantText();
      continue;
    }

    if (type !== 'context.append_loop_event' || !isRecord(raw.event)) continue;
    const loopEvent = raw.event;

    if (loopEvent.type === 'content.part') {
      const part = loopEvent.part;
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        if (pendingAssistantText.length === 0) {
          pendingTs = ts;
          pendingLineNumber = lineNumber;
          pendingOrigin = origin;
        }
        pendingAssistantText += part.text;
      }
      continue;
    }

    if (loopEvent.type === 'step.end') {
      flushAssistantText();
      continue;
    }

    if (loopEvent.type === 'tool.call') {
      flushAssistantText();
      const id = typeof loopEvent.toolCallId === 'string' ? loopEvent.toolCallId : '';
      const name = typeof loopEvent.name === 'string' && loopEvent.name.length > 0 ? loopEvent.name : 'tool';
      const blocks: TranscriptBlock[] = [{ type: 'tool_use', id, name, input: loopEvent.args ?? {} }];
      entries.push({ kind: 'assistant', uuid: uuidForLine(lineNumber), ts, blocks, origin });
      continue;
    }

    if (loopEvent.type === 'tool.result') {
      flushAssistantText();
      const toolUseId = typeof loopEvent.toolCallId === 'string' ? loopEvent.toolCallId : '';
      const result = isRecord(loopEvent.result) ? loopEvent.result : {};
      entries.push({
        kind: 'tool_result',
        uuid: uuidForLine(lineNumber),
        ts,
        toolUseId,
        content: contentPartsText(result.output) ?? '',
        isError: result.isError === true,
        origin,
      });
    }
  }

  // Also where a run a seam cuts flushes its first half.
  flushAssistantText();
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
