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
    /** Override `window.electronAPI.arch` per-spec (default 'x64'). Set in addInitScript. */
    __mockArch?: 'x64' | 'arm64';

    /** Browser-pane mock state hooks. See mock-electron-api.js. */
    __mockBrowser?: {
      reset: () => void;
      getCaptureCalls: () => unknown[];
      getPaneCalls: () => Array<
        | { type: 'register'; input: { sessionId: string; taskId: string; projectId: string | null; webContentsId: number; url: string | null; visibility?: string } }
        | { type: 'unregister'; webContentsId: number }
        | { type: 'user-close'; webContentsId: number }
        | { type: 'visibility'; webContentsId: number; visibility: string }
        | { type: 'widget-size'; webContentsId: number; width: number; height: number }
        | { type: 'viewport-clear'; webContentsId: number }
        | { type: 'offscreen-close'; taskId: string; projectId: string | null }
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
      /** Fire main's "these tasks hold their browser surface offscreen" push.
       *  Takes the WHOLE set, as main does. */
      emitOffscreenSurfaces: (taskIds: string[]) => void;
      /** Seed the set a renderer reads on mount, for a surface that already
       *  existed before this renderer did. */
      seedOffscreenSurfaces: (taskIds: string[]) => void;
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

    /** Subscribers registered via `hostMemory.onRecovery`; fired by `__mockFireHostMemoryRecovery`. Installed eagerly at mock-bootstrap time (Sentry DESKTOP-16). */
    __mockHostMemoryRecoveryListeners?: Array<(event: import('../../src/shared/types').HostMemoryRecoveryEvent) => void>;
    /** Fires the host-memory-recovery push to every registered subscriber. Installed eagerly at mock-bootstrap time; silently no-ops if no subscriber has registered yet. */
    __mockFireHostMemoryRecovery?: (event: import('../../src/shared/types').HostMemoryRecoveryEvent) => void;

    /** Subscribers registered via `hostMemory.onAgentPaused`; fired by `__mockFireHostMemoryAgentPaused`. Installed eagerly at mock-bootstrap time. */
    __mockHostMemoryAgentPausedListeners?: Array<(event: import('../../src/shared/types').HostMemoryAgentPausedEvent) => void>;
    /** Fires the low-memory agent-paused push (one agent per call) to every registered subscriber. Installed eagerly at mock-bootstrap time; silently no-ops if no subscriber has registered yet. */
    __mockFireHostMemoryAgentPaused?: (event: import('../../src/shared/types').HostMemoryAgentPausedEvent) => void;

    /** Pushes `automation:runFailed` (main's "an automation did not do what the board says") to every `automations.onRunFailed` subscriber. Installed once the subscription exists; throws if every subscriber has gone. */
    __mockFireAutomationRunFailed?: (failure: import('../../src/shared/types').AutomationRunFailure) => void;
    /** Pushes `workflow:completed` (every task of a workflow reached Done) to every `tasks.onWorkflowCompleted` subscriber. Installed once the subscription exists. */
    __mockFireWorkflowCompleted?: (completed: import('../../src/shared/types').WorkflowCompletedEvent) => void;
    /** Why a running workflow is stalled on a task, by task id: the mock's stand-in for main's run-log read (`listStalledTasks`). */
    __mockWorkflowStalls?: Record<string, string>;
    /** Pushes `workflow:stalled` (a running workflow stalled on a task) to every `tasks.onWorkflowStalled` subscriber. Installed once the subscription exists. */
    __mockFireWorkflowStalled?: (stalled: import('../../src/shared/types').WorkflowStalledEvent) => void;
    /** Pushes `session:idleTimeout` (a session auto-suspended after N idle minutes) to every `sessions.onIdleTimeout` subscriber. Installed once the subscription exists. `projectId` may be omitted by main for a session with no project. */
    __mockFireIdleTimeout?: (sessionId: string, taskId: string, minutes: number, projectId?: string) => void;

    /** Pushes `config:writeFailed`, which App.tsx toasts verbatim as the body under its title, at variant 'error', durationMs 12000. Installed once `config.onWriteFailed` has a subscriber, so wait for the app to mount. */
    __mockFireConfigWriteFailed?: (message: string) => void;

    /** Pushes `leftoverProcesses:report`, which App.tsx turns into the leftover-process toast. Installed once `leftoverProcesses.onReport` has a subscriber, so wait for the app to mount. */
    __mockFireLeftoverReport?: (report: import('../../src/shared/types').LeftoverProcessReport) => void;
    /** Pushes `leftoverProcesses:stopSettled`: the outcome of a Stop the host finished after main stopped waiting. Installed once `leftoverProcesses.onStopSettled` has a subscriber. */
    __mockFireLeftoverStopSettled?: (settled: import('../../src/shared/types').LeftoverStopSettled) => void;
    /** Subscribers of `leftoverProcesses.onStopSettled`. Internal to the mock. */
    __mockLeftoverStopSettledListeners?: Array<(settled: import('../../src/shared/types').LeftoverStopSettled) => void>;
    /** Per process id, what `leftoverProcesses.stop` answers; unlisted ids answer 'stopped'. Read per call. */
    __mockLeftoverStopOutcomes?: Record<string, import('../../src/shared/types').LeftoverStopOutcome>;
    /** Every process id `leftoverProcesses.stop` was called with, in order. */
    __mockLeftoverStopCalls?: string[];
    /** When set to a promise, `leftoverProcesses.stop` awaits it before answering, so a spec can observe the row's Stopping state. Unset by default: the answer comes at once. Read per call. */
    __mockLeftoverStopGate?: Promise<void>;
    /** Settles `__mockLeftoverStopGate`. Set by the spec that creates the gate; the mock never reads it. */
    __mockReleaseLeftoverStopGate?: () => void;
    /** Process ids `leftoverProcesses.check` answers as ended; every other id is still running. Read per call. */
    __mockLeftoverEndedIds?: string[];
    /** The ids of every `leftoverProcesses.check` call, one array per call, in order. */
    __mockLeftoverCheckCalls?: string[][];
    /** When set to a promise, `leftoverProcesses.check` awaits it (after recording the call) before answering, so a spec can hold a recheck in flight. Unset by default: the answer comes at once. Read per call. */
    __mockLeftoverCheckGate?: Promise<void>;
    /** Settles `__mockLeftoverCheckGate`. Set by the spec that creates the gate; the mock never reads it. */
    __mockReleaseLeftoverCheckGate?: () => void;

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

    /** Per-agent patches merged over the mock's `agents.list()` entries (`found: false` for a CLI that is not installed). Read on every call, so a spec can change it mid-test. */
    __mockAgentListOverrides?: Record<string, Record<string, unknown>>;
    /** When true, every `agents.list()` the renderer makes rejects, so the config store's agent list never loads. Main's own read (the mock's start check) still answers. Set in addInitScript. */
    __mockAgentListRejects?: boolean;
    /** How many times the workflow agent pane has called `workflows.agentOpen` (resumes are not counted). */
    __mockWorkflowAgentOpenCount?: number;
    /** When true, the next `workflows.agentOpen` answers `setupNeeded: true` whatever the setting says, then clears itself. Set in addInitScript. */
    __mockWorkflowAgentSetupNeededOnce?: boolean;

    /** When true, the next `tasks.move` hangs until `__mockTaskMoveResolve` runs, then clears itself. Set at runtime. */
    __mockTaskMoveDeferred?: boolean;
    /** Settles the move `__mockTaskMoveDeferred` held. Installed by the mock when it holds one. */
    __mockTaskMoveResolve?: () => void;
    /** Makes the next `tasks.move` commit and then reject with this message, then clears itself. Set at runtime. */
    __mockMoveRejectAfterCommit?: string | null;
    /** Zeroes the mock's IPC call counter. Installed eagerly at mock-bootstrap time, so it is not optional: a missing counter must throw, not skip the reset. */
    __resetIpcCallCounts: () => void;
    /** The mock's watched IPC calls since the last reset, keyed `namespace.method` (`tasks.list`). Installed eagerly at mock-bootstrap time. */
    __getIpcCallCounts: () => Record<string, number>;
    /** Set by a spec's `sessions.suspend` hold once the held call arrives. */
    __suspendHeld?: boolean;
    /** Releases the `sessions.suspend` call a spec is holding. */
    __releaseSuspend?: () => void;
  }
}

export {};
