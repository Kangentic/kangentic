/**
 * Per-session serial write queue.
 *
 * `pty.write` on Windows ConPTY is fire-and-forget; sustained large writes
 * can saturate the input pipe and reorder bytes. To avoid that, every
 * `enqueue` for a given session appends to a single buffer drained by one
 * loop that emits at most `chunkSize` bytes per tick, yielding via
 * `setImmediate` between chunks so libuv can flush the named pipe.
 *
 * Concurrent enqueues append to the same buffer, so byte order is FIFO
 * regardless of how many callers (user input, command-injector, paste)
 * write to the same session at once. This is the invariant that prevents
 * bracketed-paste sequences from being fragmented by interleaved writes -
 * the regression that caused Ctrl+V truncation.
 *
 * The queue is also surrogate-pair-safe: chunks never split a JavaScript
 * UTF-16 surrogate pair, which would otherwise produce U+FFFD replacement
 * characters when node-pty UTF-8-encodes the chunk.
 */

export interface PtyWriteTarget {
  write(data: string): void;
}

export interface WriteQueue {
  /** Append bytes to the buffer; starts the drain loop if idle. */
  enqueue(data: string): void;
  /** Drop pending bytes and stop the drain loop. Idempotent. */
  dispose(): void;
}

export const DEFAULT_CHUNK_SIZE = 4096;

/** Compute a safe chunk endpoint that does not split a UTF-16 surrogate pair.
 *  Returns `chunkSize` when the boundary is safe, `chunkSize - 1` when the
 *  preceding code unit is a high surrogate (0xD800-0xDBFF). The caller has
 *  already verified `buffer.length > chunkSize`, so the low surrogate exists
 *  to be emitted in the next chunk. */
function safeChunkEnd(buffer: string, chunkSize: number): number {
  if (chunkSize <= 1) return chunkSize;
  const code = buffer.charCodeAt(chunkSize - 1);
  if (code >= 0xd800 && code <= 0xdbff) return chunkSize - 1;
  return chunkSize;
}

export interface CreateWriteQueueOptions {
  /** Optional callback fired when the queue auto-disposes after a thrown
   *  `pty.write`. Lets the owner remove its map entry so the next enqueue
   *  for the same session creates a fresh queue rather than reusing a
   *  permanently disposed one. Not called for explicit `dispose()`
   *  invocations - those callers already manage their own state. */
  onAutoDispose?: () => void;
}

export function createWriteQueue(
  getPty: () => PtyWriteTarget | null,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  options: CreateWriteQueueOptions = {},
): WriteQueue {
  let buffer = '';
  let draining = false;
  let disposed = false;

  const drain = (): void => {
    if (disposed) {
      buffer = '';
      draining = false;
      return;
    }
    const pty = getPty();
    if (!pty) {
      // Session ended mid-drain. Drop pending bytes; the renderer will not
      // be notified - matching the existing fire-and-forget IPC contract.
      buffer = '';
      draining = false;
      return;
    }
    if (buffer.length === 0) {
      draining = false;
      return;
    }
    const end = buffer.length > chunkSize ? safeChunkEnd(buffer, chunkSize) : buffer.length;
    const chunk = buffer.slice(0, end);
    buffer = buffer.slice(end);
    try {
      pty.write(chunk);
    } catch (error) {
      // pty.write can throw if the underlying handle was torn down between
      // our null check and the call. Stop the loop and drop pending bytes
      // rather than re-entering and looping on the same failure. Notify
      // the owner so it can clear its map entry; otherwise the next write
      // for this session would silently reuse a disposed queue.
      console.error('[write-queue] pty.write threw, dropping pending bytes:', error);
      buffer = '';
      draining = false;
      disposed = true;
      options.onAutoDispose?.();
      return;
    }
    if (buffer.length === 0) {
      draining = false;
      return;
    }
    setImmediate(drain);
  };

  return {
    enqueue(data: string): void {
      if (disposed || data.length === 0) return;
      buffer += data;
      if (draining) return;
      draining = true;
      drain();
    },
    dispose(): void {
      disposed = true;
      buffer = '';
    },
  };
}
