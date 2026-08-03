import { useEffect } from 'react';
import { useConfigStore } from '../stores/config-store';
import { useUpdaterStore } from '../stores/updater-store';
import { bakedReleaseNotes } from '../lib/baked-release-notes';
import { shouldShowWhatsNew } from '../lib/should-show-whats-new';

// This guard must SURVIVE Fast Refresh rather than reset with it (so it is
// deliberately not a `// hmr-safe:` opt-out): the team dogfoods from `npm start`,
// and a per-refresh reset would reopen the dialog on every renderer edit. The
// persisted config marker is the durable guard; this only closes the async gap
// between opening the dialog and that write landing.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let whatsNewEvaluated: boolean = import.meta.hot?.data?.whatsNewEvaluated ?? false;

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.whatsNewEvaluated = whatsNewEvaluated;
  });
}

/**
 * Shows the running version's release notes once, on the first launch after the
 * version changes. The counterpart to ReleaseNotesDialog, which can only run
 * BEFORE a restart: a user who takes the fast path (or who lets
 * `autoUpdater.autoInstallOnAppQuit` install on a normal quit) never sees those
 * notes, and after the relaunch `pendingUpdate` is null so nothing can show them.
 *
 * Called once from App.tsx. The status-bar version pill is the way back in.
 */
export function useWhatsNewOnLaunch(): void {
  const appVersion = useConfigStore((state) => state.appVersion);
  const configLoading = useConfigStore((state) => state.loading);
  const lastWhatsNewShownVersion = useConfigStore((state) => state.config.lastWhatsNewShownVersion);

  useEffect(() => {
    if (whatsNewEvaluated) return;

    const decision = shouldShowWhatsNew({
      appVersion,
      configLoading,
      lastWhatsNewShownVersion,
      notes: bakedReleaseNotes,
    });
    if (decision === 'wait') return;

    whatsNewEvaluated = true;

    // Record on OPEN, not on close. Recording on close would recreate the bug
    // this surface exists to fix: a user who quits without closing the dialog
    // would be shown it again on every launch, and the write would race the quit.
    if (lastWhatsNewShownVersion !== appVersion) {
      // Fire-and-forget, matching the other incidental config writes in
      // config-store.ts: failing to record must not block the dialog.
      void useConfigStore
        .getState()
        .updateConfig({ lastWhatsNewShownVersion: appVersion ?? '' })
        .catch(() => undefined);
    }

    if (decision === 'open') {
      useUpdaterStore.getState().openWhatsNew({ autoOpened: true });
    }
  }, [appVersion, configLoading, lastWhatsNewShownVersion]);
}
