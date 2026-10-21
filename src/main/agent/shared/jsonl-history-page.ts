/**
 * One page of a JSONL transcript's history, for the Conversation viewer's
 * paging (`AgentAdapter.readTranscriptPage`). Shared by every adapter whose
 * transcript is one append-only JSONL file; each brings only its line parser.
 *
 * Coordinates are line-start bytes: a cursor is 0 or the byte just after a
 * newline, and a page covers the whole lines in `[startPosition, endPosition)`.
 * That is the convention `readJsonlWindow` already reports as its post-skip
 * `startByte` and the tail parse's `truncated` notice carries, so the first
 * page before the notice ends exactly where the tail begins, and consecutive
 * pages tile the file with no line read twice or skipped:
 *
 * - `before(C)` reads `[C - max, C)`. Byte `C - 1` is a newline, so the read's
 *   trailing trim ends the text exactly at C.
 * - `after(C)` reads from `C - 1`, so the leading skip consumes exactly that
 *   newline and the text starts at C. A forward read stops at `untilPosition`,
 *   the tail's start, so it never reaches a half-written last line.
 * - `around(X)` reads forward from `X - max / 2`; both edges land on lines.
 *
 * A line longer than one page is skipped without parsing, within a read budget
 * of bytes and of time; a stretch whose lines yield no entries is walked
 * through, a few windows at most. The time budget is what bounds a page smaller
 * than every line, which skips one window at a time to the end of the file.
 *
 * Agents whose entry uuids number lines carry a line count in the cursor, so a
 * page mints the same uuids as the tail parse. A page that starts from no
 * counted line (`around`, or past a skipped line) counts the newlines before it
 * once, from the start of the file; a timeline probe (`request.probe`) needs
 * no uuids and skips that count.
 *
 * Retains nothing between calls: a page is read, parsed and returned.
 */

import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { TranscriptEntry } from '../../../shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../agent-adapter';
import { countNewlinesBefore, readJsonlWindow, type JsonlWindow } from './history-scan';
import type { TruncatedHistory } from './transcript-truncation';

/** A position in a JSONL file: a line-start byte, plus the physical lines
 *  before it when the adapter numbers its entries by line. */
export interface JsonlCursor {
  byte: number;
  line: number | null;
}

export function encodeJsonlCursor(cursor: JsonlCursor): string {
  return cursor.line === null ? `j:${cursor.byte}` : `j:${cursor.byte}:${cursor.line}`;
}

export function decodeJsonlCursor(text: string | undefined): JsonlCursor | null {
  if (!text) return null;
  const match = /^j:(\d+)(?::(\d+))?$/.exec(text);
  if (!match) return null;
  return { byte: Number(match[1]), line: match[2] === undefined ? null : Number(match[2]) };
}

/** One whole line of a window: its text (without the newline or a CR before
 *  it), the byte it starts at, and its physical line index when counted.
 *  A line holding bytes that are not valid UTF-8 decodes each of them to
 *  U+FFFD, three bytes, so `byte` drifts past the true start of every later
 *  line in its window. Page edges and cursors come from the window's raw
 *  offsets and do not drift; only an entry's `origin.position` does. */
export interface JsonlLine {
  text: string;
  byte: number;
  line: number | null;
}

/**
 * Split a window's text into its lines, each with the byte it starts at.
 * Every physical line counts, empty ones included, so a line index matches the
 * one a whole-file `split(/\r?\n/)` gives. Byte lengths are measured per line,
 * since the text is decoded UTF-8 and a character can take several bytes.
 */
export function splitJsonlLines(text: string, startByte: number, firstLine: number | null): JsonlLine[] {
  const lines: JsonlLine[] = [];
  if (text.length === 0) return lines;
  const segments = text.split('\n');
  // A window of whole lines ends with a newline, which leaves one empty segment.
  if (segments[segments.length - 1] === '') segments.pop();
  let byte = startByte;
  segments.forEach((segment, index) => {
    const withoutCarriageReturn = segment.endsWith('\r') ? segment.slice(0, -1) : segment;
    lines.push({ text: withoutCarriageReturn, byte, line: firstLine === null ? null : firstLine + index });
    byte += Buffer.byteLength(segment, 'utf8') + 1;
  });
  return lines;
}

/**
 * Stamp the entries one record yielded, `entries[fromIndex..]`, with where its
 * line starts (`TranscriptEntry.origin`): the place the viewer gives them on a
 * scrollbar spanning the whole transcript.
 */
