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
}

export const DEFAULT_TUI_OPTIONS: FakeTuiOptions = {
  pickerRenderMs: 40,
  repaintLatencyMs: 3,
  startupRenderMs: 0,
  escClearsWithoutPicker: false,
  busyRepaintIntervalMs: 0,
  eatEnterCount: 0,
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

  receive(chunk: string): void {
    if (chunk === '\x03') this.handleCtrlC();
    else if (chunk === '\x1b') this.handleEscape();
    else if (chunk === '\r') this.handleEnter();
    else this.handleText(chunk);
    this.scheduleRepaint();
  }

  dispose(): void {
    if (this.pickerTimer) clearTimeout(this.pickerTimer);
    if (this.repaintTimer) clearTimeout(this.repaintTimer);
    if (this.busyTimer) clearInterval(this.busyTimer);
    this.pickerTimer = null;
    this.repaintTimer = null;
    this.busyTimer = null;
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

  private handleEscape(): void {
    this.consecutiveEmptyCtrlC = 0;
    if (this.picker === 'open') {
      this.closePicker();
      return;
    }
    if (this.picker === 'rendering') {
      // The no-op that starts the documented failure: Esc arrived before the
      // picker mounted, so nothing consumes it. The picker still renders.
      return;
    }
    if (this.options.escClearsWithoutPicker) this.buffer = '';
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
