import fs from 'node:fs/promises';
import type { PerToolStat, TranscriptToolCounts } from '../../../shared/types';
import { touchBounded } from './bounded-lru';

/**
 * A resumable per-path cursor over an append-only JSONL transcript that keeps
 * one small entry per distinct tool call, not the transcript, behind an
 * adapter's `transcriptToolCounts` and `transcriptToolResultTokens`. The
 * tool-call popover refetches on every tool call, so a repeat read must cost
 * only the bytes appended since the last one, and the CLI appends every
 * resume of a conversation to one file, so a read is scoped to one run by
 * each call's timestamp.
 *
 * The adapter supplies only `applyLine`, which reads one line in its own
 * record shape and adds calls or their result sizes to the cursor. Claude and
 * Qwen use it.
 */

/** One distinct tool call, as the cursor holds it. */
export interface ToolCallEntry {
  /** The line's timestamp; +Infinity when it carried none, so the call
   *  counts under any open window rather than vanishing. */
  timestampMs: number;
  toolName: string;
  /** Set once its result arrives; undefined while it is still pending. */
  resultTokens: number | undefined;
}

/** A cursor's state: the calls read so far and where the next read starts. */
export interface ToolCallCursor<Entry extends ToolCallEntry> {
  /** File identity at the last read; a different inode is a replaced file. */
  ino: number;
  mtimeMs: number;
  /** First byte not yet consumed: always just past a complete line. */
  offset: number;
  /**
   * The bytes just before `offset` at the last read. A resume first checks
   * they are unchanged, which catches what size, mtime and inode miss: a file
   * rewritten in place to at least its old length, or a replacement whose
   * inode reads the same (NTFS file ids past 2^53 lose precision as numbers,
   * and some filesystems report 0).
   */
  tail: Buffer;
  calls: Entry[];
  /** Calls by id: dedupes re-emitted records and finds a result's call. */
  callById: Map<string, Entry>;
}

/** A record's ISO `timestamp` in ms, or +Infinity when it has none (`ToolCallEntry.timestampMs`). */
export function toolCallTimestampMs(timestamp: unknown): number {
  const parsedMs = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsedMs) ? parsedMs : Number.POSITIVE_INFINITY;
}

/**
 * Add one call unless its id was read already (a re-emitted record). A call
 * with no id is always added and cannot be matched to a result.
 */
export function addToolCall<Entry extends ToolCallEntry>(cursor: ToolCallCursor<Entry>, callId: string, entry: Entry): void {
  if (callId.length > 0 && cursor.callById.has(callId)) return;
  cursor.calls.push(entry);
  if (callId.length > 0) cursor.callById.set(callId, entry);
}

/** Paths whose cursor is retained (the live popover's session, plus run-end
 *  backfills of recently ended sessions). */
const TOOL_CALL_CURSOR_LIMIT = 16;
/** Retained bytes per call (the entry plus its id's Map slot). Measured at
 *  about 88 in Node without pointer compression, so this leaves headroom. */
const TOOL_CALL_BYTES_PER_CALL = 128;
const TOOL_CALL_CURSOR_BYTE_BUDGET = 32 * 1024 * 1024;
/** Bytes read per positioned read: bounds the peak to a chunk plus one line. */
const TOOL_CALL_READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** Length of `ToolCallCursor.tail`. */
const TOOL_CALL_TAIL_BYTES = 64;

/** One adapter's cursors, one per transcript path. */
export interface ToolCallCursorStore<Entry extends ToolCallEntry> {
  /**
   * Advance `filePath`'s cursor to the end of the file, then answer `view`
   * from it, inside the same step so no later read can move the cursor in
   * between. Steps for one path run one after another, so overlapping
   * popover refetches never stream a long transcript twice. Null when the
   * read failed.
   */
  read<T>(filePath: string, view: (cursor: ToolCallCursor<Entry>) => T | null): Promise<T | null>;
  /** Test-only: drop every cursor. */
  reset(): void;
}

