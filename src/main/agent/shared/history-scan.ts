/**
 * Shared async filesystem primitives for agent session-history scanning.
 *
 * Every agent adapter discovers the models a user has run by walking that
 * agent's on-disk session store and reading model ids out of the transcript
 * head/tail. Those walks used to be copy-pasted synchronous `readdirSync` /
 * `statSync` / `openSync`+`readSync` blocks - one per adapter - and ran on the
 * main process during `agents.list()`, monopolizing the Node event loop and
 * freezing the UI for hundreds of milliseconds.
 *
 * These helpers are the single async (`fs/promises`) implementation of the two
 * operations every walk needs: "rank a directory's children by mtime, take the
 * most-recent N" and "read a bounded head/tail of a file". Because they await,
 * a cold scan yields to the event loop between files instead of blocking it.
 * The per-adapter model-field extraction stays in each adapter (the on-disk
 * schema is agent-specific); only the generic I/O lives here.
 */

import { readdir, stat, open, readFile, access } from 'node:fs/promises';
import { constants as fsConstants, createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

/** Default head/tail budget per session file. The model id sits near the
 *  start (or, for Copilot, the end) of a transcript, so a bounded read is
 *  enough and keeps the scan cheap even on multi-megabyte session files. */
export const SESSION_SCAN_HEAD_BYTES = 256 * 1024;

export interface RankedEntry {
  fullPath: string;
  mtimeMs: number;
}

interface ListMostRecentDirsOptions {
  /** When set, rank (and `requireMtimeSubpath`-filter) by the mtime of this
   *  child path inside each directory rather than the directory's own mtime.
   *  Used by Gemini/Qwen, which rank project dirs by their `chats/` subdir so
   *  test-artifact dirs that never hosted a session sort to the back. */
  mtimeSubpath?: string;
  /** Drop entries whose `mtimeSubpath` could not be stat-ed (or is mtime 0).
   *  Only meaningful together with `mtimeSubpath`. */
  requireMtimeSubpath?: boolean;
}

/**
 * List the immediate subdirectories of `parent`, ranked newest-first by mtime,
 * capped at `maxEntries`. Stats run concurrently (so the walk yields to the
 * event loop). A stat failure leaves an entry at mtime 0 (sorted to the back),
 * matching the prior synchronous behavior; a `readdir` failure returns `[]`.
 */
export async function listMostRecentDirs(
  parent: string,
  maxEntries: number,
  options: ListMostRecentDirsOptions = {},
): Promise<RankedEntry[]> {
  let dirents;
  try {
    dirents = await readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const directories = dirents.filter((entry) => entry.isDirectory());
  const ranked = await Promise.all(
    directories.map(async (entry) => {
      const fullPath = path.join(parent, entry.name);
      const statTarget = options.mtimeSubpath ? path.join(fullPath, options.mtimeSubpath) : fullPath;
      let mtimeMs = 0;
      let statOk = false;
      try {
        mtimeMs = (await stat(statTarget)).mtimeMs;
        statOk = true;
      } catch {
        // Keep the entry but sort it to the back (or drop it below).
      }
      return { fullPath, mtimeMs, statOk };
    }),
  );
  const filtered = options.requireMtimeSubpath
    ? ranked.filter((entry) => entry.statOk && entry.mtimeMs > 0)
    : ranked;
  filtered.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return filtered.slice(0, maxEntries).map(({ fullPath, mtimeMs }) => ({ fullPath, mtimeMs }));
}

/**
 * List files in `directory` matching `predicate`, ranked newest-first by mtime,
 * capped at `maxEntries`. Same failure semantics as `listMostRecentDirs`.
 */
export async function listMostRecentFiles(
  directory: string,
  predicate: (name: string) => boolean,
  maxEntries: number,
): Promise<RankedEntry[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const ranked = await Promise.all(
    names.filter(predicate).map(async (name) => {
      const fullPath = path.join(directory, name);
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(fullPath)).mtimeMs;
      } catch {
        // Unreadable file - sort to the back.
      }
      return { fullPath, mtimeMs };
    }),
  );
  ranked.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return ranked.slice(0, maxEntries);
}

/**
 * Read up to `maxBytes` from the head of a file. Returns `''` on any failure
 * (missing file, read error). Never loads more than `maxBytes`.
 */
