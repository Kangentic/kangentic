interface PanelSessionCounts {
  /** Sessions the bottom panel could show: running, non-transient, current project
   *  (`derivePanelSessions().active.length`). */
  activeSessionCount: number;
  /** How many of those still have a tab. The rest are detached: a task-detail window
   *  hosts their terminal (`derivePanelSessions().visible.length`). */
  visibleSessionCount: number;
}

interface ForceCollapseInput extends PanelSessionCounts {
  /** Destination project id armed at a project switch when that project has persisted detail
   *  windows that have not finished restoring yet, or null when nothing is pending. */
  pendingDetailWindowsProjectId: string | null;
  /** The project currently shown, used to scope the pending arm: a stale arm for a project we
   *  already left is ignored. */
  currentProjectId: string | null;
}

/**
 * Whether sessions exist but every one of them is detached to a detail window, so the bottom
 * panel has no tab to show.
 *
 * The panel renders nothing at all in this state (`TerminalPanel`'s blank `detached` empty
 * state: no tab bar, no expand control), so AppLayout gives its container no height. A user
 * collapse is a different state and keeps its strip, because that strip carries the tab bar and
 * the expand control.
 */
export function isEveryPanelSessionDetached(counts: PanelSessionCounts): boolean {
  return counts.activeSessionCount > 0 && counts.visibleSessionCount === 0;
}

/** Why the bottom terminal panel is held collapsed, or null when nothing holds it. */
export type TerminalForceCollapse = 'every-session-detached' | 'detail-windows-restoring' | null;

/**
 * Why the bottom terminal panel should render collapsed, if it should.
 *
 * The panel sheds a tab whenever that task's detail is open (a board window, the in-app Agent
 * Monitor, or the detached monitor - see `derivePanelSessions`), so it collapses once nothing is
 * left to show: sessions exist, but every one of them is being driven somewhere else
 * (`every-session-detached`). That collapse takes the panel to zero height, since it has
 * nothing to render. It does NOT collapse when there are no sessions at all - that state keeps
 * its "drag a task into a column" hint, which is the only place a new user is told how to start
 * an agent.
 *
 * The second reason covers a project switch: `pendingDetailWindowsProjectId` is armed for the
 * project now shown while its persisted detail windows are still mid-restore, which keeps the panel
 * collapsed from the first frame instead of flashing expanded before ownership is established
 * (`detail-windows-restoring`). This collapse keeps the usual strip. It is transient, and it snaps
 * rather than animates, because the arm is part of the switch key `useTerminalResize` suppresses
 * the height transition on.
 *
 * AppLayout reads the reason, not just the answer, because only the first one takes the container
 * to zero height. One value carries both, so the two can never disagree.
 */
export function resolveTerminalForceCollapse(input: ForceCollapseInput): TerminalForceCollapse {
  if (isEveryPanelSessionDetached(input)) return 'every-session-detached';
  if (
    input.pendingDetailWindowsProjectId !== null &&
    input.pendingDetailWindowsProjectId === input.currentProjectId
  ) {
    return 'detail-windows-restoring';
  }
  return null;
}

/** Whether the bottom terminal panel should render collapsed, for either reason above. */
export function shouldForceCollapseTerminal(input: ForceCollapseInput): boolean {
  return resolveTerminalForceCollapse(input) !== null;
}
