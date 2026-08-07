/**
 * Deterministic simulator for the auto_command injection path.
 *
 * Not a test file (vitest only collects `*.test.ts`). This is the shared rig
 * used by `injection-load-rig.test.ts` to measure delivery rate, and by the
 * injection regression tests to exercise the real `TerminalSubmit` against a
 * TUI that can actually fail the way Claude Code's Ink prompt fails.
 *
 * What it models, and why each piece exists:
 *
 *  - **A slash-command picker with a render delay.** The documented
 *    regression is that `Esc` sent on a fixed 100ms delay can arrive BEFORE
 *    the picker has rendered, where it is a no-op; the picker then renders
 *    and eats the following `Enter`, leaving the command typed but never
 *    submitted. That failure needs a picker whose render takes wall-clock
 *    time, so it is modeled explicitly rather than assumed.
 *
 *  - **A prompt buffer that survives.** Text appends. This is what makes the
 *    `instead can we/pull-request` concatenation reproducible: if a draft is
 *    present and the clear does not land, the injected command glues onto it
 *    and the submission is wrong rather than missing.
 *
 *  - **Ctrl+C dropped mid-repaint.** On Windows ConPTY + Ink a Ctrl+C landing
 *    mid-render was swallowed, which is the origin of the `</task>/test` glue
 *    bug. Modeled so a fix that merely skips the clear cannot pass by
 *    accident.
 *
 *  - **An asynchronous write queue.** Real writes are enqueued and drained on
 *    a later tick, so a delay measured from enqueue is not a delay measured
 *    from the PTY. `drain()` is meaningful here, which is what lets the rig
 *    show the difference.
 *
 * Timing is real (not fake timers) but scaled small, and all randomness is
 * seeded, so runs are reproducible and the suite stays fast on CI.
 */
import { EventEmitter } from 'node:events';

/** Seeded PRNG (mulberry32). Deterministic across platforms. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export type PickerState = 'none' | 'rendering' | 'open';

export interface FakeTuiOptions {
  /** Wall-clock time the slash-command picker takes to become visible. */
  pickerRenderMs: number;
  /** Delay between the TUI receiving bytes and emitting its repaint output. */
  repaintLatencyMs: number;
  /**
   * Window after the TUI comes up during which a Ctrl+C is swallowed, modeling
   * the Windows ConPTY + Ink drop that produced the `</task>/test` glue bug.
   *
   * Deliberately scoped to STARTUP rather than to any in-flight repaint:
   * interrupting a steadily streaming agent with Ctrl+C works fine in
   * practice, and the historical regression was specific to the initial
   * render. Modeling it as "any repaint" would make the fresh-spawn carve-out
   * look load-bearing for the wrong reason.
   */
  startupRenderMs: number;
  /** Whether Esc with no picker open clears the prompt buffer. */
  escClearsWithoutPicker: boolean;
  /**
   * Repaint on this interval even with no input, modeling an agent that is
   * actively streaming (a live turn, a spinner, a 529 retry footer). This is
   * what keeps a repaint in flight, which is the condition under which a
   * Ctrl+C gets swallowed and the injected command glues onto the draft.
   * Zero disables it.
   */
  busyRepaintIntervalMs: number;
  /**
   * Swallow this many Enters as if the picker had consumed them, regardless of
   * render timing.
   *
   * Exists so a test can exercise the RECOVERY path deterministically. Relying
   * on `pickerRenderMs` to land inside the failure window works on an idle
   * machine and stops working under load, where the first attempt may simply
   * succeed - which is a better outcome that would nonetheless fail an
   * assertion that a retry occurred.
   */
  eatEnterCount: number;
  /**
   * Window within which separate writes arrive as ONE read.
   *
   * This is the difference between modeling keystrokes and modeling a PTY, and
   * it is not cosmetic: `\x1b` followed by `\r` in a single read is the
   * terminal's Meta prefix, so the TUI receives Alt+Enter (insert newline)
   * rather than Esc-then-Enter (dismiss, then submit). Delivering each write
   * as its own key event - what this rig used to do - makes that failure
   * invisible, which is exactly how a 100%-delivery measurement coexisted with
   * a live bug that inserted blank lines and never submitted.
   *
   * `drain()` does NOT protect against this. It empties the writer's own
   * queue; it says nothing about how the child chunks its reads.
   */
  readCoalesceWindowMs: number;
}