export async function readHeadBytes(filePath: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();
    const readLength = Math.min(size, maxBytes);
    if (readLength <= 0) return '';
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
    return buffer.toString('utf-8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (handle) await handle.close().catch(() => { /* swallow */ });
  }
}

/**
 * Read up to `maxBytes` from the tail of a file. When the read starts
 * mid-file, the truncated first partial line is dropped so callers parse only
 * whole records. Returns `''` on any failure. Used by Copilot, whose
 * model-bearing `session.shutdown` event lands at the end of the transcript.
 */
export async function readTailBytes(filePath: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();
    const readLength = Math.min(size, maxBytes);
    if (readLength <= 0) return '';
    const position = Math.max(0, size - readLength);
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, position);
    const text = buffer.toString('utf-8', 0, bytesRead);
    if (position > 0) {
      const newlineIndex = text.indexOf('\n');
      return newlineIndex >= 0 ? text.slice(newlineIndex + 1) : text;
    }
    return text;
  } catch {
    return '';
  } finally {
    if (handle) await handle.close().catch(() => { /* swallow */ });
  }
}

/** One bounded window of a newline-delimited file, plus what it left out. */
export interface JsonlWindow {
  /** Whole lines only. Empty when the file is missing or unreadable. */
  text: string;
  /** Byte offset the returned text starts at, AFTER any partial-line drop. */
  startByte: number;
  /** Byte offset to pass as the next call's `startByte`. Equals `totalBytes` at EOF. */
  nextByteOffset: number;
  /** Source bytes before `startByte` that this window does not cover. */
  omittedBytes: number;
  /** Physical lines before `startByte`. Only computed when `countOmittedLines`. */
  omittedLineCount: number;
  /** The file's size at read time. */
  totalBytes: number;
}

export interface JsonlWindowOptions {
  /** Where to start. Defaults to a TAIL window (the last `maxBytes`). */
  startByte?: number;
  maxBytes: number;
  /**
   * Count physical lines before the window by streaming `[0, startByte)` and
   * counting newline bytes (O(1) memory, no JSON.parse). Off by default, and
   * on for every parser whose transcript entry uuids embed
   * `<sessionId>:<physicalLineIndex>` - those uuids are the persisted anchors
   * citations resolve against, so a parser that renumbers lines when its read
   * stops covering the whole file silently breaks every stored citation.
   *
   * The scan is free below the parse cap (`endByte <= 0` returns immediately)
   * and cheap above it: measured against the real transcripts on a dev machine,
   * the worst case was 27ms to scan the 121.9MB omitted head of a 137.9MB
   * transcript, and it only reruns when the file has actually changed (the
   * transcript cache is stat-validated). That is why parsers which need the
   * count only as a FALLBACK still just set this flag rather than resolving it
   * lazily - the laziness measured as noise and cost a second code shape.
   */
  countOmittedLines?: boolean;
}

/** Count newline bytes in `[0, endByte)` without materializing the range. */
async function countNewlinesBefore(filePath: string, endByte: number): Promise<number> {
  if (endByte <= 0) return 0;
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(Math.min(endByte, 1024 * 1024));
    let position = 0;
    let newlines = 0;
    while (position < endByte) {
      const readLength = Math.min(buffer.length, endByte - position);
      const { bytesRead } = await handle.read(buffer, 0, readLength, position);
      if (bytesRead <= 0) break;
      // `indexOf` is a native memchr scan; the equivalent per-byte JS loop runs
      // this same range one interpreted comparison at a time. That matters here
      // because the range is the whole omitted head of the transcript and this
      // reruns on every parse - which for a live Grok session past the cap is
      // every conversation-viewer poll, on the main process.
      const chunk = buffer.subarray(0, bytesRead);
      for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) {
        newlines += 1;
      }
      position += bytesRead;
    }
    return newlines;
  } catch {
    return 0;
  } finally {
    if (handle) await handle.close().catch(() => { /* swallow */ });
  }
}

/**
 * Read at most `maxBytes` of whole lines from a newline-delimited file,
 * starting either at an explicit `startByte` or (by default) at the file's
 * TAIL. Generalizes `readTailBytes` with an explicit offset and the metadata a
 * caller needs to either report the omission or walk the file window by window.
 *
 * This is the bounded replacement for `readFile(path, 'utf-8')` on a transcript.
 * An unbounded whole-file read is what OOM'd the main process: a 137.9MB
 * transcript becomes a 275.9MB UTF-16 string just to be read, and several such
 * reads were routinely in flight at once. A transcript's size is driven by how
 * long a user has been working, so it has no ceiling any caller can assume.
 *
 * When the window starts mid-file, the truncated leading partial line is
 * dropped so callers only ever parse whole records, and `startByte` reports the
 * post-drop offset. Returns an empty window on any failure.
 */
