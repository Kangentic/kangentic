// The once-per-version decision behind the post-update "What's New" dialog.
// Kept pure (no React, no stores, no window) so it is reachable from the node
// unit tier, the same way src/main/updater-release-notes.ts isolates
// normalizeReleaseNotes from the updater's Electron surface.

export interface WhatsNewLaunchState {
  /** From config-store's `appVersion`. Null until loadAppVersion() resolves. */
  appVersion: string | null;
  /** From config-store's `loading`. True until the first config fetch lands. */
  configLoading: boolean;
  /** AppConfig.lastWhatsNewShownVersion. Empty string when never recorded. */
  lastWhatsNewShownVersion: string;
  /** The build's baked release notes, already trimmed. Empty when there are none. */
  notes: string;
}

/**
 * What the launch check should do this tick.
 *
 * - `wait`   - state has not settled. `appVersion` is null for the first tick
 *              after mount and `configLoading` starts true, so an eager check
 *              would report a spurious version change on every boot.
 * - `record` - mark this version as shown WITHOUT opening: either it is already
 *              recorded, or this build has no notes to show. Recording either
 *              way keeps the check from re-running every launch.
 * - `open`   - the running version changed and there are notes to show.
 */
export function shouldShowWhatsNew(state: WhatsNewLaunchState): 'wait' | 'record' | 'open' {
  if (state.configLoading || state.appVersion === null) return 'wait';
  if (state.lastWhatsNewShownVersion === state.appVersion) return 'record';
  return state.notes ? 'open' : 'record';
}
