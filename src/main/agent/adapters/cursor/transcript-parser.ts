import type { TranscriptBlock, TranscriptEntry } from '../../../../shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../agent-adapter';
import { readJsonlWindow } from '../../shared/history-scan';
import { jsonlEarlierHistory, readJsonlHistoryPage, splitJsonlLines, stampOrigin, type JsonlLine } from '../../shared/jsonl-history-page';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';

/**
 * Cursor numbers nothing in the file, so entry uuids are `<sessionId>:<line>`
 * and every page has to count lines the same way the tail does.
 */
const UUIDS_NUMBER_LINES = true;

/**
 * Parse Cursor's `agent-transcripts/<id>/<id>.jsonl` into conversation entries.
 *
 * A line is `{ role, message: { content: [{ type: 'text', text } | { type: 'tool_use', name, input }] } }`,
 * or a `{ type: 'turn_ended' }` marker with no role. There is no timestamp
 * field. Entries carry `ts: 0`, and the adapter sets `transcriptHasTimestamps`
 * false, so the viewer shows no clock and keeps file order.
 *
 * A user line stores the typed text inside tags:
 *
 * ```
 * <timestamp>...</timestamp>
 * <user_query>
 * the typed text
 * </user_query>
 * ```
 *
 * The clock tag and the `user_query` wrapper are removed. A board prompt whose
 * whole body is one `<task>` element is unwrapped once more. A user line that
 * is some other leading tag (injected context such as
 * `<available_subagent_types>`) is not a turn and is skipped.
 */
export async function parseCursorTranscript(
  agentSessionId: string,
  filePath: string,
): Promise<{ entries: TranscriptEntry[]; sourcePath: string | null }> {
  const window = await readJsonlWindow(filePath, {
    maxBytes: parseWindowBytes(),
    countOmittedLines: UUIDS_NUMBER_LINES,
  });
  if (window.totalBytes === 0) return { entries: [], sourcePath: null };

  const entries = parseCursorLines(agentSessionId, splitJsonlLines(window.text, window.startByte, window.omittedLineCount));
  return {
    entries: prependTruncationMarker(
      entries,
      window.omittedBytes,
      window.totalBytes,
      jsonlEarlierHistory(agentSessionId, window, UUIDS_NUMBER_LINES),
    ),
    sourcePath: filePath,
  };
}

/** One page of a Cursor transcript for the Conversation viewer. */
export function readCursorTranscriptPage(
  agentSessionId: string,
  filePath: string,
  request: TranscriptPageReadRequest,
): Promise<TranscriptPageReadResult> {
  return readJsonlHistoryPage({
    filePath,
    request,
    countLines: UUIDS_NUMBER_LINES,
    parseLines: (lines) => parseCursorLines(agentSessionId, lines),
  });
}

/**
 * The text a user line should show. Null when the line is not a user turn.
 * Exported so the wrapper rules stay pinned without a full file read.
 */
export function cursorDisplayedUserText(text: string): string | null {
  const withoutClock = text.replace(/^\s*<timestamp>[\s\S]*?<\/timestamp>\s*/, '');
  const query = unwrapTag(withoutClock, 'user_query');
  if (query === null) {
    const plain = withoutClock.trim();
    if (plain.length === 0 || plain.startsWith('<')) return null;
    return plain;
  }
  const task = unwrapTag(query, 'task');
  const displayed = (task ?? query).trim();
  return displayed.length > 0 ? displayed : null;
}

function unwrapTag(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`^\\s*<${tag}>\\r?\\n?([\\s\\S]*?)\\r?\\n?</${tag}>\\s*$`));
  return match ? match[1] : null;
}

function parseCursorLines(agentSessionId: string, lines: ReadonlyArray<JsonlLine>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const { text: line, byte, line: lineNumber } of lines) {
    if (line.length === 0) continue;
    const firstNew = entries.length;
    parseCursorRecord(`${agentSessionId}:${lineNumber ?? 0}`, line, entries);
    stampOrigin(entries, firstNew, agentSessionId, byte);
  }
  return entries;
}

function parseCursorRecord(uuid: string, line: string, entries: TranscriptEntry[]): void {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(raw) || !isRecord(raw.message)) return;

  if (raw.role === 'user') {
    const text = cursorDisplayedUserText(extractText(raw.message.content));
    if (!text) return;
    entries.push({ kind: 'user', uuid, ts: 0, text });
    return;
  }

  if (raw.role === 'assistant') {
    const blocks = assistantBlocks(raw.message.content, uuid);
    if (blocks.length === 0) return;
    entries.push({ kind: 'assistant', uuid, ts: 0, blocks });
  }
}

function assistantBlocks(content: unknown, uuid: string): TranscriptBlock[] {
  if (!Array.isArray(content)) {
    const text = typeof content === 'string' ? content.trim() : '';
    return text.length > 0 ? [{ type: 'text', text }] : [];
  }
  const blocks: TranscriptBlock[] = [];
  let toolIndex = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      blocks.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name.length > 0) {
      const recordedId = typeof block.id === 'string' && block.id.length > 0 ? block.id : `${uuid}:tool:${toolIndex}`;
      toolIndex += 1;
      blocks.push({
        type: 'tool_use',
        id: recordedId,
        name: block.name,
        input: block.input ?? {},
      });
    }
  }
  return blocks;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
