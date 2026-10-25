/**
 * When a terminal's agent has repainted after its grid changed, as a promise a
 * layout transition waits on (`terminal-layout-transition.ts`) before it shows
 * the new layout.
 *
 * Main's repaint settle cannot be the signal: it settles on the first screen
 * clear after the resize, and on Windows that is ConPTY's redraw of the OLD
 * screen, not the agent's frame. Measured on Claude Code 2.1.310 on Windows by
 * resizing a live PTY and timestamping its output, four runs:
 *
 *   grow 120x30 to 200x50     output at 29, 131, 162, 186 ms
 *   shrink 200x50 to 120x30   output at 27, 126, 159, 182, 213 ms
 *   rows 63 to 40             output at 26, 41, 181, 212 ms
 *   rows 40 to 63             output at 0, 31, 157, 172 ms
 *
 * The first burst (under 45 ms) is ConPTY's redraw, and the agent's own frame
 * lands 98 to 181 ms after the resize, with its tail within about 35 ms of it.
 *
 * The agent's first frame is the finished one. Measured again in the desktop app
 * (20 resizes of a task window, same agent): ConPTY's redraws all came within
 * 65 ms of the send, and the agent's first frame at the new grid between 126 and
 * 155 ms, as one chunk holding a whole synchronized update (DEC 2026, begin and
 * end). The markers are most likely ConPTY's, which paints what it forwards as
 * one update: Claude Code skips its own DEC 2026 without an XTVERSION reply
 * (`terminal-query-replies.ts`). One or two more frames followed about 30 ms
 * apart, and with escapes stripped their text was identical to the first. So the
 * wait settles 20 ms after the first chunk that ends a synchronized update at
 * least 90 ms after the send, about 100 ms sooner than waiting the later frames
 * out. The 90 ms keeps ConPTY's redraws of the old screen, which carry the same
 * markers, from counting.
 *
 * Output with no synchronized update (macOS and Linux have no ConPTY), or only
 * before 90 ms, gets the earlier rule: a floor past the latest frame measured, then
 * until the output has been quiet for a beat, timed from the LAST PTY resize
 * sent (`notePtyResize`). Against the four runs above that settles between 212
 * and 253 ms. A slower agent degrades to the new layout showing a beat before
 * its frame, never a wait that hangs: the cap ends it whatever the output does.
 *
 * Nothing here runs outside a transition: a wait opens only when one asks.
 */

import { traceTerminalRenderer } from './terminal-grid-registry';

/** No settling before this long after the PTY resize: past the latest agent frame measured (181 ms). */
export const REPAINT_WAIT_MIN_MS = 190;
/** Then the output must have been quiet this long: longer than the gaps inside the agent's own frame. */
export const REPAINT_WAIT_QUIET_MS = 40;
/** The wait settles by this long after the PTY resize, even under output that never stops. */
export const REPAINT_WAIT_MAX_MS = 500;
/**
 * With no PTY resize sent this long after the wait opened (the grid came back
 * to the PTY's, or main never answered), the wait settles anyway.
 */
export const REPAINT_WAIT_UNSENT_MS = 600;
/** A finished frame this long after the PTY resize is the agent's, not ConPTY's redraw of the old screen. */
export const AGENT_FRAME_EARLIEST_MS = 90;
/** Time for xterm to take in and draw the agent's finished frame. */
export const AGENT_FRAME_SETTLE_MS = 20;
/** The end of a synchronized update (DEC 2026): a frame the agent finished drawing. */
const SYNCHRONIZED_UPDATE_END = '\x1b[?2026l';

/**
 * How long until the agent's frame counts as landed, given when the PTY resize
 * was sent, when the terminal's output last arrived (the send itself when none
 * has), and when the agent's first finished frame arrived, if it has. 0 means now.
 */
