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
  }
}

export {};
