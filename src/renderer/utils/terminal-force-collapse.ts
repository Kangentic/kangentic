interface ForceCollapseInput {
  /** Sessions the bottom panel could show: running, non-transient, current project
   *  (`derivePanelSessions().active.length`). */
  activeSessionCount: number;
  /** How many of those still have a tab. The rest are detached: a task-detail window
   *  hosts their terminal (`derivePanelSessions().visible.length`). */
  visibleSessionCount: number;
  /** Destination project id armed at a project switch when that project has persisted detail
   *  windows that have not finished restoring yet, or null when nothing is pending. */
  pendingDetailWindowsProjectId: string | null;
  /** The project currently shown, used to scope the pending arm: a stale arm for a project we
   *  already left is ignored. */
  currentProjectId: string | null;
}

/**
 * Whether the bottom terminal panel should render collapsed.
 *
 * The panel sheds a tab whenever that task's detail is open (a board window, the in-app Agent
 * Monitor, or the detached monitor - see `derivePanelSessions`), so it collapses once nothing is
 * left to show: sessions exist, but every one of them is being driven somewhere else. It does NOT
 * collapse when there are no sessions at all - that state keeps its "drag a task into a column"
 * hint, which is the only place a new user is told how to start an agent.
 *
 * The second clause covers a project switch: `pendingDetailWindowsProjectId` is armed for the
 * project now shown while its persisted detail windows are still mid-restore, which keeps the panel
 * collapsed from the first frame instead of flashing expanded before ownership is established.
 */
export function shouldForceCollapseTerminal(input: ForceCollapseInput): boolean {
  if (input.activeSessionCount > 0 && input.visibleSessionCount === 0) return true;
  return (
    input.pendingDetailWindowsProjectId !== null &&
    input.pendingDetailWindowsProjectId === input.currentProjectId
  );
}
