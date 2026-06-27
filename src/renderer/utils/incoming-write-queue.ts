import type { Terminal } from '@xterm/xterm';

/**
 * Bounded queue for INCOMING PTY data on its way into xterm.
 *
 * The renderer is a single thread shared by every xterm, the React board, and
 * all input. Writing a multi-MB burst to xterm in one synchronous
 * `xterm.write(data)` call monopolizes that thread and freezes the UI. This
 * queue instead writes the data in capped slices, pacing each slice on
 * `xterm.write`'s completion callback so the event loop runs (input, React,
 * paint) between slices.
 *
 * It also closes the backpressure loop: every consumed slice is acknowledged
 * back to the main process via `ack`, which decrements main's per-session
 * in-flight counter and resumes a paused PTY. Slices that are intentionally
 * DROPPED (scrollback replay or an overlay owns the screen) are still acked -
 * otherwise the PTY would stay paused forever on bytes the renderer discarded.
 *
 * Mirrors the main-side `src/main/pty/write-queue.ts` chunk-and-yield shape.
 */

/** Per-slice cap. Small enough that one `xterm.write` parse stays well under a
 *  frame, so input latency stays low even during a sustained output flood. */
export const DEFAULT_INCOMING_CHUNK = 64 * 1024;

/**
 * Largest end index in `[start, start+maxLen]` that does not split a UTF-16
 * surrogate pair. xterm's parser reassembles escape sequences across `write`
 * calls, so only surrogate pairs need protecting across slice boundaries.
 */
function safeSliceEnd(str: string, start: number, maxLen: number): number {
  const tentative = Math.min(start + maxLen, str.length);
  if (tentative >= str.length) return str.length;
  const code = str.charCodeAt(tentative - 1);
  if (code >= 0xd800 && code <= 0xdbff) return tentative - 1;
  return tentative;
}

export interface IncomingWriteQueue {
  /** Append received PTY data; starts the paced drain loop if idle. */
  push(data: string): void;
  /**
   * Drop buffered (not-yet-dispatched) bytes, acking them so backpressure is
   * released, and stop. Bytes already handed to `xterm.write` but awaiting its
   * callback are not covered here; the session-teardown path
   * (`BackpressureController.release`) clears those. For session change / unmount.
   */
  reset(): void;
}

export interface IncomingWriteQueueOptions {
  /** The live xterm instance, or null if it is not currently mounted. */
  getTerminal: () => Terminal | null;
  /** True while incoming data must be discarded (scrollback replay / overlay). */
  shouldDrop: () => boolean;
  /** Report `bytes` consumed (written or dropped) to main's flow control. */
  ack: (bytes: number) => void;
  chunkSize?: number;
}

export function createIncomingWriteQueue(
  options: IncomingWriteQueueOptions,
): IncomingWriteQueue {
  const chunkSize = options.chunkSize ?? DEFAULT_INCOMING_CHUNK;
  let buffer = '';
  let draining = false;

  const drain = (): void => {
    const term = options.getTerminal();
    if (!term) {
      // No terminal to write into: discard the backlog but ack it so main's
      // per-session backpressure is released. A later scrollback replay
      // repaints the full buffer when the terminal remounts.
      const dropped = buffer.length;
      buffer = '';
      draining = false;
      if (dropped > 0) options.ack(dropped);
      return;
    }
    if (buffer.length === 0) {
      draining = false;
      return;
    }
    const end = safeSliceEnd(buffer, 0, chunkSize);
    const chunk = buffer.slice(0, end);
    buffer = buffer.slice(end);

    if (options.shouldDrop()) {
      // Scrollback replay or an overlay owns the screen; discard this slice but
      // ack it and keep draining on the next microtask (yields to input/React).
      options.ack(chunk.length);
      queueMicrotask(drain);
      return;
    }

    // xterm processes its write buffer asynchronously, so the callback both
    // paces the loop (one slice per processed chunk) and yields between slices.
    term.write(chunk, () => {
      options.ack(chunk.length);
      drain();
    });
  };

  return {
    push(data: string): void {
      if (data.length === 0) return;
      buffer += data;
      if (draining) return;
      draining = true;
      drain();
    },
    reset(): void {
      const dropped = buffer.length;
      buffer = '';
      draining = false;
      if (dropped > 0) options.ack(dropped);
    },
  };
}

/**
 * Write a large string (e.g. a 512KB scrollback replay) to xterm in capped,
 * surrogate-safe slices, calling `onDone` after the last slice is processed.
 * Avoids one giant synchronous parse on a tab/window switch or resize.
 * Not backpressure-counted: scrollback is pulled, not pushed, so no acking.
 */
export function writeChunkedToTerminal(
  term: Terminal,
  data: string,
  onDone: () => void,
  chunkSize: number = DEFAULT_INCOMING_CHUNK,
): void {
  if (data.length <= chunkSize) {
    term.write(data, onDone);
    return;
  }
  let offset = 0;
  const writeNext = (): void => {
    if (offset >= data.length) {
      onDone();
      return;
    }
    const end = safeSliceEnd(data, offset, chunkSize);
    const chunk = data.slice(offset, end);
    offset = end;
    term.write(chunk, writeNext);
  };
  writeNext();
}
