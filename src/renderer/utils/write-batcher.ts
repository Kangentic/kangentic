/** Batches string emissions into a single flush per microtask.
 *
 *  Used by the terminal hook to coalesce synchronous bursts of xterm
 *  onData calls (e.g. from programmatic terminal.paste(), key-repeat,
 *  or the clipboard callback) into one IPC write. PTY byte order is
 *  preserved across sequential pty.write calls, so concatenating the
 *  burst into a single payload is safe.
 */
export interface WriteBatcher {
  /** Push data into the queue and schedule a microtask flush if not already scheduled. */
  schedule: (data: string) => void;
  /** Flush any pending data synchronously. Safe to call when queue is empty. */
  flush: () => void;
}

export function createWriteBatcher(write: (payload: string) => void): WriteBatcher {
  const queue: string[] = [];
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    if (queue.length === 0) return;
    const payload = queue.length === 1 ? queue[0] : queue.join('');
    queue.length = 0;
    write(payload);
  };

  const schedule = (data: string) => {
    queue.push(data);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };

  return { schedule, flush };
}
