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
 *  The paced queue is BOUNDED, not just paced. A flick on a
 *  high-resolution wheel emits reports faster than the floor drains
 *  them, so an uncapped queue keeps feeding the TUI scroll commands
 *  after the hand has stopped, and its depth scales with wheel
 *  resolution rather than requested travel. Wheel reports therefore
 *  carry a lane (one wheel direction, supplied by the caller via
 *  mouseWheelLane): pending same-lane depth is capped at
 *  MOUSE_WHEEL_LANE_MAX_DEPTH, bounding the post-stop tail near
 *  depth * paceMs at the deliberate price of truncated travel on very
 *  large flicks, and a same-axis reversal drops the pending
 *  opposite-direction reports as stale intent (the same philosophy as
 *  flush). Laneless paced items (clicks, releases, motion) are never
 *  counted, capped, or superseded (a dropped release would stick a
 *  button); teardown flush still drops every pending paced item,
 *  laneless included, as it always has. The
 *  16ms floor itself stays as is: the cap changes how many writes
 *  queue, not the per-write cadence the TUI's read loop needs to
 *  catch each report individually, and lowering the floor would
 *  re-open the read-coalescing window the pacing exists to close.
 *
 *  UNWIND(claude-code#83714): writePaced, the isMouseReport routing,
 *  and the lane cap/supersede exist because the fullscreen renderer
 *  mis-assembles multi-line-jump frames. When upstream fixes that,
 *  revert mouse reports to plain schedule() and delete writePaced.
 */

/** Marks a paced item as a member of a lane of interchangeable intents
 *  (one wheel direction). The batcher stays encoding-agnostic: callers
 *  decide both keys (see mouseWheelLane in repaint-nudge.ts).
 *  UNWIND(claude-code#83714): lanes bound the paced queue the workaround
 *  introduces; they go when writePaced goes. */
export interface PacedLane {
  /** Pending paced items sharing this key count toward one capped pool. */
  laneKey: string;
  /** Pending paced items with THIS key are removed unwritten the moment an
   *  item in laneKey arrives: a same-axis wheel reversal makes the queued
   *  opposite-direction scroll stale intent. */
  supersedesLaneKey?: string;
}

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
   *  rather than waiting for their microtask.
   *
   *  With a `lane`, the item joins that lane's pending pool: an arrival
   *  finding maxPacedLaneDepth same-lane items already pending is dropped
   *  (same-lane reports are interchangeable scroll intent, and bounded lag
   *  beats full travel on a large flick), and pending items in
   *  lane.supersedesLaneKey are removed unwritten (a same-axis reversal
   *  makes them stale). Laneless items are never counted, capped, or
   *  superseded. */
  writePaced: (data: string, lane?: PacedLane) => void;
}

/** One frame at 60Hz: long enough that the TUI's read loop usually catches
 *  each report individually, short enough that a flick's worth of reports
 *  still lands within a couple hundred milliseconds. */
const MOUSE_REPORT_PACE_MS = 16;

/** Cap on PENDING same-lane paced reports. Bounds the post-flick lag tail
 *  near depth * paceMs (128ms at defaults) while keeping short scrolls
 *  exact: a gesture only loses reports while its lane is saturated. Module
 *  private like MOUSE_REPORT_PACE_MS; tests inject a small cap through the
 *  factory param, and production stays tunable without test churn. */
const MOUSE_WHEEL_LANE_MAX_DEPTH = 8;

interface QueueItem {
  data: string;
  paced: boolean;
  laneKey?: string;
}

export function createWriteBatcher(
  write: (payload: string) => void,
  paceMs: number = MOUSE_REPORT_PACE_MS,
  maxPacedLaneDepth: number = MOUSE_WHEEL_LANE_MAX_DEPTH,
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

  const writePaced = (data: string, lane?: PacedLane): void => {
    // UNWIND(claude-code#83714): the supersede and cap below are part of the
    // same workaround as the pacing itself and go with it. Neither needs
    // drain() changes: a pending paceTimer's deadline is the global pace
    // floor, not a property of the head it was scheduled for, so it validly
    // delivers whatever the head is when it fires.
    if (lane !== undefined) {
      if (lane.supersedesLaneKey !== undefined) {
        const keptItems = queue.filter(
          (item) => !(item.paced && item.laneKey === lane.supersedesLaneKey),
        );
        if (keptItems.length !== queue.length) {
          queue.length = 0;
          queue.push(...keptItems);
        }
      }
      // Within an axis, pending items hold only one direction (each arrival
      // purges its opposite above), so a supersede that actually removed
      // items implies this lane had nothing pending and the cap below
      // cannot also act on the same arrival.
      let pendingSameLaneCount = 0;
      for (const item of queue) {
        if (item.paced && item.laneKey === lane.laneKey) pendingSameLaneCount += 1;
      }
      if (pendingSameLaneCount >= maxPacedLaneDepth) {
        // Drop the INCOMING report, not the oldest: under SUSTAINED
        // saturation both converge on the same write stream (a finite
        // burst differs only in which interchangeable same-lane reports
        // survive, as the cap tests pin), and every drain frees a slot the
        // next fresh-coordinate arrival fills, so a stale-coordinate window
        // self-heals within depth * paceMs. Drop-oldest would add a
        // mid-queue removal path for no observable gain. Still drain,
        // holding the documented "a call drains synchronously" contract.
        drain();
        return;
      }
    }
    queue.push({ data, paced: true, laneKey: lane?.laneKey });
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
