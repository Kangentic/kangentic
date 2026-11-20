import fs from 'node:fs';
import type { TranscriptBlock, TranscriptEntry } from '../../../../shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../agent-adapter';
import { readJsonlWindow } from '../../shared/history-scan';
import { jsonlEarlierHistory, readJsonlHistoryPage, splitJsonlLines, stampOrigin, type JsonlLine } from '../../shared/jsonl-history-page';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { timeSyncWork } from '../../../diagnostics/event-loop-lag';

/**
 * Cursor numbers nothing in the file, so entry uuids are `<sessionId>:<line>`
 * and every page has to count lines the same way the tail does.
 */
const UUIDS_NUMBER_LINES = true;

/**
 * Parse Cursor's `agent-transcripts/<id>/<id>.jsonl` into conversation entries.
 *
 * A line is `{ role, message: { content: [{ type: 'text', text } | { type: 'tool_use', name, input }] } }`,
 * or a `{ type: 'turn_ended' }` marker with no role. There is no JSON
 * timestamp field. The clock lives in the user line's `<timestamp>` tag
 * (`Monday, Aug 24, 2026, 3:16 PM (UTC+8)`), minute precision. That value
 * is stamped onto the user turn and carried forward onto the assistant
 * lines of the same turn, so the conversation window's Route tabs can
 * place the turn. The adapter still sets `transcriptHasTimestamps` false:
 * the viewer pages by position and asks for no timeline, because a minute
 * clock is not a JSON field the timeline can probe.
 *
 * A user line stores the typed text inside tags:
 *
 * ```
 * <manually_attached_skills>...</manually_attached_skills>   (optional)
 * <cursor_commands>...</cursor_commands>                     (optional)
 * <timestamp>...</timestamp>
 * <user_query>
 * the typed text
 * </user_query>
 * ```
 *
 * A slash command the board typed (`/pull-request`, `/merge-pull-request`) is
 * stored this way: Cursor inlines the skill, then a command wrapper, then the
 * clock, then the query. Those two leading blocks, the clock tag, and the
 * `user_query` wrapper are removed from the displayed text. A board prompt
 * whose whole body is one `<task>` element is unwrapped once more. A user
 * line that is some other leading tag (injected context such as
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

  const entries = parseCursorLines(
    agentSessionId,
    splitJsonlLines(window.text, window.startByte, window.omittedLineCount),
    timestampBefore(filePath, window.startByte),
  );
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
    parseLines: (lines) => parseCursorLines(agentSessionId, lines, timestampBefore(filePath, lines[0]?.byte ?? 0)),
  });
}

/**
 * Cursor wrappers that sit in front of the clock and query on a slash-command
 * line. Order varies; both are optional. Dropped so the query is what starts
 * the turn. A leftover leading tag after this is injected context, not a turn.
 */
const LEADING_USER_WRAPPERS = ['manually_attached_skills', 'cursor_commands'] as const;

/**
 * The text a user line should show. Null when the line is not a user turn.
 * Exported so the wrapper rules stay pinned without a full file read.
 */
export function cursorDisplayedUserText(text: string): string | null {
  const withoutWrappers = stripLeadingWrappers(text);
  const withoutClock = withoutWrappers.replace(/^\s*<timestamp>[\s\S]*?<\/timestamp>\s*/, '');
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

function stripLeadingWrappers(text: string): string {
  let remaining = text;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const tag of LEADING_USER_WRAPPERS) {
      const withoutThisWrapper = remaining.replace(
        new RegExp(`^\\s*<${tag}>[\\s\\S]*?</${tag}>\\s*`),
        '',
      );
      if (withoutThisWrapper !== remaining) {
        remaining = withoutThisWrapper;
        stripped = true;
      }
    }
  }
  return remaining;
}

function unwrapTag(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`^\\s*<${tag}>\\r?\\n?([\\s\\S]*?)\\r?\\n?</${tag}>\\s*$`));
  return match ? match[1] : null;
}

const MONTH_INDEX: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** `Monday, Aug 24, 2026, 3:16 PM (UTC+8)`. Weekday is ignored. */
const CURSOR_CLOCK = /^[A-Za-z]+, ([A-Za-z]+) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM) \(UTC([+-])(\d{1,2})(?::(\d{2}))?\)$/;