/**
 * A store whose cursors read lines with `applyLine`. A shrink, an mtime going
 * backwards, a new inode, or changed bytes just before the offset resets a
 * cursor to a full re-read; a failed read drops it. Reads go in fixed-size
 * chunks, so the peak is one chunk plus the longest line, never the whole file.
 */
export function createToolCallCursorStore<Entry extends ToolCallEntry>(
  applyLine: (cursor: ToolCallCursor<Entry>, line: string) => void,
): ToolCallCursorStore<Entry> {
  const cursorByPath = new Map<string, ToolCallCursor<Entry>>();
  const readByPath = new Map<string, Promise<void>>();

  const retain = (filePath: string, cursor: ToolCallCursor<Entry>): void => {
    touchBounded(cursorByPath, filePath, cursor, {
      limit: TOOL_CALL_CURSOR_LIMIT,
      byteBudget: TOOL_CALL_CURSOR_BYTE_BUDGET,
      sizeOf: (held) => held.calls.length * TOOL_CALL_BYTES_PER_CALL,
      // A session big enough to pass the budget alone is the one being polled
      // live; evicting it would re-read the whole file on the next refetch.
      minRetained: 1,
    });
  };

  const advance = async (filePath: string): Promise<ToolCallCursor<Entry> | null> => {
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
    // Nothing changed since the last read: answer without opening the file,
    // which is the common case for a popover refetch.
    if (existing && size === existing.offset && mtimeMs === existing.mtimeMs && ino === existing.ino) {
      retain(filePath, existing);
      return existing;
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(filePath, 'r');
      let cursor = existing;
      if (!cursor || size < cursor.offset || mtimeMs < cursor.mtimeMs || ino !== cursor.ino
          || !(await readTail(handle, cursor.offset)).equals(cursor.tail)) {
        cursor = { ino, mtimeMs, offset: 0, tail: Buffer.alloc(0), calls: [], callById: new Map() };
      }
      const advancing = cursor;
      advancing.offset = await forEachCompleteLine(handle, filePath, advancing.offset, size, (line) => {
        applyLine(advancing, line);
      });
      advancing.tail = await readTail(handle, advancing.offset);
      advancing.ino = ino;
      advancing.mtimeMs = mtimeMs;
      retain(filePath, advancing);
      return advancing;
    } catch {
      cursorByPath.delete(filePath);
      return null;
    } finally {
      await handle?.close();
    }
  };

  return {
    read<T>(filePath: string, view: (cursor: ToolCallCursor<Entry>) => T | null): Promise<T | null> {
      const previous = readByPath.get(filePath) ?? Promise.resolve();
      const step = async (): Promise<T | null> => {
        const cursor = await advance(filePath);
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
    },
    reset(): void {
      cursorByPath.clear();
      readByPath.clear();
    },
  };
}

/**
 * The calls with `sinceMs <= timestampMs < untilMs`; a missing bound is open. A
 * call whose line carried no timestamp has `timestampMs` = +Infinity: it counts
 * under any open-ended window rather than vanishing, and is left out of a closed
 * one, which cannot claim a call it cannot place.
 */
export function* callsInWindow<Entry extends ToolCallEntry>(
  cursor: ToolCallCursor<Entry>,
  sinceMs: number | null | undefined,
  untilMs: number | null | undefined,
): Generator<Entry> {
  const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) ? sinceMs : Number.NEGATIVE_INFINITY;
  const until = typeof untilMs === 'number' && Number.isFinite(untilMs) ? untilMs : Number.POSITIVE_INFINITY;
  const closed = until !== Number.POSITIVE_INFINITY;
  for (const call of cursor.calls) {
    if (call.timestampMs < since) continue;
    if (closed && !(call.timestampMs < until)) continue;
    yield call;
  }
}

