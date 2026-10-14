import { composedMatchesPty, measureComposedCols } from './composed-width';
import type { TerminalTraceListener } from '../../main/pty/terminal-trace';

/**
 * Records the width and height the agent itself composes at, shortly after each
 * PTY resize, as a `composed-sample` trace entry.
 *
 * Every other trace entry describes what Kangentic did: the renderer's fit, the
 * grid main applied, the grid the pty host applied. None of them can show the
 * agent ignoring that grid. A stuck pair of task windows once showed exactly
 * that: the agent painted full-width rows for the bottom panel's 306 columns
 * inside a 210-column window, while main's last applied grid was the window's.
 * This sample is the reading that would have named the failing layer.
 *
 * Debounced per session to the last resize of a burst, so a window switch
 * (one resize per session) costs one raw-ring read per session, and a drag's
 * stream of resizes costs one read at its end.
 */

/** Long enough for the post-resize frame to land (the resize repaint settled
 *  within 120 ms under a deliberately saturated CPU), short enough to be read
 *  before the user's next switch. */
export const COMPOSED_SAMPLE_DELAY_MS = 1000;

export interface ComposedSampleDimensions {
  sessionId: string;
  ptyCols: number | null;
  ptyRows: number | null;
  /** The grid the pty host's buffer was last resized to. */
  lastCols: number | null;
  lastRows: number | null;
  inAltScreen: boolean;
}

/** The two SessionManager reads a sample needs. */
export interface ComposedSampleSource {
  getTerminalDimensions(): Promise<ComposedSampleDimensions[]>;
  getRawScrollback(sessionId: string): Promise<string>;
}

export interface ComposedWidthSamplerOptions {
  getSource: () => ComposedSampleSource | null;
  record: (sessionId: string, event: string, detail: Record<string, unknown>) => void;
  delayMs?: number;
}

export interface ComposedWidthSampler {
  listener: TerminalTraceListener;
  dispose: () => void;
}

export function createComposedWidthSampler(options: ComposedWidthSamplerOptions): ComposedWidthSampler {
  const delayMs = options.delayMs ?? COMPOSED_SAMPLE_DELAY_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  async function sample(sessionId: string): Promise<void> {
    const source = options.getSource();
    if (!source) return;
    try {
      const dimensions = (await source.getTerminalDimensions()).find((row) => row.sessionId === sessionId);
      // Outside the alt screen, run lengths in pass-through output say nothing
      // about width (see composed-width.ts), so no sample beats a wrong one.
      if (!dimensions || !dimensions.inAltScreen) return;
      // The PTY grid breaks ties between exact multiples, as in the
      // terminal-state route. Runs alone cannot tell rows of W glued in pairs
      // from rows of 2W, so either rule misreads some case. Without the
      // reference a healthy 306 session whose rows arrive glued reads 612 (a
      // false mismatch, measured live). With it, an agent composing 306 in a
      // 210 grid reads 153, which still reports matchesPty false. The verdict
      // is what this sample is for; the width may be a multiple or
      // sub-multiple of the true one when it disagrees.
      const measurement = measureComposedCols(await source.getRawScrollback(sessionId), dimensions.ptyCols);
      options.record(sessionId, 'composed-sample', {
        composedCols: measurement.composedCols,
        sampleCount: measurement.sampleCount,
        ptyCols: dimensions.ptyCols,
        ptyRows: dimensions.ptyRows,
        hostCols: dimensions.lastCols,
        hostRows: dimensions.lastRows,
        matchesPty: composedMatchesPty(measurement.composedCols, dimensions.ptyCols),
      });
    } catch {
      // The session ended or the host is restarting. A missed sample is fine.
    }
  }

  const listener: TerminalTraceListener = (entry) => {
    if (entry.event !== 'pty-resize') return;
    const pending = timers.get(entry.sessionId);
    if (pending !== undefined) clearTimeout(pending);
    const timer = setTimeout(() => {
      timers.delete(entry.sessionId);
      void sample(entry.sessionId);
    }, delayMs);
    // Never hold the process open for a diagnostic.
    if (typeof timer.unref === 'function') timer.unref();
    timers.set(entry.sessionId, timer);
  };

  return {
    listener,
    dispose: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
