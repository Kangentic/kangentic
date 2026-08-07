import type { SessionManager } from '../pty/session-manager';
import type { ActivityState } from '../../shared/types';

/**
 * "Has the agent's current turn finished?" - the single predicate, used by
 * BOTH deferred auto_command delivery and escalation. Written once on purpose:
 * a second hand-rolled idle check at the escalation site is exactly how the
 * two drift apart, and the failure mode of a wrong answer here is delivering
 * a command (or killing a session) in the middle of live work.
 *
 * WHY A BARE `idle` IS NOT ENOUGH. The activity engine's idle is trustworthy
 * for ordinary turns but has catalogued sustained false positives:
 *
 *   - during an API 529 / server_error retry backoff, `StopFailure` maps to
 *     `turn_failed` and force-commits idle for the whole backoff window
 *     (observed ~148s);
 *   - while Claude's `Monitor` tool is waiting, the engine tracks no holder at
 *     all and reads idle for the entire wait.
 *
 * A stability window does not help: both cases are minutes long, so any
 * practical window expires inside them. What distinguishes them is that the
 * CLI is still PAINTING - a spinner, a retry footer, a countdown. So this
 * requires two independent signals to agree: activity is idle AND the PTY has
 * produced no output for `quietMs`.
 *
 * Note the direction carefully. Output PRESENT holds delivery back; output
 * ABSENT is never taken as proof of anything on its own. That is the safe
 * direction, and it is why this does not contradict the known result that
 * output quiescence is not a liveness proxy (a silent background server must
 * not be declared dead) - we never declare anything dead here.
 *
 * `permission` is deliberately not a completion state. A session blocked on a
 * permission prompt is waiting for a keypress, and injecting command text
 * there would answer the prompt with the command.
 */

export type TurnCompletionResult = 'completed' | 'timeout' | 'exited' | 'aborted';

export interface TurnCompletionOptions {
  /**
   * How long the PTY must stay silent before idle is believed. Covers spinner
   * repaint cadence with margin.
   */
  quietMs?: number;
  /** Give up after this long and report `timeout`. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_QUIET_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Is this state a finished turn? Granular by design; see the module comment. */
function isTurnComplete(state: ActivityState | undefined): boolean {
  // activity-state-ok: a GRANULAR check, not the idle-vs-active bucket.
  // `requiresUserInteraction` would also accept `permission`, and injecting
  // into a pending permission prompt answers it with our command text.
  return state === 'idle';
}

export function waitForTurnCompletion(
  sessionManager: SessionManager,
  sessionId: string,
  options: TurnCompletionOptions = {},
): Promise<TurnCompletionResult> {
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal;

  return new Promise<TurnCompletionResult>((resolve) => {
    if (signal?.aborted) {
      resolve('aborted');
      return;
    }

    let activity: ActivityState | undefined = sessionManager.getActivityCache()[sessionId];
    let lastOutputAt = Date.now();
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: TurnCompletionResult): void => {
      if (settled) return;
      settled = true;
      sessionManager.off('activity', onActivity);
      sessionManager.off('data-tap', onOutput);
      sessionManager.off('exit', onExit);
      signal?.removeEventListener('abort', onAbort);
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      resolve(result);
    };

    /** Re-arm the quiet check for whenever the window could next be satisfied. */
    const evaluate = (): void => {
      if (settled) return;
      if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
      if (!isTurnComplete(activity)) return;
      const quietFor = Date.now() - lastOutputAt;
      if (quietFor >= quietMs) {
        finish('completed');
        return;
      }
      quietTimer = setTimeout(evaluate, quietMs - quietFor);
    };

    const onActivity = (evtSessionId: string, state: ActivityState): void => {
      if (evtSessionId !== sessionId) return;
      try {
        activity = state;
        evaluate();
      } catch (caughtError) {
        // A throw here would unwind back through the engine's commitTransition
        // and leave its stale-thinking watchdog unarmed, so this listener must
        // never propagate. Matches activity-interval-recorder's contract.
        console.error(`[turn-completion] activity handler failed for ${sessionId.slice(0, 8)}:`, caughtError);
      }
    };

    const onOutput = (evtSessionId: string): void => {
      if (evtSessionId !== sessionId) return;
      lastOutputAt = Date.now();
      evaluate();
    };

    const onExit = (evtSessionId: string): void => {
      if (evtSessionId !== sessionId) return;
      finish('exited');
    };

    const onAbort = (): void => finish('aborted');

    sessionManager.on('activity', onActivity);
    // The focus-independent seam. `'data'` is gated on renderer focus and the
    // session we are waiting on is usually not the visible terminal, so
    // observing it would report "quiet" for a session that is painting hard.
    sessionManager.on('data-tap', onOutput);
    sessionManager.on('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });

    const hardTimer = setTimeout(() => finish('timeout'), timeoutMs);

    evaluate();
  });
}
