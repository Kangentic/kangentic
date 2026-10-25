/**
 * When a terminal's agent counts as repainted after its grid changed: 20 ms
 * after its first finished frame (a chunk ending a synchronized update, at least
 * 90 ms after the send), or otherwise a floor past the agent's own frame, then a
 * quiet beat, and a cap, all timed from when the PTY resize was sent. The
 * timings in `terminal-repaint-wait.ts` come from live runs; these replay them,
 * then drive the wait a layout transition holds on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AGENT_FRAME_EARLIEST_MS,
  AGENT_FRAME_SETTLE_MS,
  createTerminalRepaintWait,
  isAgentFinishedFrame,
  msUntilRepaintSettles,
  REPAINT_WAIT_MAX_MS,
  REPAINT_WAIT_MIN_MS,
  REPAINT_WAIT_QUIET_MS,
  REPAINT_WAIT_UNSENT_MS,
} from '../../src/renderer/utils/terminal-repaint-wait';

/** When the wait settles for output arriving at `outputAt` ms after the send. */
function settleTime(outputAt: number[]): number {
  let now = 0;
  let lastOutputAt = 0;
  const pending = [...outputAt];
  for (;;) {
    const wait = msUntilRepaintSettles(now, 0, lastOutputAt);
    const next = pending[0];
    if (next !== undefined && next <= now + wait) {
      now = next;
      lastOutputAt = next;
      pending.shift();
      continue;
    }
    return now + wait;
  }
}

describe('msUntilRepaintSettles', () => {
  it('waits past the agent frame in every measured run, then settles after the quiet beat', () => {
    expect(settleTime([29, 131, 162, 186])).toBe(226);
    expect(settleTime([27, 126, 159, 182, 213])).toBe(253);
    expect(settleTime([26, 41, 181, 212])).toBe(252);
    expect(settleTime([0, 31, 157, 172])).toBe(212);
  });

  it('never settles on the early redraw alone', () => {
    // ConPTY's redraw of the old screen, and then nothing: the floor holds.
    expect(settleTime([27, 41])).toBe(REPAINT_WAIT_MIN_MS);
  });

  it('settles at the floor when no output arrives at all', () => {
    expect(settleTime([])).toBe(REPAINT_WAIT_MIN_MS);
  });

  it('is capped under output that never goes quiet', () => {
    const streaming = Array.from({ length: 40 }, (_, index) => index * (REPAINT_WAIT_QUIET_MS - 10));
    expect(settleTime(streaming)).toBe(REPAINT_WAIT_MAX_MS);
  });

  it('answers 0 once the moment has passed', () => {
    expect(msUntilRepaintSettles(REPAINT_WAIT_MAX_MS + 50, 0, 10)).toBe(0);
  });

  it('settles a beat after the agent\'s first finished frame, whatever the later frames do', () => {
    // A desktop run: ConPTY's marked redraws at 1, 23 and 55 ms, the agent's
    // first frame at 129 ms, then two more with the same text.
    expect(msUntilRepaintSettles(130, 0, 129, 129)).toBe(AGENT_FRAME_SETTLE_MS - 1);
    expect(msUntilRepaintSettles(161, 0, 161, 129)).toBe(0);
  });

  it('still caps a finished frame that lands late', () => {
    expect(msUntilRepaintSettles(REPAINT_WAIT_MAX_MS - 5, 0, REPAINT_WAIT_MAX_MS - 5, REPAINT_WAIT_MAX_MS - 5)).toBe(5);
  });
});

describe('isAgentFinishedFrame', () => {
  const frame = '\x1b[?2026h\x1b[H frame text \x1b[?2026l';

  it('is a chunk that ends a synchronized update at least 90 ms after the send', () => {
    expect(isAgentFinishedFrame(frame, AGENT_FRAME_EARLIEST_MS)).toBe(true);
    expect(isAgentFinishedFrame(frame, 140)).toBe(true);
  });

  it('is not ConPTY\'s marked redraw of the old screen, which comes sooner', () => {
    expect(isAgentFinishedFrame(frame, AGENT_FRAME_EARLIEST_MS - 1)).toBe(false);
    expect(isAgentFinishedFrame(frame, 23)).toBe(false);
  });

  it('is not output that finishes no synchronized update', () => {
    expect(isAgentFinishedFrame('\x1b[H frame text', 140)).toBe(false);
    expect(isAgentFinishedFrame('\x1b[?2026h\x1b[H half a frame', 140)).toBe(false);
  });
});