export function msUntilRepaintSettles(now: number, sentAt: number, lastOutputAt: number, finishedFrameAt: number | null = null): number {
  const cap = sentAt + REPAINT_WAIT_MAX_MS;
  const ready = finishedFrameAt !== null
    ? finishedFrameAt + AGENT_FRAME_SETTLE_MS
    : Math.max(sentAt + REPAINT_WAIT_MIN_MS, Math.max(lastOutputAt, sentAt) + REPAINT_WAIT_QUIET_MS);
  return Math.max(0, Math.min(ready, cap) - now);
}

/** Whether output arriving `sinceSendMs` after the PTY resize is the agent's finished frame. */
export function isAgentFinishedFrame(data: string, sinceSendMs: number): boolean {
  return sinceSendMs >= AGENT_FRAME_EARLIEST_MS && data.includes(SYNCHRONIZED_UPDATE_END);
}

export interface TerminalRepaintWait {
  /**
   * The grid is about to change: a promise that settles once the agent's frame
   * at the new grid has landed. A call while one is open shares its promise and
   * waits for the newest grid's resize instead.
   */
  begin(): Promise<void>;
  /** The PTY was just asked for a new grid; the agent's repaint is timed from here. */
  notePtyResize(): void;
  /** The terminal's output arrived. A no-op unless a wait is open. */
  noteOutput(data: string): void;
  /** Main kept another grid, so no repaint at this one is coming: settle now. */
  release(): void;
  dispose(): void;
}

export function createTerminalRepaintWait(): TerminalRepaintWait {
  let settleOpen: (() => void) | null = null;
  let openPromise: Promise<void> | null = null;
  let begunAt = 0;
  let sentAt: number | null = null;
  let lastOutputAt = 0;
  let finishedFrameAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  /** Why a wait ended, traced so a slow swap in the field names its cause. */
  const settle = (reason: 'frame' | 'quiet' | 'cap' | 'unsent' | 'released' | 'disposed'): void => {
    clearTimer();
    if (settleOpen) {
      const sentAtSettle = sentAt;
      const frameAt = finishedFrameAt;
      traceTerminalRenderer(null, 'repaint-wait-settled', () => ({
        reason,
        sinceSendMs: sentAtSettle === null ? null : Math.round((frameAt ?? performance.now()) - sentAtSettle),
      }));
    }
    const resolve = settleOpen;
    settleOpen = null;
    openPromise = null;
    sentAt = null;
    finishedFrameAt = null;
    resolve?.();
  };
  const schedule = (): void => {
    clearTimer();
    if (!settleOpen) return;
    const now = performance.now();
    const wait = sentAt === null
      ? begunAt + REPAINT_WAIT_UNSENT_MS - now
      : msUntilRepaintSettles(now, sentAt, lastOutputAt, finishedFrameAt);
    if (wait > 0) {
      timer = setTimeout(schedule, wait);
      return;
    }
    if (sentAt === null) settle('unsent');
    else if (finishedFrameAt !== null) settle('frame');
    else settle(now - sentAt >= REPAINT_WAIT_MAX_MS ? 'cap' : 'quiet');
  };

  return {
    begin() {
      begunAt = performance.now();
      if (!openPromise) {
        openPromise = new Promise<void>((resolve) => { settleOpen = resolve; });
        lastOutputAt = begunAt;
      }
      // The newest grid's resize starts the clock again.
      sentAt = null;
      finishedFrameAt = null;
      const promise = openPromise;
      schedule();
      return promise;
    },
    notePtyResize() {
      if (!settleOpen) return;
      sentAt = performance.now();
      // Output from before the send is the old frame's, not the repaint's.
      lastOutputAt = sentAt;
      finishedFrameAt = null;
      schedule();
    },
    noteOutput(data) {
      if (!settleOpen) return;
      const now = performance.now();
      lastOutputAt = now;
      if (sentAt !== null && finishedFrameAt === null && isAgentFinishedFrame(data, now - sentAt)) {
        finishedFrameAt = now;
        schedule();
      }
    },
    release() {
      settle('released');
    },
    dispose() {
      settle('disposed');
    },
  };
}
