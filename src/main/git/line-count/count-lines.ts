import fs from 'node:fs';

/** First-N bytes checked for a null byte to detect binary content (same
 *  heuristic git itself uses). */
const BINARY_CHECK_BYTES = 8192;

/** Above this size, only the first LARGE_FILE_CAP_BYTES are read and scanned,
 *  and the resulting count is a floor rather than an exact total - protects
 *  the scan from allocating/walking an unbounded buffer for a pathologically
 *  large untracked file (a generated bundle, a log, a checked-in binary blob
 *  that slipped past the binary check). */
const LARGE_FILE_CAP_BYTES = 20 * 1024 * 1024;

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
