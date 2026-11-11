/**
 * "Edit artifacts" opens a task's edit form at its Artifacts field. The click
 * happens in a menu and the field mounts later, in a window that may not be
 * open yet, so the request waits here by task id and the field takes it when
 * it mounts.
 *
 * A request does not wait for ever. One that its form never took (the form
 * closed before the frame that takes it ran, as it can in a window that is not
 * showing) used to sit here until that task's form next opened, however much
 * later, and opened it scrolled to Artifacts with the add field up.
 */

import { useSessionStore } from '../../stores/session-store';

/** How long a request waits for its form: the click to the mounted field is well under a second. */
export const ARTIFACTS_FOCUS_REQUEST_MS = 10_000;

// hmr-safe: a request lives for the moment between a click and the form it opens; losing one across a Fast Refresh opens the form unscrolled.
const pending = new Map<string, number>();

/** Whether a request waits for this task and is still fresh. A stale one is dropped. */
function isWaiting(taskId: string): boolean {
  const requestedAt = pending.get(taskId);
  if (requestedAt === undefined) return false;
  if (Date.now() - requestedAt <= ARTIFACTS_FOCUS_REQUEST_MS) return true;
  pending.delete(taskId);
  return false;
}

/** Ask the task's Artifacts field to scroll into view and open its add field when it next mounts. */
export function requestArtifactsFocus(taskId: string): void {
  pending.set(taskId, Date.now());
}

/** Whether a request waits for this task. */
export function hasArtifactsFocusRequest(taskId: string): boolean {
  return isWaiting(taskId);
}

/** Whether a request waits for this task, clearing it. */
export function takeArtifactsFocus(taskId: string): boolean {
  const waiting = isWaiting(taskId);
  pending.delete(taskId);
  return waiting;
}

/** From a board card: open the task's window on its edit form, at Artifacts. */
export function openArtifactsEditor(taskId: string): void {
  requestArtifactsFocus(taskId);
  useSessionStore.getState().setDetailTaskId(taskId, { initialEdit: true });
}