describe('createTerminalRepaintWait', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Whether `promise` has settled, without waiting on it. */
  async function isSettled(promise: Promise<void>): Promise<boolean> {
    let settled = false;
    void promise.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    return settled;
  }

  it('settles at the floor after the PTY resize when the agent sends nothing', async () => {
    vi.useFakeTimers();
    const wait = createTerminalRepaintWait();
    const repaint = wait.begin();
    wait.notePtyResize();
    await vi.advanceTimersByTimeAsync(REPAINT_WAIT_MIN_MS - 10);
    expect(await isSettled(repaint)).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await isSettled(repaint)).toBe(true);
  });

  it('keeps waiting while the agent is still drawing, then settles a quiet beat after', async () => {
    vi.useFakeTimers();
    const wait = createTerminalRepaintWait();
    const repaint = wait.begin();
    wait.notePtyResize();
    await vi.advanceTimersByTimeAsync(180);
    wait.noteOutput('plain output');
    await vi.advanceTimersByTimeAsync(REPAINT_WAIT_QUIET_MS - 10);
    expect(await isSettled(repaint)).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await isSettled(repaint)).toBe(true);
  });

  it('settles 20 ms after the agent\'s first finished frame, ignoring ConPTY\'s earlier marked redraws', async () => {
    vi.useFakeTimers();
    const wait = createTerminalRepaintWait();
    const repaint = wait.begin();
    wait.notePtyResize();
    const frame = '\x1b[?2026h\x1b[H frame text \x1b[?2026l';
    // ConPTY's redraws of the old screen carry the same markers, but too soon.
    await vi.advanceTimersByTimeAsync(23);
    wait.noteOutput(frame);
    await vi.advanceTimersByTimeAsync(32);
    wait.noteOutput(frame);
    await vi.advanceTimersByTimeAsync(74);
    // 129 ms: the agent's first frame at the new grid.
    wait.noteOutput(frame);
    await vi.advanceTimersByTimeAsync(AGENT_FRAME_SETTLE_MS - 5);
    expect(await isSettled(repaint)).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(await isSettled(repaint)).toBe(true);
  });

  it('a new send forgets a finished frame seen before it', async () => {
    vi.useFakeTimers();
    const wait = createTerminalRepaintWait();
    const repaint = wait.begin();
    wait.notePtyResize();
    await vi.advanceTimersByTimeAsync(100);
    wait.begin();
    wait.notePtyResize();
    await vi.advanceTimersByTimeAsync(5);
    // The frame for the previous grid, landing just after the newer send.
    wait.noteOutput('\x1b[?2026h frame \x1b[?2026l');
    await vi.advanceTimersByTimeAsync(AGENT_FRAME_SETTLE_MS + 20);
    expect(await isSettled(repaint)).toBe(false);
  });

  it('settles on its own when no PTY resize is ever sent', async () => {
    vi.useFakeTimers();
    const wait = createTerminalRepaintWait();
    const repaint = wait.begin();
    await vi.advanceTimersByTimeAsync(REPAINT_WAIT_UNSENT_MS - 10);
    expect(await isSettled(repaint)).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await isSettled(repaint)).toBe(true);
  });

  it('shares one wait across a change\'s refits, timed from the last send', async () => {
    vi.useFakeTimers();
    const wait = createTerminalRepaintWait();
    const first = wait.begin();
    wait.notePtyResize();
    await vi.advanceTimersByTimeAsync(150);
    const second = wait.begin();
    expect(second).toBe(first);
    wait.notePtyResize();
    await vi.advanceTimersByTimeAsync(REPAINT_WAIT_MIN_MS - 10);
    expect(await isSettled(first)).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await isSettled(first)).toBe(true);
  });

  it('settles at once when main keeps another grid, and on dispose', async () => {
    const released = createTerminalRepaintWait();
    const releasedRepaint = released.begin();
    released.release();
    expect(await isSettled(releasedRepaint)).toBe(true);

    const disposed = createTerminalRepaintWait();
    const disposedRepaint = disposed.begin();
    disposed.dispose();
    expect(await isSettled(disposedRepaint)).toBe(true);
  });

  it('ignores output and sends while no wait is open', async () => {
    vi.useFakeTimers();
    const wait = createTerminalRepaintWait();
    wait.notePtyResize();
    wait.noteOutput('plain output');
    const repaint = wait.begin();
    // Opened after the send, so the unsent rule applies, not the floor.
    await vi.advanceTimersByTimeAsync(REPAINT_WAIT_MIN_MS + 50);
    expect(await isSettled(repaint)).toBe(false);
  });
});
