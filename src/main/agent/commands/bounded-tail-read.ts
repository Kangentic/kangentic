import { promises as fsPromises } from 'node:fs';

export interface BoundedTailReadResult {
  /** Whole file when under maxBytes; otherwise the last maxBytes with the
   *  leading partial line dropped (a seek into the middle of a file usually
   *  lands mid-line). */
  content: string;
  /** True when only the tail window was read. */
  truncated: boolean;
  /** On-disk file size in bytes. */
  totalBytes: number;
}

/**
 * Read at most `maxBytes` from the END of a text file.
 *
 * Line-oriented files (JSONL event logs, agent session histories) grow without
 * bound, but their consumers only ever want the most recent entries. This
 * helper seeks to `size - maxBytes` and reads a bounded window, dropping the
 * partial first line so callers always see whole lines. The reads are
 * asynchronous, so a slow disk waits off the main thread.
 *
 * Degenerate case: when the window contains no newline at all (a single line
 * >= maxBytes), the raw window is returned unmodified - a partial line,
 * possibly starting mid-UTF-8-codepoint (a leading U+FFFD). Returned rather
 * than dropped so the caller still sees data; JSONL consumers already skip
 * unparseable lines.
 *
 * Rejects on fs errors (missing file, permission): callers keep their own
 * error-response semantics.
 */
export async function readBoundedTail(filePath: string, maxBytes: number): Promise<BoundedTailReadResult> {
  const stats = await fsPromises.stat(filePath);
  if (stats.size <= maxBytes) {
    return {
      content: await fsPromises.readFile(filePath, 'utf-8'),
      truncated: false,
      totalBytes: stats.size,
    };
  }

  const buffer = Buffer.alloc(maxBytes);
  const handle = await fsPromises.open(filePath, 'r');
  try {
    await handle.read(buffer, 0, maxBytes, stats.size - maxBytes);
  } finally {
    await handle.close();
  }
  const rawTail = buffer.toString('utf-8');
  const firstNewline = rawTail.indexOf('\n');
  const cleanTail = firstNewline >= 0 ? rawTail.slice(firstNewline + 1) : rawTail;
  return {
    content: cleanTail,
    truncated: true,
    totalBytes: stats.size,
  };
}
