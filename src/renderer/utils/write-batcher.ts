/** Batches string emissions into a single flush per microtask.
 *
 *  Used by the terminal hook to coalesce synchronous bursts of xterm
 *  onData calls (e.g. from programmatic terminal.paste(), key-repeat,
 *  or the clipboard callback) into one IPC write. PTY byte order is
 *  preserved across sequential pty.write calls, so concatenating the
 *  burst into a single payload is BYTE-safe - but not always
 *  SEMANTICS-safe: some consumers treat chunk boundaries as event
 *  boundaries. Claude Code's fullscreen TUI processes a chunk as one
 *  input batch, so N coalesced wheel reports become one N-line jump,
 *  whose differential frame intermittently mis-assembles (verified by
 *  controlled injection, 2026-08-23: ten spaced reports produced ten
 *  clean frames; the same ten in one chunk produced a spliced frame).
 *  Hence `writePaced`: mouse reports drain from the ordered queue at
 *  a per-report floor (MOUSE_REPORT_PACE_MS), restoring the
 *  physical-wheel cadence a native terminal delivers.
 *
 *  Two stronger schemes were tried and rejected on dogfooding
 *  evidence, in this order - do not resurrect them without new data:
 *  ack-clocking each report to the TUI's answer caps scrolling at the
 *  TUI's OWN frame clock (~10Hz when idle - felt like 10fps), and no
 *  input-side scheme can shrink the jump a single report produces;
 *  that is CLAUDE_CODE_SCROLL_SPEED's job (the CLI default of 1
 *  matches the native terminals verified clean).
 *
 *  UNWIND(claude-code#83714): writePaced and the isMouseReport routing
 *  exist because the fullscreen renderer mis-assembles multi-line-jump
 *  frames. When upstream fixes that, revert mouse reports to plain
 *  schedule() and delete writePaced.
 */
export interface WriteBatcher {
  /** Push data into the queue and schedule a microtask flush if not already scheduled. */
  schedule: (data: string) => void;
  /** Drain synchronously: batched items are written (joined), pending PACED
   *  items are DROPPED - they are scroll intents for a view being torn down,
   *  and writing them joined would recreate the exact coalesced chunk the
   *  paced path exists to prevent. Safe to call when the queue is empty. */
  flush: () => void;
  /** Queue `data` to be written as its OWN payload, at most one paced write
   *  per paceMs. Ordering against `schedule` data always holds: items drain
   *  strictly in arrival order, whichever path they came in through. A call
   *  drains synchronously, so batched bytes already queued flush immediately
   *  rather than waiting for their microtask. */
  writePaced: (data: string) => void;
}

/** One frame at 60Hz: long enough that the TUI's read loop usually catches
 *  each report individually, short enough that a flick's worth of reports
 *  still lands within a couple hundred milliseconds. */
const MOUSE_REPORT_PACE_MS = 16;

interface QueueItem {
  data: string;
  paced: boolean;
}

export function createWriteBatcher(
  write: (payload: string) => void,
  paceMs: number = MOUSE_REPORT_PACE_MS,
): WriteBatcher {
  const queue: QueueItem[] = [];
  let microtaskScheduled = false;
  let paceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPacedWriteAt = Number.NEGATIVE_INFINITY;

  const drain = (): void => {
    while (queue.length > 0) {
      const head = queue[0];
      if (!head.paced) {
        // A contiguous run of batchable items keeps the original
        // one-write-per-burst behavior. Removed with one splice: a per-item
        // shift() would reindex the whole remainder once per item.
        let runLength = 0;
        while (runLength < queue.length && !queue[runLength].paced) runLength += 1;
        const run = queue.splice(0, runLength);
        write(run.length === 1 ? run[0].data : run.map((item) => item.data).join(''));
        continue;
      }
      // Clamped so a backward wall-clock jump (NTP, sleep/resume skew) can
      // never inflate the wait past one pace interval and stall the queue.
      const wait = Math.min(lastPacedWriteAt + paceMs - Date.now(), paceMs);
      if (wait > 0) {
        if (paceTimer === null) {
          paceTimer = setTimeout(() => {
            paceTimer = null;
            drain();
          }, wait);
        }
        return;
      }
      if (paceTimer !== null) {
        // A writePaced call can reach here before a due timer's callback has
        // run and consume the very head that timer was scheduled for; clear
        // it so timer bookkeeping stays symmetric with consumption.
        clearTimeout(paceTimer);
        paceTimer = null;
      }
      lastPacedWriteAt = Date.now();
      queue.shift();
      write(head.data);
    }
  };

  const schedule = (data: string): void => {
    queue.push({ data, paced: false });
    if (!microtaskScheduled) {
      microtaskScheduled = true;
      queueMicrotask(() => {
        microtaskScheduled = false;
        drain();
      });
    }
  };

  const writePaced = (data: string): void => {
    queue.push({ data, paced: true });
    drain();
  };

  const flush = (): void => {
    // microtaskScheduled is deliberately left set: the still-pending
    // microtask resets it itself and then drains an already-empty queue,
    // so clearing it here would be redundant, not a leak fix.
    if (paceTimer !== null) {
      clearTimeout(paceTimer);
      paceTimer = null;
    }
    const kept: string[] = [];
    for (const item of queue) {
      if (!item.paced) kept.push(item.data);
    }
    queue.length = 0;
    if (kept.length > 0) write(kept.length === 1 ? kept[0] : kept.join(''));
  };

  return { schedule, flush, writePaced };
}
