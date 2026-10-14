/**
 * The composed-width sample after a PTY resize
 * (src/devtools/main/composed-width-sampler.ts).
 *
 * The failing layer in a stuck pair of task windows was the agent itself: it
 * painted full-width rows for the bottom panel's 306 columns inside a
 * 210-column window while main's last applied grid was the window's. Every
 * persisted Kangentic layer agreed, so only a sample of the width the agent
 * composes at can name that layer. These pin that the sample is taken after
 * each resize burst, carries all three grids, and reads the mismatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createComposedWidthSampler,
  COMPOSED_SAMPLE_DELAY_MS,
  type ComposedSampleDimensions,
  type ComposedSampleSource,
} from '../../src/devtools/main/composed-width-sampler';
import type { TerminalTraceEvent } from '../../src/main/pty/terminal-trace';
import { TUI_SETUP, DEFECTIVE_JUMP_FRAME } from '../fixtures/claude-code-frames';

const ALT = '\x1b[?1049h';

/** Full-width rows at the panel's 306 columns, relying on autowrap, as the
 *  agent drew them inside the 210-column window. */
const PANEL_WIDTH_FRAME = ALT + ('─'.repeat(306) + '\r\n' + ' '.repeat(306) + '\r\n').repeat(3);

function resizeEntry(sessionId: string): TerminalTraceEvent {
  return {
    ts: Date.now(),
    source: 'main',
    process: 'pty-host',
    sessionId,
    event: 'pty-resize',
    detail: { fromCols: 306, toCols: 210, fromRows: 19, toRows: 48 },
  };
}

function windowDimensions(overrides: Partial<ComposedSampleDimensions> = {}): ComposedSampleDimensions {
  return {
    sessionId: 'session-window',
    ptyCols: 210,
    ptyRows: 48,
    lastCols: 210,
    lastRows: 48,
    inAltScreen: true,
    ...overrides,
  };
}

function fakeSource(dimensions: ComposedSampleDimensions, rawScrollback: string): ComposedSampleSource & {
  rawReads: number;
} {
  const source = {
    rawReads: 0,
    getTerminalDimensions: async () => [dimensions],
    getRawScrollback: async () => {
      source.rawReads += 1;
      return rawScrollback;
    },
  };
  return source;
}

