import { describe, it, expect, vi } from 'vitest';
import { PtyBufferManager } from '../../src/main/pty/buffer/pty-buffer-manager';

/**
 * Harness for the open-a-task-detail flicker: black -> WRONG frame -> right frame.
 *
 * The pipeline on a handoff from the bottom panel to a detail window is:
 *
 *   1. renderer fits the new container      -> window cols (narrower than the panel)
 *   2. `sessions.resize(windowCols)`        -> SIGWINCH; the agent will repaint, async
 *   3. `getScrollback()` in parallel        -> awaits waitForResizeRepaint, then samples
 *   4. replay written into the fresh xterm  -> THE FIRST THING THE USER SEES
 *   5. live bytes were HELD during 3-4 (`shouldHold: scrollbackPendingRef`) and are
 *      flushed by `queue.kick()` at the end of `afterWrite`
 *
 * So whatever step 3 samples is the frame the user sees first, and anything the
 * agent sent that step 3 missed arrives at step 5 as a visible correction. If the
 * settle in step 3 returns before the repaint lands, the user necessarily sees the
 * pre-resize frame (drawn wide, wrapped into a narrow terminal) and then watches it
 * be replaced. That is exactly the reported sequence.
 *
 * The settle's early-exit marker is the suspect: it accepts a BARE `\x1b[H`
 * (cursor-home) as evidence of a full-frame repaint. Cursor-home is not that. A
 * fullscreen TUI emits it for ordinary partial updates - a spinner tick, redrawing
 * one line - so the very first routine update after the resize satisfies the
 * settle. Measured on a live Claude session: 169 cursor-homes vs 56 full-screen
 * clears in one 512KB ring, so the poison marker outnumbers the real one 3:1.
 *
 * This harness reproduces the race deterministically: a routine cursor-home lands
 * immediately after the resize, the genuine repaint lands later. A correct settle
 * waits for the repaint; the buggy one samples the stale frame in between.
 */

const SESSION = 'flicker-harness';

/** Panel width before the handoff, window width after. Real values from a 2560px
 *  screen: the bottom panel spans the full width, a detail window ~58% of it. */
const PANEL_COLS = 213;
const WINDOW_COLS = 146;

/** A full-screen clear. What a fullscreen TUI actually emits when it redraws. */
const CLEAR = '\x1b[2J';
/** Cursor-home with no erase. A partial-update primitive, NOT a repaint. */
const CURSOR_HOME = '\x1b[H';

/** A frame laid out for `cols`, tagged so a sample can be attributed to a width. */
function frameAtWidth(cols: number, tag: string): string {
  return `${CLEAR}\x1b[1;1H${tag} ${'x'.repeat(cols - tag.length - 2)}`;
}

const STALE_FRAME = frameAtWidth(PANEL_COLS, 'DRAWN-AT-PANEL-WIDTH');
const REPAINT_FRAME = frameAtWidth(WINDOW_COLS, 'DRAWN-AT-WINDOW-WIDTH');

function createManager() {
  const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
  manager.initSession(SESSION, '', PANEL_COLS);
  manager.onResize(SESSION, PANEL_COLS);
  return manager;
}