/**
 * Epoch ms for a Cursor `<timestamp>` body, or 0 when the string is not
 * that clock. Exported so the format stays pinned without a file read.
 */
export function parseCursorClock(raw: string): number {
  const match = raw.trim().match(CURSOR_CLOCK);
  if (!match) return 0;
  const month = MONTH_INDEX[match[1]];
  if (month === undefined) return 0;
  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const period = match[6];
  if (period === 'AM') {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }
  const offsetSign = match[7] === '-' ? -1 : 1;
  const offsetHours = Number(match[8]);
  const offsetMinutes = Number(match[9] ?? '0');
  const offsetMs = offsetSign * (offsetHours * 3600 + offsetMinutes * 60) * 1000;
  return Date.UTC(year, month, day, hour, minute) - offsetMs;
}

function cursorUserTimestampMs(text: string): number {
  const match = text.match(/<timestamp>\s*([\s\S]*?)\s*<\/timestamp>/);
  if (!match) return 0;
  return parseCursorClock(match[1]);
}

/** How far a page looks back for the user clock that opened the turn it starts in. */
const TIMESTAMP_LOOKBACK_BYTES = 256 * 1024;

/**
 * The nearest earlier user clock before `beforeByte`, or 0. A page (or a
 * truncated tail) can open on an assistant line; without this those entries
 * would keep `ts: 0` while a whole-file parse stamps the turn's clock.
 */
function timestampBefore(filePath: string, beforeByte: number): number {
  if (!(beforeByte > 0)) return 0;
  let file: number | undefined;
  try {
    file = fs.openSync(filePath, 'r');
    const lookback = Math.min(beforeByte, TIMESTAMP_LOOKBACK_BYTES);
    const start = beforeByte - lookback;
    const buffer = Buffer.alloc(lookback);
    const bytesRead = fs.readSync(file, buffer, 0, lookback, start);
    const text = buffer.toString('utf8', 0, bytesRead);
    const lines = text.split(/\n/);
    if (start > 0) lines.shift();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
      if (line.length === 0) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(raw) || raw.role !== 'user' || !isRecord(raw.message)) continue;
      const stored = extractText(raw.message.content);
      if (!cursorDisplayedUserText(stored)) continue;
      const parsed = cursorUserTimestampMs(stored);
      if (parsed > 0) return parsed;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (file !== undefined) fs.closeSync(file);
  }
}

function parseCursorLines(
  agentSessionId: string,
  lines: ReadonlyArray<JsonlLine>,
  seedTimestampMs: number,
): TranscriptEntry[] {
  return timeSyncWork('transcript:parse-cursor', () => collectCursorEntries(agentSessionId, lines, seedTimestampMs));
}

function collectCursorEntries(
  agentSessionId: string,
  lines: ReadonlyArray<JsonlLine>,
  seedTimestampMs: number,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let lastTimestampMs = seedTimestampMs;
  for (const { text: line, byte, line: lineNumber } of lines) {
    if (line.length === 0) continue;
    const firstNew = entries.length;
    lastTimestampMs = parseCursorRecord(`${agentSessionId}:${lineNumber ?? 0}`, line, lastTimestampMs, entries);
    stampOrigin(entries, firstNew, agentSessionId, byte);
  }
  return entries;
}

function parseCursorRecord(
  uuid: string,
  line: string,
  lastTimestampMs: number,
  entries: TranscriptEntry[],
): number {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return lastTimestampMs;
  }
  if (!isRecord(raw) || !isRecord(raw.message)) return lastTimestampMs;

  if (raw.role === 'user') {
    const stored = extractText(raw.message.content);
    const text = cursorDisplayedUserText(stored);
    if (!text) return lastTimestampMs;
    const parsed = cursorUserTimestampMs(stored);
    const ts = parsed > 0 ? parsed : lastTimestampMs;
    entries.push({ kind: 'user', uuid, ts, text });
    return ts > 0 ? ts : lastTimestampMs;
  }

  if (raw.role === 'assistant') {
    const blocks = assistantBlocks(raw.message.content, uuid);
    if (blocks.length === 0) return lastTimestampMs;
    entries.push({ kind: 'assistant', uuid, ts: lastTimestampMs, blocks });
  }
  return lastTimestampMs;
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
