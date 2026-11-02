/**
 * Tell the user a Stop script failed. A broken script leaves a stack running
 * with no other sign of it, and only the user can fix it, so this one fault gets
 * a toast. Main pushes the facts and the renderer words them
 * (`renderer/lib/stop-script-toast.ts`). Rationed per project: a script that
 * fails fails for every task, and one toast says so.
 */

import { IPC } from '../../shared/ipc-channels';
import type { StopScriptFailedEvent } from '../../shared/types';
import type { IpcContext } from '../ipc/ipc-context';

const FAILURE_TOAST_COOLDOWN_MS = 60_000;

const lastToastAtByProject = new Map<string, number>();

export function reportStopScriptFailure(context: IpcContext, event: StopScriptFailedEvent): void {
  if (context.mainWindow.isDestroyed()) return;
  const now = Date.now();
  const lastToastAt = lastToastAtByProject.get(event.projectId);
  if (lastToastAt !== undefined && now - lastToastAt < FAILURE_TOAST_COOLDOWN_MS) return;
  lastToastAtByProject.set(event.projectId, now);
  context.mainWindow.webContents.send(IPC.STOP_SCRIPT_FAILED, event);
}

/** Test-only: forget the cooldowns. */
export function resetStopScriptFailureReportsForTests(): void {
  lastToastAtByProject.clear();
}
