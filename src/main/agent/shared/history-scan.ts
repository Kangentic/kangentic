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

import { readdir, stat, open, readFile } from 'node:fs/promises';
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