export const DEFAULT_TUI_OPTIONS: FakeTuiOptions = {
  pickerRenderMs: 40,
  repaintLatencyMs: 3,
  startupRenderMs: 0,
  escClearsWithoutPicker: false,
  busyRepaintIntervalMs: 0,
  eatEnterCount: 0,
  readCoalesceWindowMs: 10,
};

export interface Submission {
  text: string;
  at: number;
}

/**
 * A minimal model of Claude Code's Ink prompt: a text buffer, a slash-command
 * picker with a render delay, and a submit path that records what the agent
 * actually received.
 */
export class FakeTui {
  readonly submissions: Submission[] = [];
  /** Ctrl+C presses that landed on an already-empty prompt. Two consecutive
   *  of these is what actually exits the CLI, so the rig can assert we never
   *  produce that pair. */
  consecutiveEmptyCtrlC = 0;
  maxConsecutiveEmptyCtrlC = 0;

  private buffer = '';
  private picker: PickerState = 'none';
  private pickerTimer: ReturnType<typeof setTimeout> | null = null;
  private repaintTimer: ReturnType<typeof setTimeout> | null = null;
  private busyTimer: ReturnType<typeof setInterval> | null = null;
  private eatenEnters = 0;
  /** True once "Esc again to clear" is showing; a second Esc wipes the line. */
  private pendingEscClear = false;
  /** Set if a double-Esc ever destroyed the prompt. Asserted against. */
  escClearedBuffer = false;
  private pendingRead = '';
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly createdAt = Date.now();

  constructor(
    private readonly options: FakeTuiOptions,
    private readonly emitOutput: (data: string) => void,
  ) {
    if (options.busyRepaintIntervalMs > 0) {
      this.busyTimer = setInterval(() => this.scheduleRepaint(), options.busyRepaintIntervalMs);
      // Never hold the process open on account of the rig.
      this.busyTimer.unref?.();
    }
  }

  /** Seed a user draft, as if the user had typed without submitting. */
  setDraft(text: string): void {
    this.buffer = text;
  }

  getBuffer(): string {
    return this.buffer;
  }

  getPickerState(): PickerState {
    return this.picker;
  }