describe('composed-width sampler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records an agent composing at the panel width inside a window grid as a mismatch', async () => {
    const record = vi.fn();
    const source = fakeSource(windowDimensions(), PANEL_WIDTH_FRAME);
    const sampler = createComposedWidthSampler({ getSource: () => source, record });

    sampler.listener(resizeEntry('session-window'));
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('session-window', 'composed-sample', expect.objectContaining({
      ptyCols: 210,
      ptyRows: 48,
      hostCols: 210,
      hostRows: 48,
      matchesPty: false,
    }));
    // All-306 evidence is tied between 306 and its half; the reference grid
    // picks the half. The width disagrees with the grid either way, and that
    // disagreement is the reading.
    const detail = record.mock.calls[0][2] as { composedCols: number };
    expect(306 % detail.composedCols).toBe(0);
    expect(detail.composedCols).not.toBe(210);
  });

  it('does not report a mismatch for a healthy session whose rows arrive glued in pairs', async () => {
    // The measured live false red: a healthy 306-column session produced only
    // 612-length runs. Without the PTY grid as the tie-break it reads 612.
    const record = vi.fn();
    const gluedRows = ALT + ('─'.repeat(612) + '\r\n').repeat(9);
    const source = fakeSource(windowDimensions({ ptyCols: 306, ptyRows: 19, lastCols: 306, lastRows: 19 }), gluedRows);
    const sampler = createComposedWidthSampler({ getSource: () => source, record });

    sampler.listener(resizeEntry('session-window'));
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS);

    expect(record).toHaveBeenCalledWith('session-window', 'composed-sample', expect.objectContaining({
      composedCols: 306,
      matchesPty: true,
    }));
  });

  it('records a match when the agent follows the resize (real captured 210-column frame)', async () => {
    const record = vi.fn();
    const source = fakeSource(windowDimensions(), TUI_SETUP + DEFECTIVE_JUMP_FRAME);
    const sampler = createComposedWidthSampler({ getSource: () => source, record });

    sampler.listener(resizeEntry('session-window'));
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS);

    expect(record).toHaveBeenCalledWith('session-window', 'composed-sample', expect.objectContaining({
      composedCols: 210,
      matchesPty: true,
    }));
  });

  it('waits for the last resize of a burst and samples once', async () => {
    const record = vi.fn();
    const source = fakeSource(windowDimensions(), PANEL_WIDTH_FRAME);
    const sampler = createComposedWidthSampler({ getSource: () => source, record });

    sampler.listener(resizeEntry('session-window'));
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS - 1);
    sampler.listener(resizeEntry('session-window'));
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS - 1);
    expect(record).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(source.rawReads).toBe(1);
  });

  it('ignores every trace event other than a pty resize', async () => {
    const record = vi.fn();
    const sampler = createComposedWidthSampler({ getSource: () => fakeSource(windowDimensions(), PANEL_WIDTH_FRAME), record });

    sampler.listener({ ...resizeEntry('session-window'), event: 'settle' });
    sampler.listener({ ...resizeEntry('session-window'), event: 'composed-sample' });
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS * 2);

    expect(record).not.toHaveBeenCalled();
  });

  it('skips a session outside the alt screen, where run lengths say nothing about width', async () => {
    const record = vi.fn();
    const source = fakeSource(windowDimensions({ inAltScreen: false }), PANEL_WIDTH_FRAME);
    const sampler = createComposedWidthSampler({ getSource: () => source, record });

    sampler.listener(resizeEntry('session-window'));
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS);

    expect(record).not.toHaveBeenCalled();
    expect(source.rawReads).toBe(0);
  });

  it('drops a sample quietly when the session is gone, without reading its ring', async () => {
    const record = vi.fn();
    const getTerminalDimensions = vi.fn(async () => [windowDimensions({ sessionId: 'session-other' })]);
    const getRawScrollback = vi.fn(async () => PANEL_WIDTH_FRAME);
    const source: ComposedSampleSource = { getTerminalDimensions, getRawScrollback };
    const sampler = createComposedWidthSampler({ getSource: () => source, record });

    sampler.listener(resizeEntry('session-gone'));
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS);

    // The dimensions read happened (the sample ran), found no row for the
    // session, and stopped before the expensive raw read.
    expect(getTerminalDimensions).toHaveBeenCalledTimes(1);
    expect(getRawScrollback).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('drops a sample quietly when the raw read fails', async () => {
    const record = vi.fn();
    const getRawScrollback = vi
      .fn<(sessionId: string) => Promise<string>>()
      .mockRejectedValue(new Error('pty host restarting'));
    const source: ComposedSampleSource = {
      getTerminalDimensions: async () => [windowDimensions()],
      getRawScrollback,
    };
    const sampler = createComposedWidthSampler({ getSource: () => source, record });

    sampler.listener(resizeEntry('session-window'));
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS);

    // The read was attempted for this session and its rejection was swallowed:
    // nothing is recorded and nothing escapes as an unhandled rejection.
    expect(getRawScrollback).toHaveBeenCalledTimes(1);
    expect(getRawScrollback).toHaveBeenCalledWith('session-window');
    expect(record).not.toHaveBeenCalled();
  });

  it('records nothing and does not throw when no source is available', async () => {
    const record = vi.fn();
    const getSource = vi.fn((): ComposedSampleSource | null => null);
    const sampler = createComposedWidthSampler({ getSource, record });

    sampler.listener(resizeEntry('session-window'));
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS);

    // The sample ran and asked for a source; there was none to sample.
    expect(getSource).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it('debounces per session: two sessions resized in one delay window each get their own sample', async () => {
    const record = vi.fn();
    const rawReadsBySession = new Map<string, number>();
    const dimensionsBySession = new Map<string, ComposedSampleDimensions>([
      ['session-a', windowDimensions({ sessionId: 'session-a' })],
      ['session-b', windowDimensions({ sessionId: 'session-b', ptyCols: 306, ptyRows: 19, lastCols: 306, lastRows: 19 })],
    ]);
    const scrollbackBySession = new Map<string, string>([
      ['session-a', PANEL_WIDTH_FRAME],
      ['session-b', ALT + ('─'.repeat(306) + '\r\n').repeat(9)],
    ]);
    const source: ComposedSampleSource = {
      getTerminalDimensions: async () => Array.from(dimensionsBySession.values()),
      getRawScrollback: async (sessionId) => {
        rawReadsBySession.set(sessionId, (rawReadsBySession.get(sessionId) ?? 0) + 1);
        return scrollbackBySession.get(sessionId) ?? '';
      },
    };
    const sampler = createComposedWidthSampler({ getSource: () => source, record });

    sampler.listener(resizeEntry('session-a'));
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS / 2);
    sampler.listener(resizeEntry('session-b'));
    // Session B's resize must not reset or cancel session A's pending sample.
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS / 2);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toBe('session-a');

    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS / 2);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith('session-a', 'composed-sample', expect.objectContaining({
      ptyCols: 210,
      matchesPty: false,
    }));
    expect(record).toHaveBeenCalledWith('session-b', 'composed-sample', expect.objectContaining({
      composedCols: 306,
      ptyCols: 306,
      matchesPty: true,
    }));
    expect(Object.fromEntries(rawReadsBySession)).toEqual({ 'session-a': 1, 'session-b': 1 });
  });

  it('records matchesPty null when the PTY width is unknown, even though the rows are measurable', async () => {
    const record = vi.fn();
    const source = fakeSource(windowDimensions({ ptyCols: null }), PANEL_WIDTH_FRAME);
    const sampler = createComposedWidthSampler({ getSource: () => source, record });

    sampler.listener(resizeEntry('session-window'));
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS);

    expect(record).toHaveBeenCalledTimes(1);
    const detail = record.mock.calls[0][2] as { composedCols: number | null; ptyCols: number | null; matchesPty: boolean | null };
    // A width was measured (the null is not "nothing to read"), but with no
    // PTY grid to compare against there is no verdict to give.
    expect(detail.composedCols).not.toBeNull();
    expect(detail.ptyCols).toBeNull();
    expect(detail.matchesPty).toBeNull();
  });

  it('cancels pending samples on dispose', async () => {
    const record = vi.fn();
    const sampler = createComposedWidthSampler({ getSource: () => fakeSource(windowDimensions(), PANEL_WIDTH_FRAME), record });

    sampler.listener(resizeEntry('session-window'));
    sampler.dispose();
    await vi.advanceTimersByTimeAsync(COMPOSED_SAMPLE_DELAY_MS * 2);

    expect(record).not.toHaveBeenCalled();
  });
});
