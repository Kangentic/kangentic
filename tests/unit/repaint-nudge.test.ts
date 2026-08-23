/**
 * Unit tests for `src/renderer/utils/repaint-nudge.ts`.
 *
 * The nudge exists because a fullscreen agent TUI intermittently emits an
 * incomplete frame after a scroll, and the only thing that repairs it is asking
 * for another frame. Its whole design claim is that it decides WITHOUT looking
 * at the grid: it fires on the trigger (input, then output, then quiet) and uses
 * the before/after comparison only to report what it found. So these assertions
 * are about the trigger and the gates, plus one that pins the reporting split.
 *
 * Fake timers throughout: the behavior under test IS the quiesce window, and a
 * real-timer version would either be slow or race under CI load.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createRepaintNudge,
  shouldSendRepaintNudge,
  diffViewportRows,
  isUserInputData,
  isMouseReport,
  REPAINT_NUDGE_BYTES,
  type RepaintNudgeGate,
} from '../../src/renderer/utils/repaint-nudge';

const OPEN_GATE: RepaintNudgeGate = {
  altScreen: true,
  focusReportingEnabled: true,
  parked: false,
  replayPending: false,
};

const QUIESCE_MS = 100;
const MIN_INTERVAL_MS = 500;

interface Harness {
  send: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof vi.fn>;
  controller: ReturnType<typeof createRepaintNudge>;
  setGate: (gate: Partial<RepaintNudgeGate>) => void;
  setViewport: (rows: string[] | null) => void;
}

function createHarness(): Harness {
  let gate: RepaintNudgeGate = { ...OPEN_GATE };
  let viewport: string[] | null = ['row-a', 'row-b'];
  const send = vi.fn();
  const trace = vi.fn();
  const controller = createRepaintNudge({
    readGate: () => gate,
    snapshotViewport: () => viewport,
    send,
    trace,
    quiesceMs: QUIESCE_MS,
    minIntervalMs: MIN_INTERVAL_MS,
    now: () => Date.now(),
  });
  return {
    send,
    trace,
    controller,
    setGate: (next) => { gate = { ...gate, ...next }; },
    setViewport: (rows) => { viewport = rows; },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shouldSendRepaintNudge', () => {
  it('opens only when every condition holds', () => {
    expect(shouldSendRepaintNudge(OPEN_GATE)).toBe(true);
  });

  it.each([
    ['a normal-buffer session', { altScreen: false }],
    ['a TUI that never enabled focus reporting', { focusReportingEnabled: false }],
    ['a parked terminal that is discarding bytes', { parked: true }],
    ['a replay that is already repainting the grid', { replayPending: true }],
  ])('stays closed for %s', (_label, override) => {
    expect(shouldSendRepaintNudge({ ...OPEN_GATE, ...override })).toBe(false);
  });
});

describe('diffViewportRows', () => {
  it('reports the differing row indices', () => {
    expect(diffViewportRows(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([1]);
    expect(diffViewportRows(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('treats a missing row as an empty one, so a shorter grid still diffs', () => {
    expect(diffViewportRows(['a', 'b'], ['a'])).toEqual([1]);
  });
});

describe('isUserInputData', () => {
  // A replay re-asserts DECSET 1004 and useTerminal focuses the terminal right after, so
  // xterm answers with its own \x1b[O\x1b[I through the same onData channel the fix has to
  // filter. This is the regression the whole predicate exists to close: without it, every
  // mount self-arms a nudge with no user present.
  //
  // The X10 mouse reports below encode button state in a single byte, offset by 32, so the
  // literal bytes are computed instead of hand-typed as unprintable characters.
  const x10MotionByte = String.fromCharCode(32 + 35, 40, 40);
  const x10ClickByte = String.fromCharCode(32 + 0, 40, 40);

  it.each([
    ['a FocusIn report - the self-arming-loop case', '\x1b[I', false],
    ['a FocusOut report - the self-arming-loop case', '\x1b[O', false],
    ['SGR pure motion, buttonByte=35 (32 motion bit + 3, no button)', '\x1b[<35;10;5M', false],
    ['SGR drag, buttonByte=32 (32 motion bit + button 0)', '\x1b[<32;10;5M', false],
    ['SGR left-click press, buttonByte=0', '\x1b[<0;10;5M', true],
    ['SGR left-click release, buttonByte=0 (lowercase m)', '\x1b[<0;10;5m', true],
    ['SGR wheel up, buttonByte=64 (no motion bit)', '\x1b[<64;10;5M', true],
    ['SGR wheel down, buttonByte=65 (no motion bit)', '\x1b[<65;10;5M', true],
    ['X10 mouse motion', '\x1b[M' + x10MotionByte, false],
    ['X10 mouse click', '\x1b[M' + x10ClickByte, true],
    // X10_MOUSE_REPORT_PATTERN is anchored at both ends (this diff), matching
    // SGR_MOUSE_REPORT_PATTERN's pre-existing anchoring. A payload this
    // predicate cannot resolve to one clean report - trailing bytes, or two
    // reports joined by a coalesced onData burst - falls through to `true`
    // the same way an unparseable SGR payload already does: conservatively
    // treat it as real input rather than risk silently swallowing a genuine
    // keystroke riding alongside the reports. Pinned here so a future change
    // to the shared pattern cannot silently flip this fallback without a
    // failing test - `isMouseReport`'s own tests only prove these payloads
    // are NOT a single clean report, not what isUserInputData does with them.
    ['an X10 report with trailing bytes - falls through to true (unparseable as one report)', '\x1b[M' + x10MotionByte + 'hello', true],
    ['two X10 reports joined into one chunk - same fallback as above', '\x1b[M' + x10MotionByte + '\x1b[M' + x10MotionByte, true],
    ['an ordinary typed character', 'a', true],
    ['a carriage return (Enter)', '\r', true],
    ['Ctrl+C', '\x03', true],
    ['an arrow-up escape sequence', '\x1b[A', true],
    ['a multi-character paste', 'hello world, this got pasted', true],
    [
      'SS3 F1 (\\x1bOP) - shaped like a focus report but is not one, the regression guard for an over-eager pattern',
      '\x1bOP',
      true,
    ],
    // Ctrl+End / Ctrl+Home are the CONFIRMED repro for the missing-rows defect this whole
    // nudge mechanism exists to repair (see docs on the false-idle/black-screen investigation).
    // If the filter ever started treating them as non-user input, the nudge would silently stop
    // firing for its primary case while every other test here stayed green - pin them
    // explicitly rather than trusting the generic arrow-key case to stand in for them.
    ['Ctrl+End', '\x1b[1;5F', true],
    ['Ctrl+Home', '\x1b[1;5H', true],
    // Keyboard paging is the same interaction class as Ctrl+End/Home.
    ['Page Down', '\x1b[6~', true],
    ['Page Up', '\x1b[5~', true],
  ])('%s', (_label, data, expected) => {
    expect(isUserInputData(data as string)).toBe(expected as boolean);
  });
});

describe('isMouseReport', () => {
  // The input path routes every mouse report through the write batcher's paced
  // path so each one reaches the PTY as its own chunk - coalesced reports
  // become one multi-line jump whose differential frame intermittently
  // mis-assembles upstream. Motion and wheel are deliberately INCLUDED here
  // (unlike isUserInputData, which is an arming policy): chunk isolation is
  // about encoding, not intent. And ONLY a single complete report classifies:
  // a payload that merely starts with one (trailing bytes, two reports
  // joined) would ride the paced path as one unsplit chunk, recreating the
  // exact coalesced jump writePaced exists to prevent.
  const x10MotionReportBytes = String.fromCharCode(32 + 35, 40, 40);
  const x10ClickReportBytes = String.fromCharCode(32 + 0, 40, 40);

  it.each([
    ['SGR wheel up', '\x1b[<64;10;5M', true],
    ['SGR wheel down', '\x1b[<65;10;5M', true],
    ['SGR click press', '\x1b[<0;10;5M', true],
    ['SGR click release (lowercase m)', '\x1b[<0;10;5m', true],
    ['SGR motion', '\x1b[<35;10;5M', true],
    ['X10 mouse motion', '\x1b[M' + x10MotionReportBytes, true],
    ['X10 mouse click', '\x1b[M' + x10ClickReportBytes, true],
    ['an SGR report with trailing bytes', '\x1b[<64;10;5Mhello', false],
    ['an X10 report with trailing bytes', '\x1b[M' + x10MotionReportBytes + 'hello', false],
    ['two SGR reports joined into one chunk', '\x1b[<64;10;5M\x1b[<65;10;5M', false],
    [
      'two X10 reports joined into one chunk',
      '\x1b[M' + x10MotionReportBytes + '\x1b[M' + x10MotionReportBytes,
      false,
    ],
    ['a FocusIn report (not a mouse report)', '\x1b[I', false],
    ['an ordinary typed character', 'a', false],
    ['a carriage return', '\r', false],
    ['an arrow-key sequence', '\x1b[A', false],
    ['a multi-character paste', 'hello world', false],
  ])('%s', (_label, data, expected) => {
    expect(isMouseReport(data as string)).toBe(expected as boolean);
  });
});

describe('isUserInputData wired into createRepaintNudge', () => {
  // This does not execute useTerminal.ts - it pins the semantics the call site
  // (`if (isUserInputData(data)) repaintNudgeRef.current?.noteInput();`) must preserve, using
  // the same createHarness() shape as the rest of this file.
  const deliverToTerminal = (harness: Harness, data: string): void => {
    if (isUserInputData(data)) harness.controller.noteInput();
  };

  it('a stream of focus reports and mouse motion, even with real output between them, arms nothing', () => {
    const harness = createHarness();

    deliverToTerminal(harness, '\x1b[O');
    deliverToTerminal(harness, '\x1b[I');
    harness.controller.noteOutput();
    deliverToTerminal(harness, '\x1b[<35;10;5M');
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS * 4);

    expect(harness.send).not.toHaveBeenCalled();
  });

  it('a real keystroke in the same stream still arms and fires', () => {
    const harness = createHarness();

    deliverToTerminal(harness, '\x1b[O');
    deliverToTerminal(harness, 'a');
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);

    expect(harness.send).toHaveBeenCalledTimes(1);
  });
});

describe('createRepaintNudge', () => {
  it('nudges once after input, output, and a quiet window', () => {
    const harness = createHarness();

    harness.controller.noteInput();
    harness.controller.noteOutput();
    expect(harness.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(QUIESCE_MS);
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith(REPAINT_NUDGE_BYTES);
  });

  it('never nudges mid-stream: continuing output keeps deferring the window', () => {
    const harness = createHarness();
    harness.controller.noteInput();

    for (let chunk = 0; chunk < 10; chunk++) {
      harness.controller.noteOutput();
      vi.advanceTimersByTime(QUIESCE_MS - 1);
    }
    expect(harness.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('does not nudge when input produced no output at all', () => {
    // A swallowed keystroke, or input to a session that is not rendering. There
    // is no frame to be suspicious of, so there is nothing to repair.
    const harness = createHarness();
    harness.controller.noteInput();

    vi.advanceTimersByTime(QUIESCE_MS * 4);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('does not nudge on output alone, with no preceding input', () => {
    const harness = createHarness();
    harness.controller.noteOutput();

    vi.advanceTimersByTime(QUIESCE_MS * 4);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it.each([
    ['not in the alt screen', { altScreen: false }],
    ['focus reporting off', { focusReportingEnabled: false }],
    ['parked', { parked: true }],
    ['a replay in flight', { replayPending: true }],
  ])('sends nothing when the session is %s', (_label, override) => {
    const harness = createHarness();
    harness.setGate(override);

    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);

    expect(harness.send).not.toHaveBeenCalled();
  });

  it('rate-limits, so holding a scroll key costs a bounded number of renders', () => {
    const harness = createHarness();

    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);
    expect(harness.send).toHaveBeenCalledTimes(1);

    // Settle the verify phase, then interact again inside the floor.
    vi.advanceTimersByTime(QUIESCE_MS);
    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);
    expect(harness.send).toHaveBeenCalledTimes(1);

    // Past the floor, it arms again.
    vi.advanceTimersByTime(MIN_INTERVAL_MS);
    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);
    expect(harness.send).toHaveBeenCalledTimes(2);
  });

  it('reports a repair when the nudge changed the grid', () => {
    const harness = createHarness();
    harness.setViewport(['before', 'shared']);

    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);

    // The nudge's own frame lands, then the stream quiesces again.
    harness.setViewport(['after', 'shared']);
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);

    expect(harness.trace).toHaveBeenCalledTimes(1);
    const [event, detail] = harness.trace.mock.calls[0];
    expect(event).toBe('repaint-repaired');
    expect(detail()).toEqual({ changedRows: 1, firstChangedRow: 0 });
  });

  it('reports a clean verify when the frame was already correct', () => {
    const harness = createHarness();

    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);

    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);

    expect(harness.trace).toHaveBeenCalledWith('repaint-verified', expect.any(Function));
  });

  it('still nudges when the comparison is unavailable', () => {
    // Production returns null from snapshotViewport: the reporting is dev-only,
    // the repair is not. This is the assertion that keeps the comparison from
    // becoming load-bearing.
    const harness = createHarness();
    harness.setViewport(null);

    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);

    expect(harness.send).toHaveBeenCalledTimes(1);

    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);
    expect(harness.trace).not.toHaveBeenCalled();
  });

  it('settles the verify phase even when the TUI answers with nothing', () => {
    const harness = createHarness();

    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);
    expect(harness.send).toHaveBeenCalledTimes(1);

    // No output follows the nudge at all. The phase must not stay stuck, or the
    // session would never nudge again.
    vi.advanceTimersByTime(QUIESCE_MS + MIN_INTERVAL_MS);
    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);
    expect(harness.send).toHaveBeenCalledTimes(2);
  });

  it('dispose cancels a pending nudge', () => {
    const harness = createHarness();

    harness.controller.noteInput();
    harness.controller.noteOutput();
    harness.controller.dispose();

    vi.advanceTimersByTime(QUIESCE_MS * 4);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('reads the gate at fire time, not at arm time', () => {
    // Differs from the "sends nothing when the session is %s" cases above: those close the
    // gate BEFORE arming. This closes it AFTER arming but before the quiesce window elapses,
    // so it only passes if the gate is re-read inside onQuiesced rather than captured back
    // when noteInput/noteOutput ran.
    const harness = createHarness();

    harness.controller.noteInput();
    harness.controller.noteOutput();
    harness.setGate({ parked: true });
    vi.advanceTimersByTime(QUIESCE_MS);

    expect(harness.send).not.toHaveBeenCalled();
  });

  it('ignores noteInput fired mid-verify, so a keystroke landing during the nudge cannot re-arm it', () => {
    // If the phase==='verifying' guard is dropped, this mid-verify noteInput reassigns phase to
    // 'armed' and reschedules the timer, so the verify comparison never runs at its original
    // deadline. The send count alone stays 1 either way, so `trace` (not `send`) is the
    // assertion that actually discriminates correct from broken here.
    const harness = createHarness();

    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);
    expect(harness.send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(QUIESCE_MS / 2);
    harness.controller.noteInput();
    vi.advanceTimersByTime(QUIESCE_MS / 2);

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.trace).toHaveBeenCalledTimes(1);
    expect(harness.trace).toHaveBeenCalledWith('repaint-verified', expect.any(Function));
  });

  it('dispose during the verify phase cancels the comparison outright', () => {
    // The nudge already sent once here, so `send` staying at 1 (not 0) is what keeps this from
    // collapsing into the "dispose cancels a pending nudge" test above, which disposes before
    // anything ever fires. `trace` never firing is the assertion that pins the cancellation.
    const harness = createHarness();

    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);
    expect(harness.send).toHaveBeenCalledTimes(1);

    harness.controller.dispose();
    vi.advanceTimersByTime(QUIESCE_MS + MIN_INTERVAL_MS);

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.trace).not.toHaveBeenCalled();
  });

  it('allows a new nudge at exactly minIntervalMs since the last one (the boundary is inclusive)', () => {
    // The source condition is `firedAt - lastNudgeAt < minIntervalMs`, so a delta EQUAL to the
    // floor must still be allowed. This is the test that would go red if `<` became `<=`.
    const harness = createHarness();

    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);
    expect(harness.send).toHaveBeenCalledTimes(1);

    // Settle the verify phase, then land the next interaction so its fire time lands EXACTLY
    // MIN_INTERVAL_MS after the first nudge fired.
    vi.advanceTimersByTime(QUIESCE_MS);
    vi.advanceTimersByTime(MIN_INTERVAL_MS - 2 * QUIESCE_MS);
    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);

    expect(harness.send).toHaveBeenCalledTimes(2);
  });

  it('blocks a new nudge one millisecond short of minIntervalMs', () => {
    // The companion to the boundary test above: without both directions, a `<` -> `<=` flip in
    // either direction could still slip past just one of them.
    const harness = createHarness();

    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);
    expect(harness.send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(QUIESCE_MS);
    vi.advanceTimersByTime(MIN_INTERVAL_MS - 2 * QUIESCE_MS - 1);
    harness.controller.noteInput();
    harness.controller.noteOutput();
    vi.advanceTimersByTime(QUIESCE_MS);

    expect(harness.send).toHaveBeenCalledTimes(1);
  });
});