export function stampOrigin(entries: TranscriptEntry[], fromIndex: number, conversationId: string, position: number): void {
  if (fromIndex >= entries.length) return;
  const origin = { conversationId, position };
  for (let index = fromIndex; index < entries.length; index += 1) entries[index].origin = origin;
}

/**
 * The cursor a tail's `truncated` notice carries into the history it left
 * out: where the tail starts, with the lines before it when the adapter's
 * uuids number lines. An adapter passes the same `countLines` here, to its
 * tail read's `countOmittedLines`, and to `readJsonlHistoryPage`, or a page
 * mints uuids the tail does not.
 */
export function jsonlEarlierHistory(
  conversationId: string,
  window: Pick<JsonlWindow, 'startByte' | 'omittedLineCount'>,
  countLines: boolean,
): TruncatedHistory {
  return { conversationId, cursor: encodeJsonlCursor({ byte: window.startByte, line: countLines ? window.omittedLineCount : null }) };
}

/** How many physical lines a window of whole lines holds. */
function linesIn(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count += 1;
  // A final line with no newline (a file's last line) is still a line.
  if (!text.endsWith('\n')) count += 1;
  return count;
}

const SOURCE_TOKEN_BYTES = 4096;

/** Bytes a page may skip through without parsing (lines longer than a page). */
const SKIP_BUDGET_BYTES = 256 * 1024 * 1024;

/** How long one page read may take, well inside the history queue's deadline. */
export const PAGE_READ_BUDGET_MS = 4_000;

/** Windows whose lines yield no entries a page walks through before answering. */
const MAX_EMPTY_WINDOWS = 4;

/**
 * Identifies the file a page's cursors belong to: a hash of its first 4096
 * bytes. Stable while a file past that size is appended to; a rewrite or a new
 * file changes it. A shorter file's token changes on every append, which only
 * a file small enough to sit whole in the tail could hit, and that never pages.
 */
export async function jsonlSourceToken(filePath: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(SOURCE_TOKEN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SOURCE_TOKEN_BYTES, 0);
    return `jsonl:${createHash('sha1').update(buffer.subarray(0, bytesRead)).digest('hex')}`;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => { /* swallow */ });
  }
}

export interface JsonlHistoryPageOptions {
  filePath: string;
  request: TranscriptPageReadRequest;
  /** Whether the adapter's uuids number lines, so cursors carry a line count. */
  countLines: boolean;
  /** Parse one window's whole lines into entries, each stamped with its origin. */
  parseLines: (lines: JsonlLine[]) => TranscriptEntry[];
}

interface CollectedWindow {
  text: string;
  startByte: number;
  entries: TranscriptEntry[];
  /** The line index the window was parsed from, or null when it was parsed
   *  without one and `renumber` must parse it again. */
  firstLine: number | null;
}

/**
 * Read one page of a JSONL transcript (see the file comment for the cursor
 * convention). Never throws: a missing file or a failed read answers
 * `unavailable`, a rewritten file or a cursor past the end answers `reset`.
 */
export async function readJsonlHistoryPage(options: JsonlHistoryPageOptions): Promise<TranscriptPageReadResult> {
  const { filePath, request, parseLines } = options;
  // A probe reads only times and positions, so it skips the newline count uuids need.
  const countLines = options.countLines && !request.probe;
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return { status: 'unavailable', reason: 'file_missing' };
  }
  const sourceToken = await jsonlSourceToken(filePath);
  if (sourceToken === null) return { status: 'unavailable', reason: 'read_failed' };
  if (request.sourceToken && request.sourceToken !== sourceToken) return { status: 'reset' };

  const maxBytes = Math.max(1, Math.floor(request.maxBytes));
  const until = Math.min(size, Math.max(0, request.untilPosition ?? size));
  const deadline = Date.now() + PAGE_READ_BUDGET_MS;
  try {
    if (request.direction === 'before') {
      const cursor = decodeJsonlCursor(request.cursor);
      if (!cursor || cursor.byte > size) return { status: 'reset' };
      return await readBefore({ filePath, size, until, maxBytes, deadline, cursor, countLines, parseLines, sourceToken });
    }
    if (request.direction === 'after') {
      const cursor = decodeJsonlCursor(request.cursor);
      if (!cursor || cursor.byte > size) return { status: 'reset' };
      return await readForward({
        filePath, size, until, maxBytes, deadline, countLines, parseLines, sourceToken,
        cursor, readFrom: cursor.byte > 0 ? cursor.byte - 1 : 0, checkAlignment: true,
      });
    }
    const target = Math.min(Math.max(0, request.position ?? 0), until);
    const readFrom = Math.min(Math.max(0, target - Math.floor(maxBytes / 2)), Math.max(0, until - maxBytes));
    return await readForward({
      filePath, size, until, maxBytes, deadline, countLines, parseLines, sourceToken,
      cursor: null, readFrom, checkAlignment: false,
    });
  } catch {
    return { status: 'unavailable', reason: 'read_failed' };
  }
}