  /**
   * Bytes from the writer. Buffered and parsed on the coalesce window rather
   * than per call, because a PTY child reads whatever has accumulated - it does
   * not see the writer's individual `write()` boundaries.
   */
  receive(chunk: string): void {
    this.pendingRead += chunk;
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      const read = this.pendingRead;
      this.pendingRead = '';
      this.parseRead(read);
    }, this.options.readCoalesceWindowMs);
    this.readTimer.unref?.();
  }

  /**
   * Parse one read into key events, the way an Ink-style parser does.
   *
   * The load-bearing case: `\x1b` with anything after it IN THE SAME READ is a
   * Meta prefix, so `\x1b\r` is Alt+Enter, not Esc followed by Enter. A lone
   * trailing `\x1b` is a real Escape keypress.
   */
  private parseRead(read: string): void {
    let index = 0;
    let text = '';
    const flushText = (): void => {
      if (text.length > 0) {
        this.handleText(text);
        text = '';
      }
    };
    while (index < read.length) {
      const byte = read[index];
      if (byte === '\x1b') {
        flushText();
        const next = read[index + 1];
        if (next === undefined) {
          this.handleEscape();
          index += 1;
        } else {
          this.handleMeta(next);
          index += 2;
        }
        continue;
      }
      if (byte === '\x03' || byte === '\x15' || byte === '\r') {
        flushText();
        if (byte === '\x03') this.handleCtrlC();
        else if (byte === '\x15') this.handleClearLine();
        else this.handleEnter();
        index += 1;
        continue;
      }
      text += byte;
      index += 1;
    }
    flushText();
    // Any input at all repaints the prompt box; the settle handshake only
    // cares that bytes arrived and then stopped.
    this.scheduleRepaint();
  }

  /**
   * A Meta (Alt) chord. Alt+Enter inserts a newline in Claude Code instead of
   * submitting, which is precisely the observed failure: the command sat in the
   * prompt gaining blank lines while every retry "pressed Enter".
   */
  private handleMeta(key: string): void {
    if (key === '\r') {
      this.buffer += '\n';
      this.scheduleRepaint();
      return;
    }
    // Other Meta chords are inert for this rig's purposes.
  }

  dispose(): void {
    if (this.pickerTimer) clearTimeout(this.pickerTimer);
    if (this.repaintTimer) clearTimeout(this.repaintTimer);
    if (this.busyTimer) clearInterval(this.busyTimer);
    if (this.readTimer) clearTimeout(this.readTimer);
    this.pickerTimer = null;
    this.repaintTimer = null;
    this.busyTimer = null;
    this.readTimer = null;
  }

  private handleCtrlC(): void {
    if (Date.now() - this.createdAt < this.options.startupRenderMs) {
      // Swallowed during the initial render. The buffer is untouched, which
      // is how an injected command ends up glued onto whatever was there.
      return;
    }
    if (this.buffer.length === 0) {
      this.consecutiveEmptyCtrlC += 1;
      this.maxConsecutiveEmptyCtrlC = Math.max(this.maxConsecutiveEmptyCtrlC, this.consecutiveEmptyCtrlC);
    } else {
      this.consecutiveEmptyCtrlC = 0;
    }
    this.buffer = '';
    this.closePicker();
  }

  /**
   * Ctrl+U: clear the input line.
   *
   * Line editing, not a signal. It always clears regardless of what the TUI is
   * doing, and - unlike Ctrl+C - it is never swallowed by a startup render and
   * never contributes to the double-press that exits the CLI. That difference
   * is the whole reason the clear moved onto this key.
   */
  private handleClearLine(): void {
    this.consecutiveEmptyCtrlC = 0;
    this.buffer = '';
    this.closePicker();
  }

  /**
   * Esc, with the three meanings Claude Code actually gives it.
   *
   * It is NOT a picker-scoped key. The docs describe it as "stop Claude while
   * it is generating output", and on a non-empty prompt with no picker the
   * first press prints "Esc again to clear" while the SECOND press clears the
   * line. Modeling only the picker case is what let a retry loop that re-sent
   * Esc look safe: in reality the second Esc deletes the command being
   * submitted.
   */
  private handleEscape(): void {
    this.consecutiveEmptyCtrlC = 0;
    if (this.picker === 'open') {
      this.closePicker();
      this.pendingEscClear = false;
      return;
    }
    if (this.picker === 'rendering') {
      // The no-op that starts the documented failure: Esc arrived before the
      // picker mounted, so nothing consumes it. The picker still renders.
      return;
    }
    if (this.options.escClearsWithoutPicker) {
      this.buffer = '';
      return;
    }
    if (this.buffer.length === 0) return;
    if (this.pendingEscClear) {
      // "Esc again to clear" was already showing. This press wipes the prompt.
      this.buffer = '';
      this.pendingEscClear = false;
      this.escClearedBuffer = true;
      return;
    }
    this.pendingEscClear = true;
  }

  private handleEnter(): void {
    this.consecutiveEmptyCtrlC = 0;
    if (this.eatenEnters < this.options.eatEnterCount) {
      // Deterministic stand-in for "the picker consumed this Enter". The text
      // stays in the buffer, unsubmitted, exactly as in the timing-driven case.
      this.eatenEnters += 1;
      return;
    }
    if (this.picker === 'open') {
      // The picker consumes Enter (selects a highlighted entry rather than
      // submitting). The text stays in the buffer, unsubmitted.
      return;
    }
    if (this.buffer.length === 0) return;
    this.submissions.push({ text: this.buffer, at: Date.now() });
    this.buffer = '';
    this.closePicker();
  }

  private handleText(text: string): void {
    this.consecutiveEmptyCtrlC = 0;
    this.buffer += text;
    if (this.buffer.startsWith('/') && this.picker === 'none') {
      this.picker = 'rendering';
      this.pickerTimer = setTimeout(() => {
        if (this.picker === 'rendering') this.picker = 'open';
        // A picker becoming visible is itself a repaint.
        this.scheduleRepaint();
      }, this.options.pickerRenderMs);
    }
  }

  private closePicker(): void {
    if (this.pickerTimer) clearTimeout(this.pickerTimer);
    this.pickerTimer = null;
    this.picker = 'none';
  }

  private scheduleRepaint(): void {
    if (this.repaintTimer) clearTimeout(this.repaintTimer);
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = null;
      // A repaint of the prompt box. Content does not matter to the settle
      // handshake, only that bytes arrived and then stopped.
      this.emitOutput(`\x1b[2K\r> ${this.buffer}`);
    }, this.options.repaintLatencyMs);
  }
}