describe('repaint settle: what the user sees first on a panel -> window handoff', () => {
  it('waits for the real repaint even when a routine cursor-home lands first', async () => {
    const manager = createManager();

    // The session has been running at the panel width and has drawn a frame there.
    manager.onData(SESSION, STALE_FRAME);

    // The handoff: the renderer fits the window and resizes the PTY.
    expect(manager.onResize(SESSION, WINDOW_COLS)).toBe(true);

    // The agent's FIRST byte after the resize is a routine partial update, not the
    // repaint. This is the ordinary case, not a contrived one: a spinner ticks
    // every ~100ms and the resize lands whenever the user clicks.
    manager.onData(SESSION, CURSOR_HOME);

    const settle = manager.waitForResizeRepaint(SESSION);

    // The genuine SIGWINCH repaint arrives later, as it always does - the agent
    // has to be scheduled, re-measure, and redraw.
    const repaintTimer = setTimeout(() => manager.onData(SESSION, REPAINT_FRAME), 100);

    await settle;
    const sample = manager.getScrollback(SESSION);
    clearTimeout(repaintTimer);

    // The load-bearing assertion: the frame the user sees first must be the one
    // drawn for the window they just opened. Sampling on the cursor-home returns
    // the panel-width frame, which xterm then wraps into the narrower window -
    // the mid-word wrapping and clipped right edge in the bug report.
    expect(
      sample,
      'getScrollback settled before the repaint and sampled the pre-resize frame. '
      + 'The user sees this stale frame first, then watches the held live bytes '
      + 'replace it.',
    ).toContain('DRAWN-AT-WINDOW-WIDTH');
  });

  it('still settles promptly on a genuine full-frame repaint', async () => {
    // The accelerator must survive the fix: a real repaint marker settles the wait
    // immediately rather than burning the quiesce or the deadline.
    const manager = createManager();
    manager.onData(SESSION, STALE_FRAME);
    manager.onResize(SESSION, WINDOW_COLS);
    manager.onData(SESSION, REPAINT_FRAME);

    const startedAt = Date.now();
    await manager.waitForResizeRepaint(SESSION);
    const waited = Date.now() - startedAt;

    expect(manager.getScrollback(SESSION)).toContain('DRAWN-AT-WINDOW-WIDTH');
    // Generous bound: the point is "did not fall through to the 400ms deadline",
    // not a precise latency (CI timing varies).
    expect(waited).toBeLessThan(200);
  });

  it('waits for the repaint on a ROWS-only handoff (bottom-panel height vs detail-window height)', async () => {
    // Same pipeline, vertical axis: the PTY has been running at the bottom
    // panel's short height, and the detail window fits the same width but many
    // more rows. Measured live (2026-07-31, 12/12 trials): the unarmed settle
    // sampled the old-row-count frame ~1ms after the resize every time, and the
    // rows repaint always arrived 21-122ms later carrying a full \x1b[2J erase.
    const PANEL_ROWS = 10;
    const WINDOW_ROWS = 34;
    const frameAtRows = (rows: number, tag: string): string => `${CLEAR}\x1b[${rows};1H${tag}`;

    const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
    manager.initSession(SESSION, '', PANEL_COLS, PANEL_ROWS);
    manager.onResize(SESSION, PANEL_COLS, PANEL_ROWS);
    manager.onData(SESSION, frameAtRows(PANEL_ROWS, 'DRAWN-AT-PANEL-HEIGHT'));

    // The handoff: same width, new height. The report stays colsChanged=false;
    // the settle arms anyway.
    expect(manager.onResize(SESSION, PANEL_COLS, WINDOW_ROWS)).toBe(false);

    // A routine partial update lands first, then the genuine rows repaint.
    manager.onData(SESSION, CURSOR_HOME);
    const settle = manager.waitForResizeRepaint(SESSION);
    const repaintTimer = setTimeout(
      () => manager.onData(SESSION, frameAtRows(WINDOW_ROWS, 'DRAWN-AT-WINDOW-HEIGHT')),
      100,
    );

    const startedAt = Date.now();
    await settle;
    const waited = Date.now() - startedAt;
    const sample = manager.getScrollback(SESSION);
    clearTimeout(repaintTimer);

    expect(
      sample,
      'getScrollback settled before the rows repaint and sampled the frame laid '
      + 'out for the old row count - the input box lands mid-screen until the '
      + 'held live bytes correct it.',
    ).toContain('DRAWN-AT-WINDOW-HEIGHT');
    // Generous bound (CI timing varies): the marker settles the wait, it must
    // not ride the 400ms deadline.
    expect(waited).toBeLessThan(300);
  });

  /**
   * The MOUNT-time gap in the no-marker early exit: "no full-screen erase
   * anywhere in the ring" was read as "not a fullscreen TUI, nothing to wait
   * for" - but a TUI that has not yet drawn its FIRST frame has no marker
   * either. Sampling instantly there replayed a near-empty ring (observed
   * live: a 237-byte replay where a settled mount replays hundreds of KB),
   * and with the resting park live, every reopen is a geometry-changing
   * mount that crosses exactly this path.
   */
  it('waits for a starting TUI\'s FIRST frame even though the ring has no marker yet', async () => {
    const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
    manager.initSession(SESSION, '', PANEL_COLS);
    manager.onResize(SESSION, PANEL_COLS);
    // The agent's pre-frame chatter: no full-screen erase anywhere yet.
    manager.onData(SESSION, 'spawning agent...\r\n');

    // The mount fit resizes the PTY before the TUI has drawn once.
    manager.onResize(SESSION, WINDOW_COLS);
    const settle = manager.waitForResizeRepaint(SESSION);
    // The first frame is already in flight and lands moments later. (A first
    // frame that only STARTS after the ring has been silent past the grace
    // is deliberately out of scope: the launch overlay covers agent startup,
    // and the frame still paints through the live-byte path.)
    const firstFrameTimer = setTimeout(() => manager.onData(SESSION, REPAINT_FRAME), 20);

    await settle;
    const sample = manager.getScrollback(SESSION);
    clearTimeout(firstFrameTimer);

    expect(
      sample,
      'the settle sampled a near-empty ring instead of waiting for the first frame',
    ).toContain('DRAWN-AT-WINDOW-WIDTH');
  });

  it('settles a silent shell fast - far below the TUI deadline', async () => {
    // The common no-marker case really is a plain shell, and a shell answers
    // SIGWINCH with nothing. Waiting the TUI's full deadline there would slow
    // every Command Terminal open; the no-marker wait must stay short.
    const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
    manager.initSession(SESSION, '', PANEL_COLS);
    manager.onResize(SESSION, PANEL_COLS);
    manager.onData(SESSION, 'PS C:\\dev> ');
    manager.onResize(SESSION, WINDOW_COLS);

    const startedAt = Date.now();
    await manager.waitForResizeRepaint(SESSION);
    const waited = Date.now() - startedAt;

    // Generous bound (CI timing varies): the point is "a fraction of the
    // 400ms TUI deadline", not a precise latency.
    expect(waited).toBeLessThan(250);
  });

  it('samples a marker-less redraw on its quiesce instead of instantly', async () => {
    // A shell that DOES answer the resize (prompt redraw, no erase): the
    // sample should include those bytes, keyed on the output going quiet.
    const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
    manager.initSession(SESSION, '', PANEL_COLS);
    manager.onResize(SESSION, PANEL_COLS);
    manager.onData(SESSION, 'PS C:\\dev> ');

    manager.onResize(SESSION, WINDOW_COLS);
    const settle = manager.waitForResizeRepaint(SESSION);
    const redrawTimer = setTimeout(() => manager.onData(SESSION, 'REDRAWN-PROMPT> '), 30);

    await settle;
    const sample = manager.getScrollback(SESSION);
    clearTimeout(redrawTimer);

    expect(sample).toContain('REDRAWN-PROMPT>');
  });

  it('is bounded by the deadline when the repaint never comes', async () => {
    // A TUI that never re-erases has no trustworthy signal, so the wait rides its
    // deadline rather than settling on an ordinary partial update. This is the
    // deliberate trade the fix makes: bounded latency in the rare no-repaint case,
    // instead of a wrong frame shown on every handoff. The bound is what matters -
    // a missing repaint must never hang the read.
    const manager = createManager();
    manager.onData(SESSION, STALE_FRAME);
    manager.onResize(SESSION, WINDOW_COLS);
    manager.onData(SESSION, 'partial redraw with no clear');

    const startedAt = Date.now();
    await manager.waitForResizeRepaint(SESSION);
    const waited = Date.now() - startedAt;

    // Generous upper bound (CI timing varies); the assertion is "bounded", not
    // a precise latency.
    expect(waited).toBeGreaterThanOrEqual(300);
    expect(waited).toBeLessThan(1500);
  });
});

