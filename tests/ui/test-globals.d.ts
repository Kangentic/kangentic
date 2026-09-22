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
        | { type: 'register'; input: { sessionId: string; taskId: string; projectId: string | null; webContentsId: number; url: string | null; visibility?: string } }
        | { type: 'unregister'; webContentsId: number }
        | { type: 'user-close'; webContentsId: number }
        | { type: 'visibility'; webContentsId: number; visibility: string }
      >;
      seedTaskUrl: (taskId: string, url: string) => void;
      /** The project a task URL was last saved against (null if never saved). */
      getTaskUrlProject: (taskId: string) => string | null;
      /** Fire the main-process zoom broadcast at one specific guest. */
      emitZoomChanged: (factor: number, webContentsId: number) => void;
      /** Fire main's open push, as kangentic_browser_open_pane does. */
      emitPaneOpenRequest: (projectId: string, taskId: string) => void;
      /** Fire main's close push, as kangentic_browser_close_pane does. */
      emitPaneCloseRequest: (projectId: string, taskIds: string[]) => void;
      /** Fire main's agent-input push for one guest (an agent is / is no longer driving it). */
      emitAgentInput: (webContentsId: number, active: boolean) => void;
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
    /** Subscribers registered via `updater.onUpdateBlocked`; fired by `__mockFireUpdateBlocked`. */
    __mockUpdateBlockedListeners?: Array<(message: string) => void>;
    /** Fires the update-blocked push (DESKTOP-1A) to every registered subscriber. Installed eagerly at mock-bootstrap time. */
    __mockFireUpdateBlocked?: (message: string) => void;

    /** Subscribers registered via `notifications.onClicked`; fired by `__mockFireNotificationClicked`. */
    __mockNotificationClickListeners?: Array<(projectId: string, taskId: string) => void>;
    /** Fires the notification-clicked push to every registered subscriber. Installed eagerly at mock-bootstrap time; throws if no subscriber has registered yet. */
    __mockFireNotificationClicked?: (projectId: string, taskId: string) => void;

    /** Pushes a session's agent message trail (`session:messageTrail`) the way main does; also records it for `sessions.getMessageTrails()`. Installed once `onMessageTrail` has a subscriber. */
    __mockFireMessageTrail?: (sessionId: string, entries: Array<{ uuid: string; ts: number; text: string }>, projectId?: string) => void;

    /** The monitor rows the mock serves; replaced wholesale by `__mockFireMonitorChanged`. Rows are loosely typed: specs author them as literals. */
    __mockMonitorRows?: Array<Record<string, unknown> & { sessionId: string }>;
    /** Replaces the monitor rows and pushes a `monitor:changed` snapshot to every subscriber. Installed once `monitor.onChanged` has a subscriber. */
    __mockFireMonitorChanged?: (rows: Array<Record<string, unknown> & { sessionId: string }>) => void;

    /** Subscribers registered via `hostMemory.onPressure`; fired by `__mockFireHostMemoryPressure`. Installed eagerly at mock-bootstrap time (Sentry DESKTOP-16). */
    __mockHostMemoryPressureListeners?: Array<(event: import('../../src/shared/types').HostMemoryPressureEvent) => void>;
    /** Fires the host-memory-pressure push to every registered subscriber. Installed eagerly at mock-bootstrap time; silently no-ops if no subscriber has registered yet. */
    __mockFireHostMemoryPressure?: (event: import('../../src/shared/types').HostMemoryPressureEvent) => void;

    /** Pushes `config:writeFailed`, which App.tsx toasts verbatim at variant 'error', duration 12000. Installed once `config.onWriteFailed` has a subscriber, so wait for the app to mount. */
    __mockFireConfigWriteFailed?: (message: string) => void;

    /** Forces `config.set` / `setProjectOverrides` / `setProjectOverridesByPath` to resolve `{ persisted: false }`, the "write did not reach disk" path the settings panel toasts. Read per call, so it can be flipped mid-test. Set in addInitScript or at runtime. */
    __mockConfigSetPersisted?: boolean;
    /** Makes those same three config setters REJECT with this message, the separate failure the real project-scoped handlers raise for an unknown or unopened project. Set in addInitScript or at runtime. */
    __mockConfigSetRejects?: string;

    /** Pre-seeds the Board Profiles the mock serves from `boardConfig.getBoardProfiles()`. Set in addInitScript. */
    __mockBoardProfiles?: import('../../src/shared/types').BoardProfile[];
    /** Makes `boardConfig.setBoardProfiles()` reject with this message, leaving the seeded list intact so the store's reload still answers. Set in addInitScript or at runtime. */
    __mockBoardProfilesSaveError?: string;

    /** Set by a toast action's onClick in toast-click-through.spec.ts, to prove a real click reached it. */
    __toastActionClicked?: boolean;
    /** Counts calls to a spec-overridden `navigator.clipboard.writeText` in toast-click-through.spec.ts. */
    __clipboardRejectCalls?: number;
  }
}

export {};
