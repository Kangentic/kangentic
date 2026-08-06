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
});