/**
 * Two surfaces routinely sample ONE session for ONE resize: a bottom-panel tab
 * and a detail window overlap during a handover, and in dev StrictMode mounts
 * every terminal twice. Both call getScrollback, so both await the same
 * repaint.
 *
 * Before the fix they raced, and the loser was guaranteed to burn the full
 * REPAINT_MAX_WAIT_MS: whichever settled first called clearPendingRepaint,
 * which nulls pendingRepaintScrollbackLength - the scan offset the early-settle
 * predicate re-reads on every poll and requires to be non-null. With it gone
 * the second wait could never settle early, only ride the deadline out.
 *
 * Live evidence: in one 600-event trace ring, 24 of 24 `deadline` settles were
 * preceded by a `marker` settle for the same resize, and every one turned a
 * ~75ms task-detail open into a ~430ms one. That stall is the reported
 * "noticeable lag" / "cold start" on opening a task whose agent is long since
 * running.
 */
describe('repaint settle: concurrent samplers of one resize', () => {
  it('a second sampler joins the wait in flight instead of burning the deadline', async () => {
    const manager = createManager();
    manager.onData(SESSION, STALE_FRAME);
    manager.onResize(SESSION, WINDOW_COLS);

    // The second sampler enters while the first is still polling.
    const startedAt = Date.now();
    const firstSettled = manager.waitForResizeRepaint(SESSION).then(() => Date.now() - startedAt);
    const secondSampled = manager
      .waitForResizeRepaint(SESSION)
      .then(() => ({ waited: Date.now() - startedAt, sample: manager.getScrollback(SESSION) }));

    // The genuine repaint lands, as it does on a real SIGWINCH.
    const repaintTimer = setTimeout(() => manager.onData(SESSION, REPAINT_FRAME), 30);
    const [firstWaited, second] = await Promise.all([firstSettled, secondSampled]);
    clearTimeout(repaintTimer);

    // BOTH halves matter. Latency alone would also pass for a fix that
    // short-circuits before the repaint, which is the stale-frame bug the
    // first suite in this file exists to prevent - so the joining sampler must
    // still replay the frame drawn at the width it is about to render at.
    expect(
      second.sample,
      'the joining sampler settled before the repaint and would replay a stale-width frame',
    ).toContain('DRAWN-AT-WINDOW-WIDTH');
    // Generous bound (CI timing varies): the point is "did not fall through to
    // the 400ms deadline". Without the join it is deterministically ~415ms.
    expect(
      second.waited,
      'the second sampler took its own wait and rode the deadline out',
    ).toBeLessThan(300);
    expect(firstWaited).toBeLessThan(300);
  });

  it('a later resize gets its own wait rather than inheriting the settled one', async () => {
    // The ping-pong from the live trace: the PTY flips between the bottom
    // panel's width and the detail window's on every open/close. Retracting a
    // resolved settle is what keeps each flip honest - a lingering entry would
    // let the next resize join an answer computed for the PREVIOUS width, which
    // is the stale-frame bug wearing the fix as a disguise.
    const manager = createManager();
    manager.onData(SESSION, STALE_FRAME);

    manager.onResize(SESSION, WINDOW_COLS);
    const windowWait = manager.waitForResizeRepaint(SESSION);
    manager.onData(SESSION, REPAINT_FRAME);
    await windowWait;
    expect(manager.getScrollback(SESSION)).toContain('DRAWN-AT-WINDOW-WIDTH');

    // Close the detail: the panel reclaims the PTY at its own width.
    const reclaimedFrame = frameAtWidth(PANEL_COLS, 'REDRAWN-AT-PANEL-WIDTH');
    manager.onResize(SESSION, PANEL_COLS);
    const panelWait = manager.waitForResizeRepaint(SESSION);
    const repaintTimer = setTimeout(() => manager.onData(SESSION, reclaimedFrame), 30);
    await panelWait;
    clearTimeout(repaintTimer);

    expect(
      manager.getScrollback(SESSION),
      'the second resize reused the first resize\'s settle and sampled its frame',
    ).toContain('REDRAWN-AT-PANEL-WIDTH');
  });
});
