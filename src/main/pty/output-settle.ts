/**
 * Output-settle handshake: wait until the TUI has actually rendered a
 * response to bytes we just wrote, rather than sleeping on the wall clock.
 *
 * Extracted from `paste-engine.ts` so the keystroke path
 * (`terminal-submit.ts`) can use the same primitive. Fixed sleeps are what
 * degrade under load: a 100ms gap tuned against an observed worst-case Ink
 * picker render is correct on an idle machine and wrong on a busy one. A
 * settle waits for the render itself, so it is fast when the machine is fast
 * and patient when it is not.
 *
 * Three outcomes, all bounded:
 *   - `idle`       data arrived, then `idleMs` of quiet. The happy path.
 *   - `cap`        data arrived but never went quiet (busy session). Bounded
 *                  by `capMs`.
 *   - `floor-only` no data ever arrived (hookless agent, dead TUI). Bounded
 *                  by `capMs`, floored by `floorMs`.
 *
 * WHICH EVENT TO OBSERVE is the caller's decision and it matters:
 * `SessionManager`'s `'data'` event is gated on renderer focus
 * (`focusedSessionIds`, default-closed), while `'data-tap'` fires for every
 * session regardless of focus. A headless caller - auto_command injection
 * into a task whose terminal is not the visible one is the normal case, not
 * the exception - must observe `'data-tap'` or it will silently degrade to
 * the wall-clock floor for exactly the sessions it cares about. See the
 * comment on `focusedSessionIds` in `session-manager.ts`.
 */

/** Structural view of the emitter, so tests and rigs can supply a stub. */
export interface OutputSettleSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface OutputSettleResult {
  waitedMs: number;
  observedOutput: boolean;
  reason: 'idle' | 'cap' | 'floor-only';
}

/** Stage at which an abort landed, so callers can build a precise message. */
export type OutputSettleAbortStage = 'before' | 'during' | 'floor';

export interface OutputSettleOptions {
  /**
   * `'data-tap'` for focus-independent observation (headless callers),
   * `'data'` for the renderer-gated stream. See the module comment.
   */
  event: 'data' | 'data-tap';
  /** Quiet window after the most recent byte before declaring settle. */
  idleMs: number;
  /** Upper bound on the whole wait, whether or not output is ever seen. */
  capMs: number;
  /** Lower bound on the whole wait. Use 0 when no commit floor is needed. */
  floorMs: number;
  signal: AbortSignal;
  /**
   * Builds the rejection thrown on abort. Each caller keeps its own error
   * type: PasteEngine needs a `PasteSubmitError` its callers already catch,
   * TerminalSubmit needs a plain `Error` matching its abort convention.
   */
  abortError: (stage: OutputSettleAbortStage) => Error;
}

export function waitForOutputSettle(
  source: OutputSettleSource,
  sessionId: string,
  options: OutputSettleOptions,
): Promise<OutputSettleResult> {
  const { event, idleMs, capMs, floorMs, signal, abortError } = options;

  return new Promise<OutputSettleResult>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError('before'));
      return;
    }

    const start = Date.now();
    let observedOutput = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    const cleanup = (): void => {
      source.off(event, onData);
      signal.removeEventListener('abort', onAbort);
      if (idleTimer) clearTimeout(idleTimer);
      if (capTimer) clearTimeout(capTimer);
    };

    const finish = (reason: OutputSettleResult['reason']): void => {
      if (resolved) return;
      cleanup();
      const elapsed = Date.now() - start;
      const remainingFloor = Math.max(0, floorMs - elapsed);
      if (remainingFloor > 0) {
        // Settle landed inside the floor window; sleep the rest.
        const floorTimer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          signal.removeEventListener('abort', onFloorAbort);
          resolve({ waitedMs: Date.now() - start, observedOutput, reason });
        }, remainingFloor);
        const onFloorAbort = (): void => {
          if (resolved) return;
          resolved = true;
          clearTimeout(floorTimer);
          reject(abortError('floor'));
        };
        signal.addEventListener('abort', onFloorAbort, { once: true });
        return;
      }
      resolved = true;
      resolve({ waitedMs: elapsed, observedOutput, reason });
    };

    const onData = (...args: unknown[]): void => {
      if (args[0] !== sessionId) return;
      observedOutput = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish('idle'), idleMs);
    };

    const onAbort = (): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(abortError('during'));
    };

    source.on(event, onData);
    signal.addEventListener('abort', onAbort, { once: true });
    capTimer = setTimeout(() => {
      finish(observedOutput ? 'cap' : 'floor-only');
    }, capMs);
  });
}