interface ReadContext {
  filePath: string;
  size: number;
  until: number;
  maxBytes: number;
  /** When the read gives up as over budget (`Date.now()` time). */
  deadline: number;
  countLines: boolean;
  parseLines: (lines: JsonlLine[]) => TranscriptEntry[];
  sourceToken: string;
}

/** A window read that failed: `readJsonlWindow` answers an empty window. */
function windowFailed(window: JsonlWindow): boolean {
  return window.totalBytes === 0;
}

async function readBefore(context: ReadContext & { cursor: JsonlCursor }): Promise<TranscriptPageReadResult> {
  const { filePath, size, until, maxBytes, deadline, countLines, parseLines, sourceToken, cursor } = context;
  const collected: CollectedWindow[] = [];
  let end = cursor.byte;
  // The line index of the line starting at `end`, while the windows read so
  // far are contiguous with the cursor; a skip loses it.
  let lineAtEnd: number | null = countLines ? cursor.line : null;
  let skipped = false;
  let skippedBytes = 0;
  let emptyWindows = 0;
  let firstWindow = true;

  while (end > 0) {
    if (Date.now() > deadline) return { status: 'unavailable', reason: 'record_too_large' };
    const start = Math.max(0, end - maxBytes);
    const window = await readJsonlWindow(filePath, { startByte: start, maxBytes: end - start });
    if (windowFailed(window)) return { status: 'unavailable', reason: 'read_failed' };
    const holdsNoLine = window.endByte === window.startByte;
    if (firstWindow && !holdsNoLine && window.endByte !== end) return { status: 'reset' };
    firstWindow = false;
    if (holdsNoLine) {
      // The line before `end` is longer than a page: skip back through it
      // without parsing. The next window's trim ends it at that line's start.
      skipped = true;
      lineAtEnd = null;
      skippedBytes += end - start;
      if (skippedBytes > SKIP_BUDGET_BYTES) return { status: 'unavailable', reason: 'record_too_large' };
      end = start;
      continue;
    }
    const firstLine = lineAtEnd === null ? null : lineAtEnd - linesIn(window.text);
    const lines = splitJsonlLines(window.text, window.startByte, firstLine);
    const entries = parseLines(lines);
    collected.unshift({ text: window.text, startByte: window.startByte, entries, firstLine });
    lineAtEnd = firstLine;
    end = window.startByte;
    if (entries.length > 0) break;
    emptyWindows += 1;
    if (emptyWindows >= MAX_EMPTY_WINDOWS) break;
  }

  const startPosition = collected.length > 0 ? collected[0].startByte : end;
  let startLine: number | null = null;
  if (countLines) {
    if (cursor.line !== null && !skipped) {
      startLine = cursor.line - collected.reduce((sum, window) => sum + linesIn(window.text), 0);
    } else {
      startLine = await countNewlinesBefore(filePath, startPosition);
    }
  }
  const entries = countLines && collected.some((window) => window.firstLine === null)
    ? renumber(collected, startLine, parseLines)
    : collected.flatMap((window) => window.entries);

  return {
    status: 'ok',
    page: {
      sourceToken,
      startCursor: encodeJsonlCursor({ byte: startPosition, line: startLine }),
      endCursor: encodeJsonlCursor({ byte: cursor.byte, line: countLines ? (cursor.line ?? await countNewlinesBefore(filePath, cursor.byte)) : null }),
      startPosition,
      endPosition: cursor.byte,
      totalPosition: size,
      reachedStart: startPosition === 0,
      reachedEnd: cursor.byte >= until,
      entries,
    },
  };
}

