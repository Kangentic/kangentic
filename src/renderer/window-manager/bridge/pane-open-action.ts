/**
 * What the board does with main's open request for a task's Browser pane
 * (`kangentic_browser_open_pane`), after setting the pane's open flag.
 *
 * Pure, because this is the whole decision that keeps an agent from ever putting
 * a window in front of the user, and every branch of it should be pinned. There
 * is no branch here that shows, raises or focuses anything.
 */

export type PaneOpenAction =
  /** A host exists, or none may be made here. The open flag was all it needed. */
  | 'flag-only'
  /** Nothing can hold the pane, so mount it in a window born parked. */
  | 'mount-parked';

export interface PaneOpenFacts {
  /** The project the push names. */
  projectId: string;
  /** The project the board renders, or null. */
  currentProjectId: string | null;
  /** A board window holds this task: visible, parked or retained. A window that
   *  is closed as far as the user knows stays that way, so this never un-parks. */
  hasBoardWindow: boolean;
  /** The task's Browser pop-out window is open. It owns the guest, so a parked
   *  window here would hold nothing and be reaped with its pane unmounted. */
  browserPoppedOut: boolean;
  /** The in-app Agent Monitor shows this task's detail, so its pane mounts there
   *  and a parked window would be a second guest beside it. */
  monitorMountsDetail: boolean;
}

export function resolvePaneOpenAction(facts: PaneOpenFacts): PaneOpenAction {
  // A backgrounded project's board cannot mount its tasks, and main reaches this
  // only with a live pane, since a cold open there comes up offscreen.
  if (facts.currentProjectId !== facts.projectId) return 'flag-only';
  if (facts.hasBoardWindow) return 'flag-only';
  if (facts.browserPoppedOut) return 'flag-only';
  if (facts.monitorMountsDetail) return 'flag-only';
  return 'mount-parked';
}