export interface SimulatedSessionManagerOptions {
  /** Extra latency before enqueued bytes reach the TUI. Models a busy queue. */
  writeQueueDelayMs?: number;
  /** Whether the session is renderer-focused, gating the `'data'` event. */
  focused?: boolean;
}

/**
 * Stands in for `SessionManager` on the seams `TerminalSubmit` uses: `write`,
 * `drain`, and the `'data'` / `'data-tap'` events.
 *
 * `'data'` is emitted only when `focused` is true, mirroring the real
 * `focusedSessionIds` gate; `'data-tap'` always fires. The rig defaults to
 * unfocused because that is the normal case for auto_command injection - the
 * task being dragged is usually not the terminal on screen.
 */
export class SimulatedSessionManager extends EventEmitter {
  readonly writes: string[] = [];
  readonly tui: FakeTui;

  private pending: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private drainWaiters: Array<() => void> = [];
  private readonly writeQueueDelayMs: number;
  private readonly focused: boolean;

  constructor(
    readonly sessionId: string,
    tuiOptions: FakeTuiOptions = DEFAULT_TUI_OPTIONS,
    options: SimulatedSessionManagerOptions = {},
  ) {
    super();
    this.writeQueueDelayMs = options.writeQueueDelayMs ?? 0;
    this.focused = options.focused ?? false;
    this.tui = new FakeTui(tuiOptions, (data) => {
      this.emit('data-tap', this.sessionId, data);
      if (this.focused) this.emit('data', this.sessionId, data);
    });
  }

  write(sessionId: string, data: string): void {
    if (sessionId !== this.sessionId || data.length === 0) return;
    this.writes.push(data);
    this.pending.push(data);
    this.scheduleFlush();
  }

  writeRaw(sessionId: string, data: string): void {
    this.write(sessionId, data);
  }

  drain(sessionId: string): Promise<void> {
    if (sessionId !== this.sessionId) return Promise.resolve();
    if (this.pending.length === 0 && this.flushTimer === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.tui.dispose();
    // Release anyone still waiting so a disposed rig cannot hang a test.
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = this.pending;
      this.pending = [];
      for (const chunk of batch) this.tui.receive(chunk);
      if (this.pending.length === 0) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const resolve of waiters) resolve();
      } else {
        this.scheduleFlush();
      }
    }, this.writeQueueDelayMs);
  }
}

/** No-op paste engine; `submitKeystrokes` never touches it. */
export function createStubPasteEngine(): {
  pasteAndSubmit: (sessionId: string, text: string) => Promise<void>;
} {
  return { pasteAndSubmit: (): Promise<void> => Promise.resolve() };
}

/**
 * Build a verifier over the TUI's submission log with the same semantics the
 * real Claude verifier uses: an entry must have landed at or after `sentAt`
 * (with the same 50ms tolerance) and its content must match EXACTLY.
 *
 * Exactness is the whole point. `instead can we/pull-request` CONTAINS
 * `/pull-request`, so a substring check would confirm the precise bug this
 * work exists to fix as a successful delivery.
 */
export function createSubmissionVerifier(tui: FakeTui): (command: string, sentAt: number) => Promise<boolean> {
  return async function verify(command: string, sentAt: number): Promise<boolean> {
    return tui.submissions.some((entry) => entry.at >= sentAt - 50 && entry.text === command);
  };
}

/** Did the TUI receive this exact command as a discrete submission? */
export function wasDeliveredExactly(tui: FakeTui, command: string): boolean {
  return tui.submissions.some((entry) => entry.text === command);
}