/** The tool-call count and per-tool breakdown in a window, or null when it holds no call. */
export function toolCountsInWindow<Entry extends ToolCallEntry>(
  cursor: ToolCallCursor<Entry>,
  sinceMs: number | null | undefined,
  untilMs: number | null | undefined,
): TranscriptToolCounts | null {
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
}

/** Estimated result tokens per tool name in a window. A tool with no result yet is absent. */
export function resultTokensInWindow<Entry extends ToolCallEntry>(
  cursor: ToolCallCursor<Entry>,
  sinceMs: number | null | undefined,
  untilMs: number | null | undefined,
): Record<string, number> {
  const resultTokensByTool: Record<string, number> = {};
  for (const call of callsInWindow(cursor, sinceMs, untilMs)) {
    if (call.resultTokens === undefined) continue;
    resultTokensByTool[call.toolName] = (resultTokensByTool[call.toolName] ?? 0) + call.resultTokens;
  }
  return resultTokensByTool;
}

/** The up to `TOOL_CALL_TAIL_BYTES` bytes that end at `offset`. A short read returns fewer. */
async function readTail(handle: Awaited<ReturnType<typeof fs.open>>, offset: number): Promise<Buffer> {
  const length = Math.min(TOOL_CALL_TAIL_BYTES, offset);
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
  return buffer.subarray(0, bytesRead);
}

/**
 * Call `onLine` for every complete line in `[startByte, endByte)`, reading in
 * fixed-size positioned chunks. Returns the offset just past the last line it
 * consumed, so a partial trailing line (an append still being written) is left
 * for the next read. A final line with no newline is consumed only when it
 * parses as JSON, which a half-written record cannot. Throws on a short read
 * (the file was truncated mid-read), so the caller can drop its state.
 *
 * A line longer than a chunk is kept as a list of its pieces and joined once,
 * when its newline arrives, so its bytes are copied once rather than once per
 * chunk it spans.
 */
async function forEachCompleteLine(
  handle: Awaited<ReturnType<typeof fs.open>>,
  filePath: string,
  startByte: number,
  endByte: number,
  onLine: (line: string) => void,
): Promise<number> {
  let position = startByte;
  let consumedTo = startByte;
  // The bytes from `consumedTo` to `position`: the start of a line whose
  // newline has not been read yet.
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  while (position < endByte) {
    const length = Math.min(TOOL_CALL_READ_CHUNK_BYTES, endByte - position);
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead < length) {
      throw new Error(`short read on ${filePath}: expected ${length} bytes, got ${bytesRead}`);
    }
    const chunkStart = position;
    position += bytesRead;
    let newlineIndex = chunk.indexOf(0x0a);
    if (newlineIndex === -1) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      continue;
    }
    if (pendingBytes > 0) {
      onLine(Buffer.concat([...pending, chunk.subarray(0, newlineIndex)]).toString('utf-8'));
      pending = [];
      pendingBytes = 0;
    } else if (newlineIndex > 0) {
      onLine(chunk.toString('utf-8', 0, newlineIndex));
    }
    let lineStart = newlineIndex + 1;
    newlineIndex = chunk.indexOf(0x0a, lineStart);
    while (newlineIndex !== -1) {
      if (newlineIndex > lineStart) onLine(chunk.toString('utf-8', lineStart, newlineIndex));
      lineStart = newlineIndex + 1;
      newlineIndex = chunk.indexOf(0x0a, lineStart);
    }
    consumedTo = chunkStart + lineStart;
    if (lineStart < chunk.length) {
      // A copy, so the rest of the chunk can be collected.
      const remainder = Buffer.from(chunk.subarray(lineStart));
      pending.push(remainder);
      pendingBytes += remainder.length;
    }
  }
  if (pendingBytes > 0) {
    const tail = Buffer.concat(pending).toString('utf-8');
    if (isCompleteJsonLine(tail)) {
      onLine(tail);
      consumedTo += pendingBytes;
    }
  }
  return consumedTo;
}

function isCompleteJsonLine(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