export async function readJsonlWindow(
  filePath: string,
  options: JsonlWindowOptions,
): Promise<JsonlWindow> {
  const empty: JsonlWindow = {
    text: '', startByte: 0, nextByteOffset: 0, omittedBytes: 0, omittedLineCount: 0, totalBytes: 0,
  };
  let handle;
  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();
    if (size <= 0) return empty;

    const maxBytes = Math.max(0, options.maxBytes);
    // No explicit start means a tail window: the most recent `maxBytes`.
    const requestedStart = options.startByte ?? Math.max(0, size - maxBytes);
    if (requestedStart >= size) {
      // `omittedLineCount` has to be computed here too, not left at the spread
      // `empty`'s 0. This branch reports the WHOLE file as omitted, so a caller
      // deriving absolute line indices from it would restart at 0 and mint
      // uuids colliding with the file's real first lines. Unreachable on the
      // tail path (`requestedStart` is `size - maxBytes`, and `size <= 0` has
      // already returned), but reachable the moment a windowed walk asks for an
      // offset at or past EOF.
      const omittedLineCount = options.countOmittedLines
        ? await countNewlinesBefore(filePath, size)
        : 0;
      return {
        ...empty, startByte: size, nextByteOffset: size, omittedBytes: size, omittedLineCount, totalBytes: size,
      };
    }

    const readLength = Math.min(maxBytes, size - requestedStart);
    if (readLength <= 0) return empty;
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, requestedStart);
    const bytes = buffer.subarray(0, bytesRead);

    // EVERY span below is measured in the BYTE domain, and the text is decoded
    // exactly once at the end. Slicing the decoded string instead desyncs every
    // offset derived from it: a window start is an arbitrary byte and can land
    // mid-UTF-8-sequence, whereupon `toString` renders each orphaned
    // continuation byte as U+FFFD, which re-encodes to THREE bytes. Measuring a
    // dropped prefix that way over-reports it by up to 6 bytes, which is enough
    // to carry `startByte` across a newline and shift every Grok uuid (its
    // `<sessionId>:<physicalLineIndex>` anchors are derived from this offset).
    let sliceStart = 0;
    let sliceEnd = bytesRead;

    if (requestedStart > 0) {
      // Mid-file start: the first line is almost certainly truncated (and may
      // even begin mid-UTF-8-sequence), so drop through the first newline.
      // No newline in the whole window means nothing complete to hand back.
      const newlineIndex = bytes.indexOf(0x0a);
      sliceStart = newlineIndex >= 0 ? newlineIndex + 1 : bytesRead;
    }

    const startByte = requestedStart + sliceStart;
    const reachedEof = requestedStart + bytesRead >= size;
    let nextByteOffset = requestedStart + sliceEnd;

    if (!reachedEof) {
      // Trailing partial line: keep it out of `text` and out of `nextByteOffset`
      // so the next window re-reads it whole. At EOF there is nothing after it,
      // so the final record (which may legitimately lack a trailing newline) is
      // kept rather than silently dropped. A poll that lands mid-write of that
      // final line therefore hands a half-written record to the caller, which
      // skips it on the parse error - an accepted, self-healing race (this
      // function is deliberately stateless and has no carry buffer, unlike
      // Claude's incremental path), because the next poll re-reads it whole.
      const lastNewline = bytes.lastIndexOf(0x0a);
      if (lastNewline >= sliceStart) {
        sliceEnd = lastNewline + 1;
        // Point AT that final newline, not past it. Every mid-file start drops
        // through its first newline (it has to: an arbitrary offset lands
        // mid-record), so handing back the offset just PAST a newline would
        // make the next window mistake a whole record for a partial one and
        // drop it. Landing ON the newline means the next window's drop consumes
        // exactly that one byte. This is what makes consecutive windows tile a
        // file exactly once, and it is why `startByte` is safe to pass from a
        // previous `nextByteOffset` verbatim.
        nextByteOffset = requestedStart + sliceEnd - 1;
      } else {
        // A single line longer than the whole window. Advancing past the bytes
        // actually read is the only way to make progress; the record is skipped
        // rather than parsed. Measure that advance from `requestedStart`, NOT
        // from `startByte` - the latter already includes the whole window, so
        // adding the window a second time leaves a further window-sized span
        // unread and silently drops every record in it.
        sliceEnd = sliceStart;
        nextByteOffset = requestedStart + bytesRead;
      }
    }

    // Both bounds sit on a record boundary, so this never splits a sequence.
    const text = bytes.toString('utf-8', sliceStart, sliceEnd);

    const omittedLineCount = options.countOmittedLines
      ? await countNewlinesBefore(filePath, startByte)
      : 0;

    return { text, startByte, nextByteOffset, omittedBytes: startByte, omittedLineCount, totalBytes: size };
  } catch {
    return empty;
  } finally {
    if (handle) await handle.close().catch(() => { /* swallow */ });
  }
}

