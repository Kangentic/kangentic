interface ForceCollapseInput {
  /** Sessions currently owned by an open task-detail window (the live "panel steps aside"
   *  signal). */
  dialogSessionIds: string[];
  /** Destination project id armed at a project switch when that project has persisted detail
   *  windows that have not finished restoring yet, or null when nothing is pending. */
  pendingDetailWindowsProjectId: string | null;
  /** The project currently shown, used to scope the pending arm: a stale arm for a project we
   *  already left is ignored. */
  currentProjectId: string | null;
}

/**
 * Whether the bottom terminal panel should render collapsed because task-detail windows own
 * the terminal surface (the panel and the windows are mutually exclusive terminal owners).
 *
 * True when a detail window is already open (`dialogSessionIds` non-empty), OR when a project
 * switch armed `pendingDetailWindowsProjectId` for the project now shown but its detail windows
 * are still mid-restore. The second clause is what keeps the panel collapsed from the first
 * frame of a switch instead of flashing expanded while `dialogSessionIds` is transiently empty
 * during the async workspace restore.
 */
export function shouldForceCollapseTerminal(input: ForceCollapseInput): boolean {
  if (input.dialogSessionIds.length > 0) return true;
  return (
    input.pendingDetailWindowsProjectId !== null &&
    input.pendingDetailWindowsProjectId === input.currentProjectId
  );
}
