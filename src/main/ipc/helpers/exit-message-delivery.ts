import type { AutoCommandMode } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import type { InjectionReport } from '../../transition-engine/terminal-submit-scheduler';
import type { CommandVerifier } from '../../pty/terminal-submit';

/**
 * Deliver an exit automation's message and WAIT for the keystrokes to land.
 *
 * An exit row's message is the one injection in the app that cannot be
 * fire-and-forget, and the reason is structural rather than a matter of taste.
 * `scheduleKeystrokes` returns as soon as the burst is started, and every
 * Priority branch below the exit hook opens with
 * `terminalSubmitScheduler.cancel(task.id)` before it kills (To Do), suspends
 * (Done, a non-spawning column) or re-points (a live session) the session. So a
 * scheduled exit burst is cancelled a few milliseconds later, mid-burst, by the
 * very move that asked for it.
 *
 * Measured in a preview, against a live session: the run row read
 * `succeeded` / "Delivered" in one millisecond, and the agent received the
 * burst's leading Ctrl+U and nothing else. Ever. The text was never written,
 * because the burst aborted at its first settle. No typecheck or unit test can
 * see that, and the row said it worked.
 *
 * Awaiting the outcome fixes both halves at once: the cancels now run after
 * delivery rather than through it, and the run row records what actually
 * happened instead of what was scheduled.
 *
 * The wait is bounded by `signal`, which is the automation run's own (the
 * move's signal combined with this row's slice of the 60s exit budget). That
 * cap is why holding the short lock here is acceptable: the same budget that
 * bounds a hung exit script bounds a hung exit message.
 */
export function deliverExitMessage(
  context: IpcContext,
  taskId: string,
  sessionId: string,
  message: string,
  mode: AutoCommandMode,
  verifier: CommandVerifier | null,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };

    // The budget or a superseding move. The burst itself is not cancelled
    // here: the runner already passed this signal down, and the scheduler's
    // own cancel paths belong to the move, not to us.
    function onAbort(): void {
      finish(new Error('The message was not delivered before the exit budget ran out.'));
    }
    signal.addEventListener('abort', onAbort, { once: true });

    context.terminalSubmitScheduler.scheduleKeystrokes(
      taskId,
      sessionId,
      [{ text: message, verify: 'submitted' }],
      {
        mode,
        verifier,
        onOutcome: (report: InjectionReport) => {
          // `unconfirmed` is a success: eleven of twelve adapters have no
          // submission verifier, so treating "could not be checked" as a
          // failure would fail the row on every agent but Claude.
          if (report.outcome === 'confirmed' || report.outcome === 'unconfirmed') {
            finish(null);
            return;
          }
          finish(new Error(report.reason ?? `The message was ${report.outcome}.`));
        },
      },
    );
  });
}
