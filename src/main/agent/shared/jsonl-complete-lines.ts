import type { FileHandle } from 'node:fs/promises';

/**
 * Bytes read per positioned read: bounds a resumable transcript cursor's peak
 * to a chunk plus one line, never the whole file. Shared by the Claude and
 * Codex tool-call cursors.
 */
export const JSONL_READ_CHUNK_BYTES = 4 * 1024 * 1024;

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
export async function forEachCompleteLine(
  handle: FileHandle,
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
    const length = Math.min(JSONL_READ_CHUNK_BYTES, endByte - position);
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
      // A copy, so the rest of the 4 MB chunk can be collected.
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
