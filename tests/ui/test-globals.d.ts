/**
 * Test-only ambient declarations for window globals exposed by the headless
 * UI mock (`tests/ui/mock-electron-api.js`) and by individual specs.
 *
 * Centralised here so individual specs don't need ad-hoc
 * `as unknown as { __mockBrowser: ... }` casts.
 */
declare global {
  interface Window {
    /** Override `window.electronAPI.platform` per-spec. Set in addInitScript. */
    __mockPlatform?: 'win32' | 'darwin' | 'linux';

    /** Browser-pane mock state hooks. See mock-electron-api.js. */
    __mockBrowser?: {
      reset: () => void;
      getCaptureCalls: () => unknown[];
      getPaneCalls: () => Array<
        | { type: 'register'; input: { sessionId: string; taskId: string; projectId: string | null; webContentsId: number; url: string | null } }
        | { type: 'unregister'; sessionId: string }
      >;
      seedTaskUrl: (taskId: string, url: string) => void;
    };

    /** Captures the URL most recently submitted by BrowserEmptyState mounts. */
    __lastEmptyStateUrl?: string | null;

    /** Records URLs passed to a spec-patched `shell.openExternal`. */
    __openedExternalUrls?: string[];

    /** Release-notes modal mock hooks. See mock-electron-api.js. */
    /** Records `installUpdate()` calls (Restart to update button). */
    __mockInstallUpdateCalls?: unknown[];
    /** Subscribers registered via `updater.onUpdateDownloaded`; fired by `__mockFireUpdateDownloaded`. */
    __mockUpdateDownloadedListeners?: Array<(info: { version: string; releaseNotes: string }) => void>;
    /** Fires the update-downloaded push to every registered subscriber. Installed eagerly at mock-bootstrap time. */
    __mockFireUpdateDownloaded?: (info: { version: string; releaseNotes: string }) => void;
  }
}

export {};