/**
 * Stream a newline-delimited file record by record, never materializing it.
 *
 * For readers that only need per-line AGGREGATES (cumulative token usage, tool
 * counts) rather than retained entries: they were reading whole files purely to
 * `split()` them, which put the entire transcript on the heap to compute a
 * handful of running totals.
 *
 * `onRecord` receives the PHYSICAL line index, which advances across blank and
 * unparseable lines so it matches `content.split(/\r?\n/)` for every line that
 * can carry a record. It is not a drop-in for `split(...).length`: a file
 * ending in `\n` yields one fewer line here, because `split` produces a
 * trailing empty element that readline does not emit. That element can never
 * hold a record, so the indices of real records agree either way.
 * Return `false` to stop early. Silent no-op on a missing file.
 *
 * Resolves `false` when the file could not be read THROUGH TO THE END, so a
 * caller computing a session-cumulative aggregate can tell a genuinely empty
 * file from a truncated read. That distinction is load-bearing: the whole-file
 * `readFile` this replaced THREW on an I/O error, and its callers turned that
 * into `null` and fell back to the live snapshot. Silently keeping a partial
 * sum instead would write a too-small lifetime token total to the session row,
 * where it is displayed as fact.
 */
export async function streamJsonlRecords(
  filePath: string,
  onRecord: (record: Record<string, unknown>, physicalLineIndex: number) => boolean | void,
): Promise<boolean> {
  // Pre-check before createReadStream: a stream 'error' would otherwise throw
  // inside the for-await loop below. The common case is benign (the file was
  // rotated or never written). This catches ABSENCE only - it does not detect a
  // Windows sharing violation, which is a different mechanism entirely and is
  // covered by the error listener below, not here.
  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    return false;
  }
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  // Backstop for races the pre-check cannot cover: the file disappearing
  // mid-read, or EBUSY on Windows where the team dogfoods. Recorded rather
  // than merely swallowed so the partial read is reportable.
  let readFailed = false;
  stream.on('error', () => { readFailed = true; });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let stopped = false;
  let physicalLineIndex = 0;
  try {
    for await (const line of lineReader) {
      const currentIndex = physicalLineIndex;
      physicalLineIndex += 1;
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (onRecord(parsed as Record<string, unknown>, currentIndex) === false) {
        stopped = true;
        break;
      }
    }
  } catch {
    // A mid-stream failure that surfaced through the async iterator rather than
    // the 'error' listener. Same meaning: the file was not read to the end.
    readFailed = true;
  } finally {
    lineReader.close();
    if (stopped && !stream.destroyed) stream.destroy();
  }
  // An early stop is a caller's own decision, not a failure - but it did not
  // reach the end either, so it is not a complete read.
  return !readFailed && !stopped;
}

/**
 * Read an entire file as UTF-8. Returns `''` on any failure. Used only where a
 * record spans the whole file (Gemini's single-document `.json` sessions);
 * prefer `readHeadBytes`/`readTailBytes` for newline-delimited transcripts.
 */
export async function readWholeFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Split JSONL `text` into parsed object records, skipping blank and
 * unparseable lines and any non-object value. When `dropLastPartialLine` is
 * true, the final element is dropped first (a head read almost always
 * truncates the last record mid-line; well-formed JSONL ends with a newline so
 * the final element is empty and dropping it is harmless).
 */
export function parseJsonlRecords(text: string, dropLastPartialLine: boolean): Record<string, unknown>[] {
  const lines = text.split('\n');
  if (dropLastPartialLine && lines.length > 0) lines.pop();
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      records.push(parsed as Record<string, unknown>);
    }
  }
  return records;
}
