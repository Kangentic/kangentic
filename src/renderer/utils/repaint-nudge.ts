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
 * `onData` is not "the user typed". xterm answers the very modes this nudge
 * gates on by writing REPORTS back through that same channel, so the raw stream
 * has to be filtered before it can arm anything.
 *
 * Focus reports are the load-bearing case, and the gate makes them worse rather
 * than better: the nudge requires DECSET 1004, which is exactly the mode that
 * makes xterm emit `\x1b[I` / `\x1b[O` on focus. A replay re-asserts 1004
 * (`RESTORABLE_DEC_PRIVATE_MODES`) and `useTerminal` focuses the terminal in a
 * `requestAnimationFrame` right afterwards, so without this filter EVERY mount
 * replay arms a nudge with no user present, and the TUI's own focus repaint
 * satisfies the output condition - a self-sustaining round trip that spends an
 * extra full agent render per terminal open, and one per visible pane on every
 * focus change.
 *
 * Mouse MOTION is the mirror problem. Claude Code enables `?1000h ?1002h
 * ?1003h ?1006h`, so pointer drift over the pane arrives here too: it
 * over-triggers the nudge, and worse, it STARVES a real one, because
 * `noteInput` clears `sawOutputSinceInput` - drift landing after the TUI has
 * already answered a genuine scroll cancels the nudge that scroll earned.
 *
 * Clicks, releases, and wheel ticks are deliberately KEPT: they are real
 * interactions, and a click healing a bad frame is the observation this whole
 * mechanism is built on.
 */
const FOCUS_REPORT_PATTERN = /^\x1b\[[IO]$/;
const SGR_MOUSE_REPORT_PATTERN = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;
const X10_MOUSE_REPORT_PATTERN = /^\x1b\[M([\s\S])/;
/** Bit 5 of a mouse report's button byte marks motion (drift or drag). */
const MOUSE_MOTION_BIT = 32;

/**
 * True when `data` is something the USER did, rather than a report xterm
 * generated on the terminal's behalf. Exported so the policy is testable
 * without a live terminal or a PTY.
 */
export function isUserInputData(data: string): boolean {
  if (FOCUS_REPORT_PATTERN.test(data)) return false;

  const sgrReport = SGR_MOUSE_REPORT_PATTERN.exec(data);
  if (sgrReport) return (Number(sgrReport[1]) & MOUSE_MOTION_BIT) === 0;

  const x10Report = X10_MOUSE_REPORT_PATTERN.exec(data);
  if (x10Report) return ((x10Report[1].charCodeAt(0) - 32) & MOUSE_MOTION_BIT) === 0;

  return true;
}

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

  // 'dormant' rather than the more obvious 'idle': this is the nudge's own state
  // machine and has nothing to do with `ActivityState`, whose union includes an
  // 'idle' member. Naming it 'idle' inside src/renderer reads to the
  // activity-state classification scan as a hand-rolled bucket comparison
  // (.claude/rules/activity-state-classification.md). Renaming keeps the check
  // honest instead of spending an `activity-state-ok` escape on a name clash.
  let phase: 'dormant' | 'armed' | 'verifying' = 'dormant';
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
    phase = 'dormant';
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

    const firedAt = now();
    if (firedAt - lastNudgeAt < minIntervalMs) {
      reset();
      return;
    }

    lastNudgeAt = firedAt;
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
      if (phase === 'dormant') return;
      sawOutputSinceInput = true;
      clearQuiesceTimer();
      quiesceTimer = setTimeout(onQuiesced, quiesceMs);
    },
    dispose(): void {
      reset();
    },
  };
}
