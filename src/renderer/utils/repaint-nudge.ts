/**
 * Post-interaction repaint nudge for fullscreen agent TUIs.
 *
 * The problem it addresses: a scrolled alt-screen frame from Claude Code
 * intermittently arrives incomplete. Sometimes the whole transcript is missing
 * and only chrome is drawn; sometimes a contiguous band of rows in the middle is
 * blank while everything around it is correct. Both heal the instant the user
 * clicks or resizes, because the TUI then produces its next (correct) frame.
 * Both are the same shape: a full-screen erase followed by a redraw that omits
 * rows, from a renderer that will not revisit them because it believes they are
 * already on screen.
 *
 * Why this is not a detector. Recognising a hole in a frame means asking "is
 * this frame too sparse?", which is a threshold, and every threshold
 * false-positives on a frame that is legitimately sparse. The obvious
 * alternatives do not survive contact with the bug either: comparing against the
 * previous grid is useless when the user just SCROLLED (the whole viewport
 * legitimately changed), and the main-process parser is fed byte-identical
 * input, so it reproduces a defective frame faithfully rather than exposing it.
 *
 * So this does not look at the grid to decide anything. It fires on the TRIGGER
 * instead of on the symptom: input reached the terminal, output came back, the
 * output stopped. At that moment it asks the TUI for one more frame, whatever
 * the last one looked like. No thresholds, no false-positive surface, and it
 * covers every flavour of the defect because it never asks what the defect
 * looks like.
 *
 * The nudge is a focus report the TUI explicitly asked for by enabling DECSET
 * 1004 - the same bytes a real terminal sends on alt-tab, and the same reason a
 * click already heals the frame today. It is not a synthetic poke and it does
 * not shadow the CLI's own scroll handling.
 *
 * The before/after grid comparison is REPORTING ONLY. It never gates the nudge.
 * That is what keeps this threshold-free while still producing a real-world
 * defect rate, which is the evidence an upstream report needs.
 */

/** FocusOut then FocusIn. Costs the TUI one render and moves no cursor. */
export const REPAINT_NUDGE_BYTES = '\x1b[O\x1b[I';

/**
 * Output-quiet window before the nudge. Long enough that a streaming agent never
 * sees one mid-frame (its chunks arrive far closer together than this), short
 * enough that a user who scrolled and stopped does not sit looking at a hole.
 */
const NUDGE_QUIESCE_MS = 250;

/**
 * Floor between nudges for one session, so holding a scroll key costs a bounded
 * number of extra renders rather than one per repeat.
 */
const NUDGE_MIN_INTERVAL_MS = 750;

export interface RepaintNudgeGate {
  /** A fullscreen TUI owns the grid. The defect is alt-screen only. */
  altScreen: boolean;
  /** DECSET 1004 is on, so a focus report is something the TUI asked to receive. */
  focusReportingEnabled: boolean;
  /** Parked terminals are discarding bytes; a repaint would be thrown away. */
  parked: boolean;
  /** A replay already repaints the whole grid, so a nudge would be redundant. */
  replayPending: boolean;
}

/**
 * Pure gate. Exported so the policy is testable without timers or a terminal,
 * and so every condition is visible in one expression rather than spread across
 * the state machine below.
 */
export function shouldSendRepaintNudge(gate: RepaintNudgeGate): boolean {
  return gate.altScreen && gate.focusReportingEnabled && !gate.parked && !gate.replayPending;
}

/** Rows that differ between two viewport snapshots. Reporting only. */
export function diffViewportRows(before: string[], after: string[]): number[] {
  const changed: number[] = [];
  const rowCount = Math.max(before.length, after.length);
  for (let row = 0; row < rowCount; row++) {
    if ((before[row] ?? '') !== (after[row] ?? '')) changed.push(row);
  }
  return changed;
}

export interface RepaintNudgeOptions {
  /** Live gate state, read at fire time rather than captured. */
  readGate: () => RepaintNudgeGate;
  /** Viewport rows for the comparison, or null to skip it (production). */
  snapshotViewport: () => string[] | null;
  /** Deliver the nudge bytes to the PTY. */
  send: (data: string) => void;
  trace: (event: string, detail: () => Record<string, unknown>) => void;
  /** Overridable so tests do not wait on real timers. */
  quiesceMs?: number;
  minIntervalMs?: number;
  now?: () => number;
}

export interface RepaintNudgeController {
  /** The user sent something to this session. */
  noteInput(): void;
  /** Bytes arrived from this session. */
  noteOutput(): void;
  dispose(): void;
}

export function createRepaintNudge(options: RepaintNudgeOptions): RepaintNudgeController {
  const quiesceMs = options.quiesceMs ?? NUDGE_QUIESCE_MS;
  const minIntervalMs = options.minIntervalMs ?? NUDGE_MIN_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());

  let phase: 'idle' | 'armed' | 'verifying' = 'idle';
  // Requiring output before nudging keeps a swallowed keystroke (or input to a
  // session that is not actually rendering) from spending a render.
  let sawOutputSinceInput = false;
  let quiesceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastNudgeAt = 0;
  let snapshotBefore: string[] | null = null;

  const clearQuiesceTimer = (): void => {
    if (quiesceTimer === null) return;
    clearTimeout(quiesceTimer);
    quiesceTimer = null;
  };

  const reset = (): void => {
    phase = 'idle';
    sawOutputSinceInput = false;
    snapshotBefore = null;
    clearQuiesceTimer();
  };

  const onQuiesced = (): void => {
    quiesceTimer = null;

    if (phase === 'verifying') {
      const after = options.snapshotViewport();
      if (snapshotBefore && after) {
        const changedRows = diffViewportRows(snapshotBefore, after);
        // A difference means the frame on screen before the nudge was WRONG and
        // this repaired it. Identical means the frame was already correct and we
        // spent one cheap render. Either way the nudge already happened; this
        // only records which it was.
        options.trace(
          changedRows.length > 0 ? 'repaint-repaired' : 'repaint-verified',
          () => ({ changedRows: changedRows.length, firstChangedRow: changedRows[0] ?? null }),
        );
      }
      reset();
      return;
    }

    if (phase !== 'armed' || !sawOutputSinceInput) {
      reset();
      return;
    }

    const gate = options.readGate();
    if (!shouldSendRepaintNudge(gate)) {
      reset();
      return;
    }

    const at = now();
    if (at - lastNudgeAt < minIntervalMs) {
      reset();
      return;
    }

    lastNudgeAt = at;
    snapshotBefore = options.snapshotViewport();
    options.send(REPAINT_NUDGE_BYTES);
    // The nudge's own frame will call noteOutput and re-arm this timer, which is
    // what schedules the comparison. If the TUI answers with nothing at all, the
    // timer below closes the loop instead of leaving the phase stuck.
    phase = 'verifying';
    quiesceTimer = setTimeout(onQuiesced, quiesceMs);
  };

  return {
    noteInput(): void {
      if (phase === 'verifying') return;
      phase = 'armed';
      sawOutputSinceInput = false;
      clearQuiesceTimer();
      quiesceTimer = setTimeout(onQuiesced, quiesceMs);
    },
    noteOutput(): void {
      if (phase === 'idle') return;
      sawOutputSinceInput = true;
      clearQuiesceTimer();
      quiesceTimer = setTimeout(onQuiesced, quiesceMs);
    },
    dispose(): void {
      reset();
    },
  };
}
