import fs from 'node:fs';
import { mapWithConcurrency } from '../../shared/map-with-concurrency';
import { errorCodeOf, errorNameOf } from '../../../shared/handled-error-copy';

/** First-N bytes checked for a null byte to detect binary content (same
 *  heuristic git itself uses). */
const BINARY_CHECK_BYTES = 8192;

/** Above this size, only the first LARGE_FILE_CAP_BYTES are read and scanned,
 *  and the resulting count is a floor rather than an exact total - protects
 *  the scan from allocating/walking an unbounded buffer for a pathologically
 *  large untracked file (a generated bundle, a log, a checked-in binary blob
 *  that slipped past the binary check). */
const LARGE_FILE_CAP_BYTES = 20 * 1024 * 1024;

/**
 * The most files a count holds open at once. A folder missing from `.gitignore`
 * lists every file under it as untracked, and one open per file at the same
 * time asked for a descriptor per file, where a Windows process has 8192.
 * Measured on 150,000 files: 8,189 opened, the other 141,811 failed with EMFILE
 * and read as empty, and three in four unrelated opens in the same process
 * failed while it ran. libuv reads on four threads, so a wider pool reads no
 * faster. Its queue is first in, first out, so a longer one holds back every
 * other file call in the process until it drains.
 */
export const LINE_COUNT_CONCURRENCY = 32;

export interface LineCountResult {
  insertions: number;
  binary: boolean;
  /** True when the file exceeded LARGE_FILE_CAP_BYTES: insertions only counts
   *  the first LARGE_FILE_CAP_BYTES, not the whole file. */
  truncated: boolean;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_BYTES);
  for (let index = 0; index < checkLength; index++) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/** Counts newline (0x0A) bytes via Buffer.indexOf - a native memchr scan,
 *  tens of times faster than a per-byte JS loop over the same buffer - plus
 *  one more for a final line with no trailing newline. */
function countNewlines(buffer: Buffer): number {
  let count = 0;
  let index = buffer.indexOf(0x0A);
  while (index !== -1) {
    count += 1;
    index = buffer.indexOf(0x0A, index + 1);
  }
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0A) count += 1;
  return count;
}

/**
 * Counts inserted lines for a single untracked file (and detects binary
 * content), reading at most LARGE_FILE_CAP_BYTES so neither the read nor the
 * scan is unbounded. Used both inline (small untracked sets) and inside the
 * line-count worker (large ones) - see diff-service.ts.
 */
export async function countFileLines(absolutePath: string): Promise<LineCountResult> {
  const stats = await fs.promises.stat(absolutePath);
  const truncated = stats.size > LARGE_FILE_CAP_BYTES;
  const readLength = truncated ? LARGE_FILE_CAP_BYTES : stats.size;

  const handle = await fs.promises.open(absolutePath, 'r');
  try {
    // A single FileHandle.read is not guaranteed to fill the buffer (there is no
    // internal retry loop, unlike fs.readFile), so scan only the bytes actually
    // returned. The zero-padded tail of an over-allocated buffer would otherwise
    // flip a short read to a false binary result and corrupt the newline count.
    // allocUnsafe skips zero-filling up to LARGE_FILE_CAP_BYTES since the read
    // overwrites what we scan.
    const buffer = Buffer.allocUnsafe(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
    const scanned = buffer.subarray(0, bytesRead);
    if (isBinaryBuffer(scanned)) {
      return { insertions: 0, binary: true, truncated: false };
    }
    return { insertions: countNewlines(scanned), binary: false, truncated };
  } finally {
    await handle.close();
  }
}

/**
 * A working-tree path that is not a file any more: deleted, or turned into a
 * directory or into a path through a file since git listed it. `EISDIR` is
 * also what reading an untracked nested repository answers, which git lists as
 * one `folder/` entry. Each is an outcome of the user's own tree, met again on
 * every refresh, so it is neither logged nor reported. Only a disk read
 * carries a `code`.
 */
const MISSING_PATH_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && MISSING_PATH_CODES.has(error.code);
}

/**
 * Hands `sink` the first failure of each class and errno, and drops the rest.
 * A full descriptor table fails every file after it the same way, and 150,000
 * copies of one failure say no more than the first.
 */
export function firstOfEachFailure(sink: (error: unknown) => void): (error: unknown) => void {
  const seen = new Set<string>();
  return (error) => {
    const key = `${errorNameOf(error)}:${errorCodeOf(error) ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    sink(error);
  };
}

/**
 * Counts every path through `countFileLines`, at most LINE_COUNT_CONCURRENCY
 * at a time, with the results in the paths' order. It never rejects. A path
 * that is not a file any more counts as no lines. So does a file that failed
 * any other way (a full descriptor table, a file another program holds, a read
 * the disk failed), after `onUncounted` is handed the error: main reports it
 * there, and the worker, which cannot report, relays a fixed code for main to
 * report.
 */
export function countLinesInFiles(
  absolutePaths: readonly string[],
  onUncounted: (error: unknown) => void,
): Promise<LineCountResult[]> {
  return mapWithConcurrency(absolutePaths, LINE_COUNT_CONCURRENCY, async (absolutePath): Promise<LineCountResult> => {
    try {
      return await countFileLines(absolutePath);
    } catch (error) {
      // report-ok: a path that is not a file any more counts as no lines. Any other failure
      // goes to the caller, which reports it in main and relays a fixed code from the worker.
      if (!isMissingPathError(error)) onUncounted(error);
      return { insertions: 0, binary: false, truncated: false };
    }
  });
}
