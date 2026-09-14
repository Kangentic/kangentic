import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { AutomationRunFailure } from '../../shared/types';

/**
 * Tell the user when an automation did not do what the board says it does.
 *
 * Follows `auto-command-outcome.ts` deliberately, because that is the one place
 * in this repo that already solved exactly this shape: the DB row is the
 * durable record, the push event is the interruption, and the interruption is
 * RATIONED. The run rows are written by the runner, whatever happens; this
 * module decides only what earns a toast.
 *
 * Nothing is pushed on success. A board move fires several automations, most of
 * them every time a task moves, so a notice per success would be constant and
 * would say nothing anyone can act on. A FAILURE is different: the user
 * configured a thing that says it always happens, and it did not.
 */

/**
 * One toast per project per automation per minute.
 *
 * The key is the automation, not the task: a bulk move of twelve tasks through
 * one column fails the same webhook twelve times, and twelve identical toasts
 * is the failure mode this cooldown exists to prevent. The run rows still
 * record all twelve, which is where the count belongs.
 *
 * Same shape and same window as `notifySpawnWarning`'s.
 */
const failureCooldowns = new Map<string, number>();
const FAILURE_COOLDOWN_MS = 60_000;

/** Test-only: reset the cooldown map between cases. */
export function __resetAutomationFailureCooldownsForTest(): void {
  failureCooldowns.clear();
}

export interface AutomationFailureNoticeInput {
  window: BrowserWindow | null;
  projectId: string | null | undefined;
  failure: AutomationRunFailure;
}

/**
 * Push one failure notice, if it is not still inside its own cooldown.
 *
 * Returns whether it was sent, which is what the unit test asserts against: a
 * silent-by-cooldown call and a silent-by-destroyed-window call are different
 * facts, and a caller that logs "notified" for both would be wrong.
 */
export function notifyAutomationFailure(input: AutomationFailureNoticeInput): boolean {
  const { window, projectId, failure } = input;
  if (!window || window.isDestroyed()) return false;

  const key = `${projectId ?? 'ambient'}:${failure.automationId}`;
  const lastSent = failureCooldowns.get(key);
  // Explicit undefined check: a truthiness test would treat a cooldown stamped
  // at epoch 0 (a mocked clock in a test) as absent.
  if (lastSent !== undefined && Date.now() - lastSent < FAILURE_COOLDOWN_MS) return false;
  failureCooldowns.set(key, Date.now());

  window.webContents.send(IPC.AUTOMATION_RUN_FAILED, failure);
  return true;
}