async function readForward(context: ReadContext & {
  cursor: JsonlCursor | null;
  readFrom: number;
  checkAlignment: boolean;
}): Promise<TranscriptPageReadResult> {
  const { filePath, size, until, maxBytes, deadline, countLines, parseLines, sourceToken, cursor, checkAlignment } = context;
  const collected: CollectedWindow[] = [];
  let readFrom = context.readFrom;
  let startPosition: number | null = cursor ? cursor.byte : null;
  let end = cursor ? cursor.byte : readFrom;
  // The line index of the next window's first line, while the windows are
  // contiguous with a counted start; a skip loses it.
  let lineAtNext: number | null = countLines && cursor && checkAlignment ? cursor.line : null;
  let skipped = false;
  let skippedBytes = 0;
  let emptyWindows = 0;
  let firstWindow = true;

  while (end < until) {
    if (Date.now() > deadline) return { status: 'unavailable', reason: 'record_too_large' };
    const window = await readJsonlWindow(filePath, { startByte: readFrom, maxBytes: Math.min(maxBytes, until - readFrom) });
    if (windowFailed(window)) return { status: 'unavailable', reason: 'read_failed' };
    const holdsNoLine = window.endByte === window.startByte;
    if (firstWindow && checkAlignment && cursor && window.startByte !== cursor.byte && !holdsNoLine) {
      return { status: 'reset' };
    }
    if (firstWindow && startPosition === null) startPosition = window.startByte;
    firstWindow = false;
    if (holdsNoLine) {
      // A line longer than a page: carry on past it. The next window's leading
      // skip drops the rest of it.
      skipped = true;
      lineAtNext = null;
      skippedBytes += window.nextByteOffset - readFrom;
      if (skippedBytes > SKIP_BUDGET_BYTES) return { status: 'unavailable', reason: 'record_too_large' };
      if (window.nextByteOffset <= readFrom) break;
      readFrom = window.nextByteOffset;
      // Once the skip has consumed the long line's newline, the window starts
      // at the next line; at `until` that ends the page.
      end = Math.max(end, window.endByte);
      continue;
    }
    // An uncounted first window (an `around` read) counts its line once here,
    // so it parses numbered and later windows follow on from it.
    if (countLines && !skipped && collected.length === 0 && lineAtNext === null) {
      lineAtNext = await countNewlinesBefore(filePath, window.startByte);
    }
    const firstLine = lineAtNext;
    const lines = splitJsonlLines(window.text, window.startByte, firstLine);
    const entries = parseLines(lines);
    collected.push({ text: window.text, startByte: window.startByte, entries, firstLine });
    if (lineAtNext !== null) lineAtNext += linesIn(window.text);
    end = window.endByte;
    if (entries.length > 0) break;
    emptyWindows += 1;
    if (emptyWindows >= MAX_EMPTY_WINDOWS) break;
    readFrom = end > 0 ? end - 1 : 0;
  }

  const firstPosition = startPosition ?? end;
  const endPosition = Math.min(Math.max(end, firstPosition), size);
  const firstWindowStart = collected.length > 0 ? collected[0].startByte : endPosition;
  let startLine: number | null = null;
  if (countLines) {
    startLine = collected[0]?.firstLine ?? (cursor && cursor.line !== null && !skipped && firstWindowStart === cursor.byte
      ? cursor.line
      : await countNewlinesBefore(filePath, firstWindowStart));
  }
  const entries = countLines && collected.some((window) => window.firstLine === null)
    ? renumber(collected, startLine, parseLines)
    : collected.flatMap((window) => window.entries);
  const endLine = countLines && startLine !== null
    ? (skipped ? await countNewlinesBefore(filePath, endPosition) : startLine + collected.reduce((sum, window) => sum + linesIn(window.text), 0))
    : null;
  // The page starts at its first window unless a skipped line came first, and
  // then the counted start is its line: no second count from the file's start.
  const startCursorLine = async (): Promise<number | null> => {
    if (!countLines) return null;
    if (startLine !== null && firstPosition === firstWindowStart) return startLine;
    return countNewlinesBefore(filePath, firstPosition);
  };

  return {
    status: 'ok',
    page: {
      sourceToken,
      startCursor: encodeJsonlCursor({ byte: firstPosition, line: cursor?.line ?? await startCursorLine() }),
      endCursor: encodeJsonlCursor({ byte: endPosition, line: endLine }),
      startPosition: firstPosition,
      endPosition,
      totalPosition: size,
      reachedStart: firstPosition === 0,
      reachedEnd: endPosition >= until,
      entries,
    },
  };
}

/**
 * Re-parse windows with absolute line numbers, for an adapter whose uuids
 * number lines, when a window was parsed without its line (it came after a
 * skipped line). Numbers each window from the running line count.
 */
function renumber(
  collected: CollectedWindow[],
  startLine: number | null,
  parseLines: (lines: JsonlLine[]) => TranscriptEntry[],
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let line = startLine ?? 0;
  for (const window of collected) {
    const lines = splitJsonlLines(window.text, window.startByte, line);
    for (const entry of parseLines(lines)) entries.push(entry);
    line += linesIn(window.text);
  }
  return entries;
}
