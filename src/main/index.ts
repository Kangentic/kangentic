const PROCESS_START = performance.now();

import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, powerMonitor, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { registerAllIpc, getSessionManager, getTerminalSubmitScheduler, getBoardConfigManager, getCurrentProjectId, getOptionalIpcContext, openProjectByPath, deleteProjectFromIndex, pruneStaleWorktreeProjects, activateAllProjects, getLastOpenedProject } from './ipc/register-all';
import { installDiagnostics } from './diagnostics/install';
import { startEventLoopLagMonitor } from './diagnostics/event-loop-lag';
// Dev-only (dropped from prod via __KANGENTIC_DEV__ dead-code elimination).
import { createPreviewClone, fillPreviewClone, registerEphemeralProjectDevIpc } from '../devtools/main/ephemeral-projects';
import { resolvePreviewTaskLabel } from '../devtools/main/preview-task-title';
import { registerSeedGitChangesDevIpc } from '../devtools/main/seed-git-changes';
import { registerSeedEmbeddingBacklogDevIpc } from '../devtools/main/seed-embedding-backlog';
import { registerSeedLargeConversationDevIpc } from '../devtools/main/seed-large-conversation';
import { registerSeedUsageDataDevIpc } from '../devtools/main/seed-usage-data';
import { installDevtools } from '../devtools/install';
import { startMcpHttpServer, type McpHttpServerHandle } from './agent/mcp-http-server';
import { readBrowserAutomationConfig } from './browser/browser-automation-config';
import { browserPaneRegistry } from './browser/browser-pane-registry';
import { setAgentInputSender, isAgentDriving } from './browser/agent-input-signal';
import { encodeTerminalKey } from '../shared/terminal-key-encoding';
import { createRequestResolver } from './agent/mcp-project-context';
import { IPC, PROJECT_PATH_MISSING_PREFIX } from '../shared/ipc-channels';
import { ConfigManager } from './config/config-manager';
import { isShuttingDown, setShuttingDown } from './shutdown-state';
import { isBenignStreamWriteError } from './diagnostics/benign-stream-error';
const windowConfigManager = new ConfigManager();
import { initAnalytics, trackEvent, sanitizeErrorMessage, shouldEmitHeartbeat, setAnalyticsClientId } from './analytics/analytics';
import { resolveClientId } from './analytics/client-id';
import { PATHS } from './config/paths';
// Whether this launch found an existing global config.json. Read at module
// scope, before anything can call ConfigManager.save(): this is the only
// reliable way to tell a fresh install from an upgrade, since on an existing
// machine the file is there but simply lacks any newly-added key, and after the
// first save() the two cases are indistinguishable. Consumed by the What's New
// seed in app.whenReady(). An instance flag on ConfigManager would not do -
// this file's manager and the lazily-built one in ipc/register-all.ts would
// disagree depending on which happened to load first.
//
// Placement is readability only. esbuild bundles every imported module's
// top-level code ABOVE this file's own statements, so sitting here rather than
// beside windowConfigManager changes nothing about when this runs. The real
// invariant is that no module in the import graph writes PATHS.configFile at
// module scope: ConfigManager.save() is its only writer, and every call site is
// inside a function. Adding a module-scope config write anywhere upstream would
// break this silently, wherever this line sits. Note that load() counts as such
// a write on a fresh install - its windowLightDismiss migration saves the
// one-shot marker there - so a module-scope load() breaks this too.
const configFileExistedAtLaunch = fs.existsSync(PATHS.configFile);
import { initStartupTimer, mark, phase, endPhase, finishStartupTimer } from './startup-timer';
import { resolveBackgroundColor, resolveIconPath, resolveWindowBounds, resolveRendererIndexPath, computeWindowTitle } from './window-utils';
import { popOutWindowManager } from './pop-out/pop-out-window-manager';
import { destroyAllLanes } from './browser/browser-lane-manager';
import { sweepOrphanedBrowserPartitions } from './browser/browser-partition-cleanup';
import { loadReactDevTools } from './devtools';
import { syncShutdownCleanup, startHardShutdownFailsafe } from './shutdown';
import { prRefreshScheduler } from './pr/pr-refresh-scheduler';
import { retrievalService } from './retrieval/retrieval-service';
import { lineCountClient } from './git/line-count/line-count-client';
import { setProjectDbInitializer } from './db/database';
import { setWorktreeRemovedListener } from './git/worktree-manager';
import { notifyAdaptersWorktreeRemoved } from './ipc/helpers/task-cleanup';
import { loadVecExtension } from './retrieval/vec-extension';
import { restoreShellEnv } from './shell-env';
import { isFirstPartyPermissionAllowed, isEmbeddedBrowserPermissionAllowed } from './permission-policy';
import { EXTERNAL_OPEN_SCHEMES, isAllowedExternalUrl } from '../shared/external-url';
import { MIN_ZOOM, MAX_ZOOM } from '../shared/zoom-steps';
import { defaultDeveloperFlag, type DeveloperFlagKey } from '../shared/developer-flag-defaults';
import {
  createExternalWindowOpenHandler,
  createWebviewWindowOpenHandler,
  hardenWebviewPopupWindow,
  MAX_LIVE_POPUPS_PER_PANE,
  type WebviewPopupPolicy,
} from './window-open-policy';
import { installWebviewDownloadPolicy } from './browser/webview-download-policy';

initStartupTimer(PROCESS_START);
mark('process_start');

// Dev-only freeze flight recorder: start sampling main-process event-loop lag
// as early as possible so a stall during boot or normal operation is recorded
// for the inspection server's /event-loop-lag route. Dead-code-eliminated in
// production via __KANGENTIC_DEV__.
if (__KANGENTIC_DEV__) startEventLoopLagMonitor();

// Install product diagnostics (log mirror, crash capture, IPC recorder,
// debug-dump path resolver) BEFORE any IPC handler registers. The recorder
// patches `ipcMain.handle` once and every subsequent registration flows
// through the patched path - must happen before `registerAllIpc()` runs.
//
// The lazy callbacks defer the actual project-root and toggle reads until
// the moment something is being persisted, so this is safe to call before
// the IPC context or any project is initialized.
installDiagnostics({
  getProjectRoot: () => getOptionalIpcContext()?.currentProjectPath ?? null,
  getActivityDebugOverlayEnabled: () =>
    safeReadDeveloperFlag('activityDebugOverlay'),
  getPersistConsoleLogs: () =>
    safeReadDeveloperFlag('persistConsoleLogs'),
  getRecordIpcTraffic: () =>
    safeReadDeveloperFlag('recordIpcTraffic'),
});

function safeReadDeveloperFlag(key: DeveloperFlagKey): boolean {
  try {
    const ctx = getOptionalIpcContext();
    const manager = ctx?.configManager ?? windowConfigManager;
    const stored = manager.load().developer?.[key];
    if (stored !== undefined) return stored === true;
    // Default values when the user has never touched the toggle. An explicit
    // stored value always wins (checked above). The decision logic itself
    // lives in the dependency-free `defaultDeveloperFlag` (src/shared/) so it
    // is unit-testable without importing this Electron entry-point module -
    // see the doc comment there for the reasoning behind each key's default.
    return defaultDeveloperFlag(key, __KANGENTIC_DEV__, isEphemeral);
  } catch {
    return false;
  }
}

// Dev-only: register the localhost inspection bridge's shutdown hook +
// store the runtime context. The bridge does NOT start here - it starts
// when `applyRuntimeConfig()` fires after PROJECT_OPEN (or when the
// `developer.previewInspectionServer` toggle flips ON later, since
// applyRuntimeConfig also runs on every CONFIG_SET). The whole
// `src/devtools/` tree is dropped from production builds via
// `__KANGENTIC_DEV__` dead-code elimination + esbuild tree-shaking.
if (__KANGENTIC_DEV__) {
  // `mainWindow` is declared as `let` lower in this file (around line 230)
  // and assigned inside `createWindow()`. The arrow-function callbacks
  // below close over it but only READ at call time (not at definition);
  // every caller (notifyDevtoolsRefresh, the inspection server's HTTP
  // handlers, the before-quit hook) runs strictly after createWindow has
  // assigned the variable, so the TDZ never trips at runtime.
  installDevtools({
    app,
    getMainWindow: () => mainWindow,
    // The preview lockfile is the per dev-session (per-worktree) instance identity,
    // so it must anchor to the worktree (getCwdArg), NOT the current project - which
    // in /preview is now a clone under .kangentic/data. Otherwise the lockfile drifts
    // onto the clone and the devtools bridge/MCP (keyed by worktree path) can't find
    // it. Falls back to the current project when no --cwd is set (e.g. npm start).
    getProjectRoot: () => getCwdArg() ?? getOptionalIpcContext()?.currentProjectPath ?? null,
    getProjectId: () => getOptionalIpcContext()?.currentProjectId ?? null,
    getWorktreePath: () => getCwdArg() ?? getOptionalIpcContext()?.currentProjectPath ?? null,
    getSessionManager: () => getOptionalIpcContext()?.sessionManager ?? null,
    getIpcContext: () => getOptionalIpcContext() ?? null,
    getInspectionServerEnabled: () => safeReadDeveloperFlag('previewInspectionServer'),
    getEvalEnabled: () => safeReadDeveloperFlag('previewEvalEnabled'),
  });
}

// Global error handlers -- keep the app running through transient IPC/PTY errors.
// During shutdown, skip analytics calls to avoid new network requests that block exit.
//
// Benign shutdown-window write errors (EAGAIN/EPIPE/ERR_IPC_CHANNEL_CLOSED) can
// bubble from async pipe write completions when a PTY pipe or IPC channel is
// torn down while a write is still in flight. writeExitSequence's try/catch only
// traps sync throws; node-pty does not expose its internal pipe handle so we
// cannot attach an 'error' listener there. Suppressing these at the global
// handler is the narrowest fix: the filter requires isShuttingDown()=true AND
// a known-benign code, so normal-operation errors still log and fire analytics.
function isBenignShutdownStreamError(error: unknown): boolean {
  if (!isShuttingDown()) return false;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EAGAIN' || code === 'EPIPE' || code === 'ERR_IPC_CHANNEL_CLOSED';
}

// Suppress an uncaught error from the echo/telemetry path. Two cases:
//   1. A shutdown-window stream/IPC teardown error (above).
//   2. A recurring stdio `write EAGAIN`/EPIPE during NORMAL operation - the
//      Windows `npm start` TTY artifact. Echoing it via console.error here
//      would itself write to the same TTY and re-trigger the error (the
//      observed "batches of 2-3"), so the echo AND telemetry are skipped.
//      Scoped to `syscall === 'write'` so real faults still report.
function isSuppressibleUncaughtError(error: unknown): boolean {
  return isBenignShutdownStreamError(error) || isBenignStreamWriteError(error);
}

process.on('uncaughtException', (error) => {
  if (isSuppressibleUncaughtError(error)) return;
  console.error('[APP] Uncaught exception:', error);
  if (!isShuttingDown()) {
    trackEvent('app_error', {
      source: 'uncaughtException',
      message: sanitizeErrorMessage(error.message),
    });
  }
});
process.on('unhandledRejection', (reason) => {
  if (isSuppressibleUncaughtError(reason)) return;
  console.error('[APP] Unhandled rejection:', reason);
  if (!isShuttingDown()) {
    trackEvent('app_error', {
      source: 'unhandledRejection',
      message: sanitizeErrorMessage(reason instanceof Error ? reason.message : String(reason)),
    });
  }
});

import { initUpdater, updateUpdaterWindow, stopUpdaterTimers } from './updater';
import { initAnnouncements, updateAnnouncementsWindow, stopAnnouncementTimers } from './announcements';
import { ensureSpawnHelperPermissions } from './pty/spawn/spawn-helper-permissions';

// Initialize anonymous analytics BEFORE app.whenReady() -- the SDK requires this
// to register protocol schemes. The analytics module decides whether to activate
// based on app.isPackaged and the KANGENTIC_TELEMETRY env var.
initAnalytics();

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// Separate user data directory for preview instances to avoid disk cache conflicts
for (const arg of process.argv) {
  if (arg.startsWith('--user-data-dir=')) {
    app.setPath('userData', arg.slice('--user-data-dir='.length));
    break;
  }
}

// Set Windows AppUserModelID so the taskbar resolves the correct icon.
// In packaged builds, this must match the appId in electron-builder.yml so
// Windows links the running process to the Start Menu shortcut icon. In dev,
// use a separate AUMID to avoid poisoning the icon cache.
app.setAppUserModelId(
  app.isPackaged ? 'com.kangentic.app' : 'com.kangentic.dev'
);

const appLaunchTime = Date.now();
const isEphemeral = process.argv.includes('--ephemeral');
const isE2ETest = process.env.NODE_ENV === 'test';

// Dev-only: the original task's label (`#<id> - <title>`) for a `/preview` window,
// resolved once from the real parent project DB (the preview clones never contain it).
// Surfaced to the renderer via additionalArguments so the title bar can identify the task
// both clones belong to, and reused verbatim as the OS window title so the taskbar
// thumbnail says the same thing. Memoized; null outside dev-preview or when resolution
// misses (graceful).
let cachedPreviewTaskTitle: string | null | undefined;
function getPreviewTaskTitle(): string | null {
  if (cachedPreviewTaskTitle === undefined) {
    // `--cwd` is the usual source, but `/preview --fresh` deliberately omits it so the app
    // opens on the Welcome Screen with no project - which used to drop the title pill and
    // leave a fresh preview window unidentifiable next to the others. The app still RUNS
    // from inside the worktree either way, so fall back to the process cwd and then the
    // app path. Resolution is a pure path/DB lookup, so trying several costs nothing and
    // each one independently returns null when it does not look like a worktree.
    const worktreeCandidates = __KANGENTIC_DEV__ && isEphemeral
      ? [getCwdArg(), process.cwd(), app.getAppPath()]
      : [];
    cachedPreviewTaskTitle = worktreeCandidates.reduce<string | null>(
      (resolved, candidate) => resolved ?? (candidate ? resolvePreviewTaskLabel(candidate) : null),
      null,
    );
  }
  return cachedPreviewTaskTitle;
}

// Harden any <webview> tags attached to the renderer (embedded browser pane).
// `will-attach-webview` fires before the webview is created and lets us
// strip dangerous webPreferences and validate the initial src. The
// per-contents handlers below run after attach, on the webview's own
// webContents.
//
// - Strip nodeIntegration and any preload script the renderer attempts to set.
// - Force contextIsolation + sandbox.
// - Allow only http(s): src URLs; deny file://, chrome://, kangentic:// etc.
// - Deny window.open() inside the embedded page (popups become no-ops).
// - Deny in-webview navigations to non-http(s) schemes.
// - Capture F5 / Ctrl+R / Cmd+R for reload (parent-renderer keydown can't see
//   webview keystrokes - they fire inside the webview's own webContents).
app.on('web-contents-created', (_event, contents) => {
  // will-attach-webview fires on the HOST contents, before the webview attaches.
  // Strip webPreferences and validate src here.
  contents.on('will-attach-webview', (_attachEvent, webPreferences, params) => {
    delete (webPreferences as Record<string, unknown>).preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;

    let allowed = false;
    try {
      const parsed = new URL(params.src);
      allowed = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      allowed = false;
    }
    if (!allowed) {
      // Replacing src (rather than preventing the attach) keeps the
      // <webview> mounted but blank, which is easier for the renderer to
      // recover from than a thrown attach error.
      params.src = 'about:blank';
    }
  });

  // Non-webview contents (the main window, and any pop-out window - both fire
  // web-contents-created) get the shared external-window-open policy (see
  // createExternalWindowOpenHandler for the full rationale).
  if (contents.getType() !== 'webview') {
    contents.setWindowOpenHandler(createExternalWindowOpenHandler((url) => shell.openExternal(url)));
    return;
  }

  // Forward the guest's mouse BACK / FORWARD buttons to the host renderer.
  //
  // A guest is an out-of-process frame and consumes the mouse outright: measured
  // on a live guest, one real back-button press produced 31 events inside the
  // page and ZERO on the host window. So while the page has focus, no renderer
  // listener can see the button that push-to-talk and back-navigation both live
  // on - both were simply dead there.
  //
  // `input-event` is the hook that does see it, and it reports a real
  // mouseDown/mouseUp PAIR for `button: 'back'` (measured: a 1534ms hold), which
  // is what makes push-to-HOLD work rather than only a one-shot toggle. It is
  // observational - there is no `preventDefault` - so the page still receives the
  // button too. That is acceptable: Chromium does not navigate a `<webview>` on
  // it (verified), which is why back-navigation had to be built by hand at all.
  //
  // `mouseLeave` releases anything still held. Also measured: a press whose
  // pointer left the webview before release reported the DOWN and never an UP,
  // which without this would strand dictation recording forever.
  //
  // A DESTROYED guest is the other way an UP goes missing - closing the pane
  // mid-hold takes the only thing that could report the release with it. That
  // matters more than it looks: `useDictation` is mounted once app-wide, so a
  // missing UP leaves `activeRef` true and the microphone open, and every later
  // press is then swallowed by its own re-entrancy guard until dictation is
  // toggled off and on again. `releaseHost` exists because `hostWebContents` is
  // unreachable once `destroyed` has fired, so the last host that took a send is
  // remembered while it still can be.
  const heldGuestButtons = new Set<'back' | 'forward'>();
  let releaseHost: Electron.WebContents | null = null;
  const sendGuestMouseButton = (button: 'back' | 'forward', phase: 'down' | 'up'): void => {
    const host = contents.hostWebContents;
    if (!host || host.isDestroyed()) return;
    releaseHost = host;
    host.send(IPC.BROWSER_GUEST_MOUSE_BUTTON, {
      webContentsId: contents.id,
      button,
      phase,
      // Stamped in MAIN. The renderer measures tap-vs-hold from these, and its
      // own clock is congested by the very work a press kicks off (mic
      // permission, engine start, AudioWorklet load), which would inflate a tap
      // into a hold.
      at: Date.now(),
    });
  };

  contents.on('input-event', (_inputEventHandle, input) => {
    // Only `button` is widened. Electron types it `'left'|'middle'|'right'`,
    // which the runtime payload contradicts (see the channel comment); `type` is
    // already a correct literal union and stays checked.
    const event = input as Electron.InputEvent & { button?: string };
    if (event.type === 'mouseLeave') {
      for (const held of heldGuestButtons) sendGuestMouseButton(held, 'up');
      heldGuestButtons.clear();
      return;
    }
    const button = event.button === 'back' ? 'back' : event.button === 'forward' ? 'forward' : null;
    if (!button) return;
    if (event.type === 'mouseDown') {
      heldGuestButtons.add(button);
      sendGuestMouseButton(button, 'down');
    } else if (event.type === 'mouseUp') {
      heldGuestButtons.delete(button);
      sendGuestMouseButton(button, 'up');
    }
  });

  // Popups from the pane: allowed, hardened, and chromed with their real origin.
  // Denying them outright made every popup-based sign-in (OAuth on most SaaS
  // apps) present as a dead button. See embedded-browser.md decisions 10 to 12
  // for what the allow costs and how each cost is paid.
  //
  // The budget lives in THIS closure so it dies with the guest: a runaway page
  // cannot spawn OS windows without bound, and a pane that closes takes its
  // counter with it rather than leaking a permanently-exhausted budget.
  // Counts popups GRANTED, not popups materialized. `onPopupOpened` runs from
  // `did-create-window`, which is after the open handler has already answered -
  // so a page calling `window.open` several times in a row would clear a
  // materialized-count check every time and blow straight past the cap. The
  // grant is the thing being rationed, so the grant is what is counted.
  let grantedPopupCount = 0;
  const popupPolicy: WebviewPopupPolicy = {
    guestSession: contents.session,
    resolveParentWindow: () => BrowserWindow.fromWebContents(contents.hostWebContents ?? contents),
    hasPopupBudget: () => grantedPopupCount < MAX_LIVE_POPUPS_PER_PANE,
    onPopupGranted: () => { grantedPopupCount += 1; },
    onPopupOpened: (popupWindow) => {
      // Released when the window goes, so a user closing a sign-in window frees
      // its slot. A grant that never becomes a window (denied downstream, or a
      // navigation that never happens) is the one case that leaks a slot until
      // the pane closes, which is acceptable for a runaway guard.
      popupWindow.once('closed', () => {
        grantedPopupCount = Math.max(0, grantedPopupCount - 1);
      });
    },
    showSignInRefusalPrompt: (popupWindow, refusal) => {
      void dialog.showMessageBox(popupWindow, {
        type: 'warning',
        title: `${refusal.provider} returned a sign-in error`,
        message: `${refusal.provider} would not complete this sign-in.`,
        detail:
          `${refusal.provider} blocks sign-in from apps that embed a browser, which is the usual `
          + 'cause here. You can open the sign-in page in your default browser, but signing in there '
          + 'does not sign you in inside this pane. To use the pane itself, sign in with a different '
          + 'method on that site.',
        buttons: ['Open in my browser', 'Close'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response !== 0) return;
        if (!isAllowedExternalUrl(refusal.signInUrl, EXTERNAL_OPEN_SCHEMES)) return;
        shell.openExternal(refusal.signInUrl).catch((openError) => {
          console.warn(`[WINDOW_OPEN] shell.openExternal failed for ${refusal.signInUrl}`, openError);
        });
      }).catch((dialogError) => {
        // `.catch`, not a bare `void`: showMessageBox REJECTS when its parent
        // window is destroyed while the box is still up (closing the popup, or
        // the pane, mid-prompt). Unhandled, that reaches the process-level
        // rejection handler and is reported as an `app_error` telemetry event,
        // turning an expected outcome into crash signal. Same reasoning as
        // `createExternalWindowOpenHandler` in window-open-policy.ts.
        console.warn('[WINDOW_OPEN] sign-in refusal dialog failed', dialogError);
      });
    },
  };

  contents.setWindowOpenHandler(createWebviewWindowOpenHandler(popupPolicy));

  // ORDERING, load-bearing. `did-create-window` fires on the EMBEDDER after
  // `web-contents-created` has already fired for the popup - and because a
  // popup's `getType()` is 'window', not 'webview', that handler has already
  // given it `createExternalWindowOpenHandler`. This runs later and
  // `setWindowOpenHandler` is a setter, so the webview policy wins. Do not move
  // popup hardening earlier. The consolation is that a popup which somehow never
  // reaches here still cannot spawn a bare chrome-less window.
  //
  // Our popup is sandboxed, so Electron passes the guest webContents in rather
  // than navigating first: listeners attached here land before its first
  // navigation.
  contents.on('did-create-window', (popupWindow, popupDetails) => {
    console.log(`[BROWSER_POPUP] pane webContents=${contents.id} opened a popup for ${popupDetails.url}`);
    hardenWebviewPopupWindow(popupWindow, popupDetails.url, popupPolicy);
  });

  // Deny permission requests (camera, mic, geolocation, notifications, ...) on
  // the embedded pane. The pane is for viewing dev servers, which need none of
  // these, and agent-driven navigation could otherwise reach a page that
  // auto-prompts. (embedded-browser.md decision log items 5 and 14.)
  //
  // BOTH handlers, reading one predicate. Only the request handler existed
  // before, so a synchronous permission CHECK fell through to Electron's default
  // instead of the pane's policy. Set on the SESSION, so the popups above - which
  // share the guest's Session object - inherit both with no extra wiring.
  contents.session.setPermissionRequestHandler((_requestingContents, permission, callback) =>
    callback(isEmbeddedBrowserPermissionAllowed(permission)));
  contents.session.setPermissionCheckHandler((_requestingContents, permission) =>
    isEmbeddedBrowserPermissionAllowed(permission));

  // Downloads: saved to the OS Downloads folder rather than denied or left to
  // Chromium's native save dialog (which can block an agent-driven pane).
  // Installed once per Session; see the module for why that guard is mandatory.
  installWebviewDownloadPolicy(contents.session);

  contents.on('will-navigate', (navigationEvent, urlString) => {
    try {
      const parsed = new URL(urlString);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        navigationEvent.preventDefault();
      }
    } catch {
      navigationEvent.preventDefault();
    }
  });

  contents.on('before-input-event', (inputEvent, input) => {
    if (input.type !== 'keyDown') return;

    // THE USER IS TYPING WHILE AN AGENT DRIVES THIS PANE.
    //
    // A CDP click hands the guest real focus as a side effect, so for the length
    // of a drive the user's keystrokes would go into the page - text flowing out
    // of their terminal and into a web form, which is the kind of thing that
    // costs trust permanently.
    //
    // An event arriving here during a drive is the USER'S, because CDP input does
    // not travel this path. Validated on Electron 41 against a live guest with a
    // positive control in the log itself: across a 120-round drive (~3400
    // dispatched keys) this handler fired ZERO times, while the user's own
    // `Shift` and `Control` presses came through it during the same runs.
    //
    // An earlier attempt to attribute each key individually was built on the
    // opposite reading and removed once the control proved it wrong. Do not
    // reintroduce per-key attribution without re-running that measurement - the
    // instrument needs its own positive control, since an empty log otherwise
    // reads identically to a broken logger.
    // See `.claude/rules/agent-driven-focus.md`.
    if (isAgentDriving(contents.id)) {
      // Never touch input mid-composition. An IME (Chinese, Japanese, Korean,
      // and dead keys on many European layouts) builds a character over several
      // keystrokes that only mean something to the composition session, and
      // `preventDefault` on one of them corrupts the sequence. There is also
      // nothing sensible to forward: the composed result arrives separately, not
      // as `input.key`. Letting these through means a composing user's text can
      // reach the page during a drive - narrower and far more recoverable than
      // breaking text entry for everyone who uses an IME.
      if (input.isComposing) return;

      inputEvent.preventDefault();
      const encoded = encodeTerminalKey({
        key: input.key,
        control: input.control,
        alt: input.alt,
        meta: input.meta,
        shift: input.shift,
      });
      const hostWindow = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents);
      if (encoded !== null && hostWindow && !hostWindow.isDestroyed()) {
        hostWindow.webContents.send(IPC.BROWSER_USER_KEY_DURING_DRIVE, contents.id, encoded);
      }
      return;
    }

    const isF5 = input.key === 'F5';
    const isCtrlR = (input.control || input.meta) && (input.key === 'r' || input.key === 'R');
    if (isF5 || isCtrlR) {
      inputEvent.preventDefault();
      contents.reload();
    }
  });

  // Ctrl+wheel inside the webview: Electron emits `zoom-changed` on the
  // guest webContents as a request - the host must actually apply the zoom.
  // Without this, Ctrl+wheel in the embedded browser does nothing (the event
  // is documented on WebContents, NOT on the <webview> DOM tag, so a
  // renderer-side listener never fires). We respond with a smooth ~10% step
  // (Chrome-like), clamp to MIN_ZOOM..MAX_ZOOM, and notify the renderer so
  // the toolbar % stays in sync.
  const WHEEL_ZOOM_STEP = 1.1;
  contents.on('zoom-changed', (_zoomEvent, zoomDirection) => {
    const currentFactor = contents.getZoomFactor();
    const targetFactor = zoomDirection === 'in'
      ? currentFactor * WHEEL_ZOOM_STEP
      : currentFactor / WHEEL_ZOOM_STEP;
    const clampedFactor = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, targetFactor));
    contents.setZoomFactor(clampedFactor);
    // Route the zoom readout to the window that actually HOSTS this webview guest - the
    // main window for the in-app pane, or a pop-out window for a detached Browser pane -
    // so the pop-out's toolbar % stays synced with Ctrl+wheel zoom. Sending to mainWindow
    // unconditionally would leave a popped-out pane's readout stale (its BrowserPane is
    // the only listener, and the main window's in-app pane is unmounted while popped out).
    const hostWindow = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents);
    if (hostWindow && !hostWindow.isDestroyed()) {
      // Carry the guest's own id: one window can host SEVERAL Browser panes (a
      // second task's window, or a pane retained for a backgrounded project), and
      // a factor-only broadcast makes every one of them adopt a zoom the user
      // applied to just one.
      hostWindow.webContents.send(IPC.BROWSER_ZOOM_CHANGED, clampedFactor, contents.id);
    }
  });

  // Keep the browser-pane registry honest from the guest's own lifecycle.
  // The renderer registers/unregisters each pane (it knows the taskId), but a
  // hard reload can skip the renderer's unmount cleanup, so the guest's own
  // `destroyed` is the reliable removal signal and `did-navigate` keeps the
  // tracked URL fresh without a renderer round-trip. `contents.id` is the same
  // id the renderer reports via `getWebContentsId()`.
  contents.on('destroyed', () => {
    browserPaneRegistry.unregisterByWebContentsId(contents.id);
    // Release anything still held, for the same reason `mouseLeave` does: a
    // press the guest can no longer report an UP for would otherwise strand
    // dictation recording. `contents.id` is read here already, so it survives
    // the teardown; `hostWebContents` does not, hence the remembered host.
    if (heldGuestButtons.size === 0 || !releaseHost || releaseHost.isDestroyed()) return;
    for (const held of heldGuestButtons) {
      releaseHost.send(IPC.BROWSER_GUEST_MOUSE_BUTTON, {
        webContentsId: contents.id,
        button: held,
        phase: 'up',
        at: Date.now(),
      });
    }
    heldGuestButtons.clear();
  });
  contents.on('did-navigate', (_navigationEvent, navigatedUrl) => {
    browserPaneRegistry.updateUrlByWebContentsId(contents.id, navigatedUrl);
  });
});

// Route the "an agent is driving this guest" signal to the window that HOSTS the
// guest - the main window for a docked pane, a pop-out window for a detached one
// - exactly as the zoom readout above is routed, and for the same reason: the
// pane that has to restore focus lives in that renderer, not necessarily in the
// main one. See `.claude/rules/agent-driven-focus.md`.
setAgentInputSender((guest, active) => {
  if (guest.isDestroyed()) return;
  const hostWindow = BrowserWindow.fromWebContents(guest.hostWebContents ?? guest);
  if (!hostWindow || hostWindow.isDestroyed()) return;
  hostWindow.webContents.send(IPC.BROWSER_AGENT_INPUT, guest.id, active);
});

// Enforce single instance -- prevents manual double-launches from spawning
// duplicate windows. Ephemeral instances (worktree previews) and E2E test
// instances skip this so they can coexist with a running dogfooding app.
if (!isEphemeral && !isE2ETest) {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.exit(0);
  } else {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }
}

let mainWindow: BrowserWindow | null = null;
let activateAllProjectsTimer: ReturnType<typeof setTimeout> | null = null;
let mcpServerHandle: McpHttpServerHandle | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// Parse --cwd=<path> from command line args
function getCwdArg(): string | null {
  for (const arg of process.argv) {
    if (arg.startsWith('--cwd=')) {
      return arg.slice(6);
    }
  }
  return null;
}

// Re-export for external consumers (e.g. updater module)
export { resolveIconPath } from './window-utils';

// Build and show the standard (non-image) right-click context menu with Copy,
// Paste, and Select All. When the click lands inside a terminal or a Monaco
// diff editor, Copy and Select All are dispatched as CustomEvents the
// renderer's own handlers act on: document.execCommand is unreliable for Copy
// there (Menu.popup steals document focus before the click handler runs) and
// simply does not work for Select All (Monaco keeps its own selection model
// entirely outside the browser's native document Selection, so
// execCommand('selectAll') is a no-op over it). Everywhere else falls back to
// the document's native execCommand.
function showTerminalAwareContextMenu(
  wc: Electron.WebContents,
  params: Electron.ContextMenuParams,
): void {
  const { x, y } = params;

  const template: Electron.MenuItemConstructorOptions[] = [];

  template.push(
    {
      label: 'Copy',
      accelerator: 'CmdOrCtrl+C',
      enabled: params.editFlags.canCopy || true,
      click: () => {
        wc.executeJavaScript(`
          (function() {
            var el = document.elementFromPoint(${x}, ${y});
            if (el && el.closest('.xterm')) {
              window.dispatchEvent(new CustomEvent('terminal-copy', { detail: { x: ${x}, y: ${y} } }));
            } else if (el && el.closest('.monaco-diff-editor')) {
              window.dispatchEvent(new CustomEvent('diff-copy', { detail: { x: ${x}, y: ${y} } }));
            } else {
              document.execCommand('copy');
            }
          })()
        `);
      },
    },
    {
      label: 'Paste',
      accelerator: 'CmdOrCtrl+V',
      enabled: params.editFlags.canPaste,
      click: () => {
        wc.executeJavaScript(`
          (function() {
            var el = document.elementFromPoint(${x}, ${y});
            if (el && el.closest('.xterm')) {
              window.dispatchEvent(new CustomEvent('terminal-paste', { detail: { x: ${x}, y: ${y} } }));
            }
          })()
        `);
        wc.paste();
      },
    },
    { type: 'separator' },
    {
      label: 'Select All',
      accelerator: 'CmdOrCtrl+A',
      click: () => {
        wc.executeJavaScript(`
          (function() {
            var el = document.elementFromPoint(${x}, ${y});
            if (el && el.closest('.xterm')) {
              window.dispatchEvent(new CustomEvent('terminal-select-all', { detail: { x: ${x}, y: ${y} } }));
            } else if (el && el.closest('.monaco-diff-editor')) {
              window.dispatchEvent(new CustomEvent('diff-select-all', { detail: { x: ${x}, y: ${y} } }));
            } else {
              document.execCommand('selectAll');
            }
          })()
        `);
      },
    },
  );

  Menu.buildFromTemplate(template).popup();
}

const createWindow = () => {
  phase('createWindow');
  const isTest = process.env.NODE_ENV === 'test';

  const iconPath = resolveIconPath();
  const iconImage = nativeImage.createFromPath(iconPath);

  const savedBounds = resolveWindowBounds();

  // Dev-preview only: resolve once (memoized) so the additionalArguments spread below reads a
  // single local instead of calling getPreviewTaskTitle() twice (and dropping the non-null `!`).
  const previewTaskTitle = __KANGENTIC_DEV__ && isEphemeral ? getPreviewTaskTitle() : null;

  mainWindow = new BrowserWindow({
    icon: iconImage,
    ...(savedBounds ? savedBounds : { width: 1400, height: 900 }),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: resolveBackgroundColor(),
    show: false,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 12 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Enable <webview> for the embedded browser side-pane in the task-detail
      // window. Hardened via the will-attach-webview hook below.
      webviewTag: true,
      // Surface the ephemeral-preview flag (and, when resolvable, the original task
      // title) to the renderer (read in preload via process.argv). Set ONLY in
      // dev-preview mode (`--ephemeral`), so the dev TestHarness and the preview title
      // stay out of the regular `npm start` dogfood. The title is base64-encoded so a
      // value with spaces / `:` / `/` survives command-line round-tripping intact.
      additionalArguments:
        __KANGENTIC_DEV__ && isEphemeral
          ? [
              '--kangentic-ephemeral',
              ...(previewTaskTitle
                ? [`--kangentic-preview-task-title=${Buffer.from(previewTaskTitle, 'utf-8').toString('base64')}`]
                : []),
            ]
          : [],
    },
  });

  // Explicitly set icon for Windows/Linux taskbar
  if (process.platform !== 'darwin') {
    mainWindow.setIcon(iconImage);
  }

  // Set macOS dock icon in dev mode (packaged apps use Info.plist icon automatically)
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(iconImage);
  }

  // Enable DevTools shortcuts in development (F12, Ctrl+Shift+I)
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown') {
        const isF12 = input.key === 'F12';
        const isCtrlShiftI =
          input.control && input.shift && input.key.toLowerCase() === 'i';
        if (isF12 || isCtrlShiftI) {
          mainWindow?.webContents.toggleDevTools();
        }
      }
    });
  }

  mainWindow.once('ready-to-show', () => {
    mark('ready_to_show');
    if (!isTest && (!savedBounds || savedBounds.maximized)) {
      mainWindow!.maximize();
    }
    mainWindow!.show();
  });

  // Debounced save of window bounds on move/resize
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      // Prefer the app-canonical manager, exactly as the pop-out bounds writer
      // below does. ConfigManager.save() deep-merges into its OWN cached config
      // and rewrites the whole file, and windowConfigManager's cache is populated
      // at startup for resolveWindowBounds. Saving bounds through it therefore
      // writes a snapshot that predates every setting the renderer has written
      // since (through context.configManager), silently reverting them on the
      // next window move or resize. Caught because it clobbered
      // lastWhatsNewShownVersion, which made the What's New dialog reopen on a
      // later launch, but the same clobber applied to any setting changed after
      // launch.
      const boundsConfigManager = getOptionalIpcContext()?.configManager ?? windowConfigManager;
      if (mainWindow.isMaximized()) {
        boundsConfigManager.save({ windowMaximized: true });
      } else {
        const bounds = mainWindow.getBounds();
        boundsConfigManager.save({ windowBounds: bounds, windowMaximized: false });
      }
    }, 500);
  };
  mainWindow.on('move', saveBounds);
  mainWindow.on('resize', saveBounds);

  // Pop-out windows (usage stats, git changes, the Browser pane) share this window's
  // preload and Vite dev server. configure() is idempotent -- re-activate on macOS calls
  // createWindow() again and simply replaces the context.
  popOutWindowManager.configure({
    devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL ?? null,
    viteName: MAIN_WINDOW_VITE_NAME,
    preloadPath: path.join(__dirname, 'preload.js'),
    // Resolved lazily at bounds-save time (the IPC context is built after this call):
    // share the app-canonical ConfigManager so pop-out bounds writes never clobber
    // settings written through context.configManager. Mirrors the ctx-preferring idiom
    // in safeReadDeveloperFlag above.
    getConfigManager: () => getOptionalIpcContext()?.configManager ?? windowConfigManager,
    onOpenSetChanged: (openInstanceKeys) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.POPOUT_CHANGED, openInstanceKeys);
      }
    },
  });

  // Electron only fires window-all-closed at window-count zero, so closing the main
  // window while a pop-out is open would leave an orphan pop-out and never quit. Destroy
  // every pop-out synchronously when the MAIN window closes (not when a pop-out itself
  // closes -- this listener is scoped to mainWindow only) so the count reaches zero and
  // window-all-closed / app.on('activate') behave correctly either way.
  mainWindow.on('close', () => {
    popOutWindowManager.destroyAll();
  });

  // Browser LANES are OS BrowserWindows too (offscreen and never shown, but
  // still counted by getAllWindows), so they hold the window count above zero
  // exactly like an orphan pop-out. That is worse here than for a pop-out: the
  // only caller of destroyAllLanes is syncShutdownCleanup, which runs from
  // before-quit, so a surviving lane blocks the very path that would have
  // cleaned it up. PTYs are never killed, session records never suspended, DBs
  // never closed, and on Windows the invisible orphan keeps the single-instance
  // lock so the next launch exits silently.
  //
  // On 'closed', NOT 'close', and the difference is load-bearing. Destroying the
  // window tears down its <webview> guests, each of which fires the registry's
  // guest-destroyed path -> the lane hand-off -> a BRAND NEW lane, created
  // synchronously (openLane registers before its first await). That all happens
  // after 'close' handlers return, so sweeping there would be undone by the very
  // teardown that triggered it. 'closed' runs once the guests are already gone.
  //
  // The accepted cost: on macOS the app outlives its window, so this ends an
  // agent's lane when the user closes the window rather than quitting. That is
  // the deliberate trade - the alternative is a lane holding getAllWindows()
  // above zero, which makes app.on('activate') refuse to rebuild the window and
  // locks the user out of the app entirely.
  mainWindow.on('closed', () => {
    destroyAllLanes();
  });

  // Register IPC handlers early so speculative preloading (below) can use them.
  // Idempotent: on macOS dock re-activation, the guard in registerAllIpc()
  // updates the window reference without re-registering handlers.
  registerAllIpc(mainWindow, mcpServerHandle);

  // Native right-click context menu (Copy / Paste / Select All).
  // xterm.js renders to canvas/WebGL -- standard DOM copy/selectAll don't
  // reach its content.  We use the right-click coordinates (captured before
  // the menu opens) to detect if the click landed on a terminal, then
  // dispatch custom events with those coordinates so the correct terminal
  // hook can respond.
  const wc = mainWindow.webContents;
  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (params.mediaType === 'image' && params.hasImageContents) {
      const imageMenu = Menu.buildFromTemplate([
        {
          label: 'Copy Image',
          click: () => {
            try {
              const image = nativeImage.createFromDataURL(params.srcURL);
              clipboard.writeImage(image);
            } catch {
              // srcURL wasn't a valid data URL - silently ignore
            }
          },
        },
        {
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          enabled: params.editFlags.canCopy || true,
          click: () => { wc.executeJavaScript(`document.execCommand('copy')`); },
        },
        { type: 'separator' },
        {
          label: 'Select All',
          accelerator: 'CmdOrCtrl+A',
          click: () => { wc.executeJavaScript(`document.execCommand('selectAll')`); },
        },
      ]);
      imageMenu.popup();
      return;
    }

    // Show the standard terminal-aware Copy / Paste / Select All menu.
    showTerminalAwareContextMenu(wc, params);
  });

  // Track renderer crashes (OOM, GPU process gone, etc.)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    trackEvent('app_error', {
      source: 'render-process-gone',
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(resolveRendererIndexPath(MAIN_WINDOW_VITE_NAME));
  }

  endPhase('createWindow');

  // Speculative preloading: start project opening immediately after createWindow()
  // instead of waiting for did-finish-load (~2s later). DB init, session recovery,
  // and Claude CLI detection all overlap with the renderer loading phase.
  // IPC handlers were registered earlier in this function (registerAllIpc),
  // and Electron queues any webContents.send() calls until the renderer is ready.
  const cwd = getCwdArg();
  const projectPath = cwd || getLastOpenedProject()?.path || null;
  const preloadPromise = (async () => {
    // Dev-only ephemeral: open isolated CLONES of the worktree, never the worktree
    // itself, so nothing the preview does (agents, edits, commits) can reach the
    // repo it runs from. The worktree is the app under test (Vite/HMR), not a board
    // project. Dropped from production by __KANGENTIC_DEV__ dead-code elimination.
    if (__KANGENTIC_DEV__ && isEphemeral && cwd) {
      const ephemeralContext = getOptionalIpcContext();
      if (ephemeralContext) {
        try {
          registerEphemeralProjectDevIpc(getOptionalIpcContext, cwd);
          // Seed-changes dev IPC for the TestHarness "Seed File Changes" button. Only
          // registered in ephemeral preview, the one place its safety guard
          // (preview-projects root) has clones to operate on.
          registerSeedGitChangesDevIpc();
          // Seed-embedding-backlog dev IPC for the TestHarness "Seed Embedding
          // Backlog" button - a realistic pending-chunk count for exercising the
          // central embedding engine's drain loop under sustained real-worker load.
          registerSeedEmbeddingBacklogDevIpc(getOptionalIpcContext);
          // Seed-large-conversation dev IPC for the TestHarness "Seed Large
          // Conversation" button - a throwaway task/session backed by a real
          // synthetic multi-thousand-turn Claude transcript file, for
          // exercising the Conversation viewer on a huge transcript.
          registerSeedLargeConversationDevIpc(getOptionalIpcContext);
          // Seed-usage-data dev IPC for the TestHarness "Seed Usage Data"
          // button - days of realistic multi-agent usage written through the
          // real capture repositories, so the usage dashboard has rich charts
          // to show in an ephemeral preview.
          registerSeedUsageDataDevIpc(getOptionalIpcContext);
          // Adopt the two clones the /preview script pre-cloned (overlapping the
          // build); add more on demand via the TestHarness "Create Project" button.
          const project1 = await createPreviewClone(ephemeralContext, cwd); // adopts "Project 1"
          const project2 = await createPreviewClone(ephemeralContext, cwd); // adopts "Project 2"
          const opened = await openProjectByPath(project1.path);
          mark('project_opened');
          // openProjectByPath (unlike the project:open IPC handler) does not start
          // the background conversation-memory indexer, so the ephemeral preview
          // would never index and semantic search would return nothing. Kick it
          // here. Dev-only path; production starts it from the project:open handler.
          if (opened) retrievalService.startForProject(ephemeralContext, opened);
          // Fill the working trees AFTER the board is open (Project 1 first - it is
          // current) so the slow checkout never contends with the open or delays the
          // board appearing.
          void fillPreviewClone(project1.path)
            .then(() => fillPreviewClone(project2.path))
            .catch(() => {});
          return opened;
        } catch (cloneError) {
          console.error('[DEV] Preview clone seeding failed; falling back to the worktree:', cloneError);
          // fall through to the normal open below
        }
      }
    }

    if (!projectPath) return null;
    try {
      phase('openProjectByPath');
      const project = await openProjectByPath(projectPath);
      endPhase('openProjectByPath');
      mark('project_opened');
      // openProjectByPath is deliberately lighter than the project:open IPC
      // handler (project:open is what fires on every manual sidebar switch)
      // and does not start conversation-memory indexing or flag the project's
      // embedding backlog dirty. Without this, a project auto-restored on cold
      // boot would never resume an embedding backlog left mid-drain from a
      // prior session - the engine's drain loop is alive but stays parked on
      // an empty dirty-set until something marks this project dirty, and nothing
      // else does for THIS specific path (getStatus()'s self-heal only fires if
      // the user happens to open Quick Find or Settings -> Memory).
      //
      // This call site fires exactly ONCE per app launch (preloadPromise is a
      // one-shot IIFE inside createWindow, structurally separate from the
      // project:open handler that already handles every subsequent switch) -
      // it does not run again on project switching, so it does not reintroduce
      // navigation-triggered embedding. startForProject itself is switch-safe
      // regardless (it only does a deferred sweep + markDirty, never inline
      // embedding - the background engine alone decides when to actually embed).
      const context = getOptionalIpcContext();
      if (project && context) retrievalService.startForProject(context, project);
      return project;
    } catch (err) {
      endPhase('openProjectByPath');
      // The last-opened project's folder vanished (moved or renamed on
      // disk). Surface it to the renderer so the "Project Folder Not
      // Found" dialog offers "Locate Folder..." instead of a dead board.
      // Electron queues the send until the renderer is ready.
      if (err instanceof Error && err.message.includes(PROJECT_PATH_MISSING_PREFIX) && mainWindow && !mainWindow.isDestroyed()) {
        const lastOpened = getLastOpenedProject();
        if (lastOpened && path.resolve(lastOpened.path) === path.resolve(projectPath)) {
          mainWindow.webContents.send(IPC.PROJECT_PATH_MISSING, lastOpened);
        }
      }
      console.error('[APP] Failed to preload project:', err);
      return null;
    }
  })();

  mainWindow.webContents.on('did-finish-load', async () => {
    mark('did_finish_load');

    // Set the window title so the taskbar entry says which build this is and, for a
    // worktree run, which worktree. One computed string (computeWindowTitle,
    // window-utils.ts), one setTitle call, so the dev marker cannot drift between the
    // worktree and non-worktree paths. A dev build marks itself here the same way the
    // in-app wordmark does, so the taskbar entry and the window chrome agree about which
    // instance this is when a packaged build is open alongside `npm start`.
    //
    // The __KANGENTIC_DEV__ ternary stays INLINE here rather than moving into
    // computeWindowTitle: esbuild only folds this reference (and drops the "(dev)"
    // string literal from the production bundle via dead-code elimination) at the
    // point __KANGENTIC_DEV__ itself is referenced. Passing a boolean into a separate
    // module's function would ship the literal, dead but present, in every prod build.
    // For the MAIN bundle __KANGENTIC_DEV__ means "dev tooling compiled in"
    // (scripts/dev.js sets it; scripts/build.js only under KANGENTIC_BUILD_DEV=1).
    //
    // Set from `did-finish-load`, after Chromium has applied index.html's <title>, so
    // this wins. The main window does not preventDefault() on 'page-title-updated'
    // (unlike window-open-policy.ts for popups), so a renderer-side document.title write
    // would silently clobber it. Nothing in the main-window tree writes one.
    if (mainWindow) {
      const appLabel = __KANGENTIC_DEV__ ? 'Kangentic (dev)' : 'Kangentic';
      mainWindow.setTitle(computeWindowTitle(appLabel, cwd, getPreviewTaskTitle));
    }

    // Await the preload that started during createWindow -- typically already resolved
    const project = await preloadPromise;
    finishStartupTimer();
    if (project && mainWindow) {
      mainWindow.webContents.send(IPC.PROJECT_AUTO_OPENED, project);
    }

    // Activate all other projects' sessions in the background.
    // Defer by 5 seconds so the primary project's recovery completes
    // without CPU/IO contention from all other projects.
    activateAllProjectsTimer = setTimeout(() => {
      activateAllProjectsTimer = null;
      phase('activateAllProjects');
      activateAllProjects()
        .catch((err) => console.error('[APP] Failed to activate all projects:', err))
        .finally(() => { endPhase('activateAllProjects'); });
    }, 5000);
  });
};

// Replace the default application menu with a minimal one.
// The app uses a custom React titlebar, so the full default menu is wasted work.
// macOS needs an Edit submenu to enable Cmd+C/V/A clipboard shortcuts in the renderer;
// Windows/Linux don't need any menu at all.
Menu.setApplicationMenu(
  process.platform === 'darwin'
    ? Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ])
    : null,
);

app.whenReady().then(async () => {
  mark('app_ready');

  // Load the sqlite-vec extension into every project DB as it opens (after
  // migrations). Registered before any project opens so the semantic search
  // layer is available; a load failure degrades to lexical-only.
  setProjectDbInitializer(loadVecExtension);

  // Let agent adapters drop per-directory state for a worktree Kangentic just
  // deleted (Codex records directory trust in ~/.codex/config.toml keyed by
  // path, one entry per task worktree). Registered as a listener rather than
  // imported inside the git module so that low-level module never reaches
  // into the agent registry. Wired here, before any project opens, so no
  // removal path can run un-notified.
  setWorktreeRemovedListener(notifyAdaptersWorktreeRemoved);

  // Redundant AUMID call inside whenReady -- ensures the ID is set even if
  // Electron clears it during app initialization on some Windows versions.
  app.setAppUserModelId(
    app.isPackaged ? 'com.kangentic.app' : 'com.kangentic.dev'
  );

  // Restore the user's shell PATH on macOS/Linux GUI launches. Finder,
  // Spotlight, Dock, and desktop launchers hand Electron a minimal PATH
  // from launchd that does not include Homebrew, ~/.claude/local, nvm,
  // npm-global, or pip --user locations. Without this, agent detection
  // (via `which`) fails for CLIs installed in those locations. No-op on
  // Windows.
  phase('restoreShellEnv');
  try {
    await restoreShellEnv();
  } catch (error) {
    console.warn('[APP] restoreShellEnv failed:', error);
  } finally {
    endPhase('restoreShellEnv');
  }

  // Fix node-pty spawn-helper permissions on macOS before any PTY spawns.
  // Must run before createWindow() which triggers session recovery.
  ensureSpawnHelperPermissions();

  // On a fresh install, record the running version as already having shown its
  // "What's New" notes. A first-time user has not upgraded from anything, so
  // showing them what changed is meaningless, and it would stack on the
  // onboarding walkthrough that opens on this same boot. An existing install
  // keeps the merged '' default and correctly sees the notes after it upgrades.
  //
  // Must run before createWindow(): a direct save() does not broadcast
  // CONFIG_CHANGED (only the config:set handler does), so seeding after the
  // renderer has fetched config would never reach it.
  if (!configFileExistedAtLaunch) {
    windowConfigManager.save({ lastWhatsNewShownVersion: app.getVersion() });
  }

  // Start the in-process MCP HTTP server BEFORE createWindow so the URL
  // is available when projects.ts writes per-project mcp-config.json
  // and command-builder writes per-session mcp.json. Bound to 127.0.0.1
  // by default - no firewall prompt, no exposure to other machines -
  // unless the user opts into a wider bindAddress by hand-editing the
  // global config.json (there is no Settings UI for it). Network config
  // is read once here, at startup; changing it requires an app restart.
  //
  // The factory passed in here is the only path that resolves a project
  // ID to a CommandContext. It returns null if (a) the IPC context is
  // not yet initialized, (b) the global Settings -> MCP Server toggle is
  // OFF, or (c) the project ID is unknown. Returning null causes the
  // server to respond 404, which is defense in depth on top of the
  // mcp-config.json file gating in projects.ts -- a stale config file
  // from before the toggle was flipped off can never grant access at
  // runtime.
  try {
    const startupMcpServerConfig = windowConfigManager.load().mcpServer;
    mcpServerHandle = await startMcpHttpServer(
      (projectId) => {
        const ctx = getOptionalIpcContext();
        if (!ctx) return null;
        const globalConfig = ctx.configManager.load();
        if (globalConfig.mcpServer?.enabled === false) return null;
        return createRequestResolver(ctx, projectId);
      },
      () => readBrowserAutomationConfig(getOptionalIpcContext()?.configManager ?? windowConfigManager),
      {
        bindAddress: startupMcpServerConfig?.bindAddress ?? '127.0.0.1',
        callbackHost: startupMcpServerConfig?.callbackHost,
      },
      // Steering (kangentic_send_session_message) needs the live PTY
      // singletons, which do not exist until the IPC context is built. Read
      // lazily per request; null just means the tool is not registered yet,
      // which is only true before any agent could be running.
      () => {
        const ctx = getOptionalIpcContext();
        if (!ctx) return null;
        return { sessionManager: ctx.sessionManager, terminalSubmit: ctx.terminalSubmit };
      },
    );
  } catch (err) {
    console.error('[APP] Failed to start MCP HTTP server:', err);
    // Continue without it -- agents will see "Unauthorized" or "Connection
    // refused" but the rest of the app stays functional.
  }

  // Grant the first-party renderer the web-platform permissions it actually uses:
  // 'media' (getUserMedia microphone access for voice-to-text dictation) and the
  // async Clipboard API ('clipboard-read' / 'clipboard-sanitized-write') that backs
  // terminal copy/paste and every "copy to clipboard" affordance. The renderer is
  // our own trusted UI, not arbitrary web content. Without the clipboard grant,
  // navigator.clipboard.readText()/writeText() throw NotAllowedError and the actions
  // silently no-op (this broke Ctrl+V text/image paste and the copy buttons). The
  // policy lives in permission-policy.ts so both handlers stay in lockstep and it is
  // unit-tested. OS-level gates still apply (macOS TCC for the mic surfaces as a
  // getUserMedia rejection). The embedded browser webview is untrusted guest content
  // and keeps its own deny-all handler below; this default-session policy does not
  // touch it.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isFirstPartyPermissionAllowed(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return isFirstPartyPermissionAllowed(permission);
  });

  createWindow();
  initUpdater(mainWindow!);
  initAnnouncements(mainWindow!);

  // Windows has no powerMonitor 'shutdown' event (Linux/macOS only). An OS
  // shutdown/restart/log-off there is signaled via this BrowserWindow event
  // instead. Route it through the same synchronous shutdown flush as
  // before-quit / SIGINT/SIGTERM so a session killed by the OS still gets a
  // closing event instead of a stale one.
  if (process.platform === 'win32') {
    mainWindow!.on('session-end', () => {
      performShutdown();
    });
  }

  // System suspend fixes the stale-last-event case where the process is
  // killed while asleep before it can flush anything: emit one heartbeat
  // (gated the same as the periodic one, so an idle app going to sleep sends
  // nothing) right before the system goes down. Not a close event; the app
  // keeps running once the system resumes. Registered before the awaited
  // client-id resolution below so a slow lookup can never delay it.
  powerMonitor.on('suspend', () => {
    trackHeartbeat();
  });

  // OS-initiated shutdown/reboot bypasses before-quit entirely on Linux/macOS
  // (Windows's equivalent is the BrowserWindow 'session-end' handler above).
  // Route it through the same flush so an abrupt OS shutdown still records a
  // closing event instead of leaving a stale last event.
  if (process.platform !== 'win32') {
    powerMonitor.on('shutdown', () => {
      performShutdown();
    });
  }

  // Resolve the anonymous client id before the first event. Best-effort:
  // resolveClientId never throws (it falls back to a random id internally).
  const clientId = await resolveClientId(
    app.getPath('home'),
    path.join(PATHS.configDir, 'analytics-client-id.json')
  );
  setAnalyticsClientId(clientId);

  // Fire app_launch event (analytics initialized before app.whenReady above).
  // trackEvent is a no-op if analytics is disabled, so no guard needed here.
  // clientId is attached here only - the one authoritative per-launch install
  // signal - not merged into every event (see analytics.ts).
  trackEvent('app_launch', { platform: process.platform, arch: process.arch, clientId });
  heartbeatInterval = setInterval(trackHeartbeat, 30 * 60 * 1000);

  // Load React DevTools extension in development (fire-and-forget, after window is visible)
  if (!app.isPackaged) {
    loadReactDevTools();
  }

  // Prune stale worktree projects from crashed/force-killed preview instances.
  // Only runs in the main app during development -- preview is a dev-only feature.
  if (!isEphemeral && !app.isPackaged) {
    // Skip the zombie reaper under E2E. It would add ~1.5-2s per Electron
    // launch (PowerShell Get-CimInstance startup) across 95+ tests = several
    // minutes of wall-clock regression for zero benefit -- E2E spawns are
    // strictly parented by the Playwright worker, so there are no orphans
    // to find. The reaper's intended audience is interactive `npm start`
    // sessions and `/preview` windows, not headless test workers.
    //
    // This is the DEV-ONLY project-wide BOOT sweep. The per-worktree reap that
    // runs in PRODUCTION lives in WorktreeManager.removeWorktree, which calls it
    // lazily only when a delete is actually pinned (so a clean Done-move never
    // scans), and shares the same scan/skip/kill core in zombie-reaper.ts.
    if (__KANGENTIC_DEV__ && !isE2ETest) {
      phase('reapZombieElectron');
      try {
        const { reapWorktreeElectronZombies } = await import('./git/zombie-reaper');
        // Outer 2s cap. The empty array is the "no zombies killed"
        // sentinel when the inner scan hangs (PowerShell Get-CimInstance
        // stalling, etc). `never[]` is assignable to the reaper's
        // ReapedProcess[] return so Promise.race resolves correctly.
        const cap = new Promise<never[]>((resolve) =>
          setTimeout(() => resolve([]), 2000));
        const reaped = await Promise.race([
          reapWorktreeElectronZombies({
            projectPath: process.cwd(),
            scanTimeoutMs: 1500,
          }).catch((err) => {
            console.warn('[REAPER] scan failed:', err);
            return [];
          }),
          cap,
        ]);
        if (reaped.length > 0) {
          console.log(`[REAPER] killed ${reaped.length} zombie(s)`);
        }
      } catch (err) {
        console.warn('[REAPER] skipped:', err);
      } finally {
        endPhase('reapZombieElectron');
      }
    }
    phase('pruneStaleWorktreeProjects');
    pruneStaleWorktreeProjects()
      .catch((err) => console.error('[APP] Failed to prune stale worktree projects:', err))
      .finally(() => { endPhase('pruneStaleWorktreeProjects'); });
  }

  // Reclaim orphaned embedded-Browser cookie jars left by deleted tasks and projects.
  // Runs in PACKAGED builds too (jars accumulate for every user, holding live
  // session cookies), unlike the dev-only prune above. Skipped for ephemeral
  // preview instances (separate --user-data-dir) and E2E (launch-cost parity
  // with the reaper skip). Fire-and-forget: work is bounded per directory by
  // removeWithRetry, and the sweep abstains rather than over-delete on any fault.
  if (!isEphemeral && !isE2ETest) {
    phase('sweepBrowserPartitions');
    sweepOrphanedBrowserPartitions(app.getPath('userData'))
      .then((summary) => {
        if (summary.removed.length > 0) {
          console.log(`[browser-partition] startup sweep reclaimed ${summary.removed.length} jar(s).`);
        }
      })
      .catch((err) => console.warn('[browser-partition] startup sweep failed:', err))
      .finally(() => { endPhase('sweepBrowserPartitions'); });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (isShuttingDown()) return;
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    updateUpdaterWindow(mainWindow!);
    updateAnnouncementsWindow(mainWindow!);
  }
});

/** Send a heartbeat event with current session counts. Skipped when no
 *  session is active (shouldEmitHeartbeat) so a pure-idle app-open window
 *  does not spend event budget or drag out measured session duration. */
function trackHeartbeat(): void {
  const sessionManager = getSessionManager();
  const counts = sessionManager.getSessionCounts();
  if (!shouldEmitHeartbeat(counts)) return;
  trackEvent('app_heartbeat', {
    activeSessions: counts.active,
    suspendedSessions: counts.suspended,
    queuedSessions: sessionManager.queuedCount,
    totalSessions: counts.total,
  });
}

/**
 * Fire-and-forget shutdown analytics. Attempts a final heartbeat (skipped by
 * the shouldEmitHeartbeat gate when no session is active, which is the common
 * idle-at-quit case), then always sends the app_close event. Aptabase's
 * "Avg. Duration" metric (time between first and last event in a session) is
 * still covered by app_close's own durationSeconds even when the heartbeat is
 * skipped.
 *
 * Wrapped in try-catch so analytics failures never prevent syncShutdownCleanup.
 */
function trackShutdownAnalytics(): void {
  try {
    trackHeartbeat();
    const durationSeconds = Math.round((Date.now() - appLaunchTime) / 1000);
    trackEvent('app_close', { durationSeconds });
  } catch {
    // Analytics must never block shutdown cleanup
  }
}

/** Build the shutdown dependencies from current module-level state. */
function getShutdownDependencies() {
  return {
    getSessionManager,
    getBoardConfigManager,
    getDiffWatcher: () => getOptionalIpcContext()?.diffWatcher ?? null,
    getTerminalSubmitScheduler,
    getCurrentProjectId,
    deleteProjectFromIndex,
    stopUpdaterTimers,
    stopAnnouncementTimers,
    clearPendingTimers: () => {
      if (activateAllProjectsTimer) {
        clearTimeout(activateAllProjectsTimer);
        activateAllProjectsTimer = null;
      }
      // The recurring heartbeat keeps the event loop alive on its own and
      // would otherwise prevent Node from exiting cleanly during shutdown.
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      // Stop the background PR-refresh timer (also .unref()'d, but clear it
      // explicitly so no tick fires mid-shutdown).
      prRefreshScheduler.stop();
      // Stop conversation-memory indexing synchronously: drop pending finalize
      // timers and abandon any in-flight sweep (recovered on next open).
      retrievalService.dispose();
      // Synchronously kill the line-count worker (if spawned); in-flight
      // counts abandon and their callers fall back to inline counting.
      lineCountClient.dispose();
      // Stop accepting new MCP requests synchronously. The server's close()
      // is non-blocking; in-flight requests are abandoned, which is fine
      // because they're idempotent (the agent will retry on reconnect or
      // surface an error to the user).
      if (mcpServerHandle) {
        mcpServerHandle.close();
        mcpServerHandle = null;
      }
      // Synchronously tear down the mobile bridge: cancels any in-progress
      // pairing ceremony and disposes active sessions. All of its internal
      // timers (the ~2-minute KK re-handshake, the relay client's reconnect
      // backoff) are already .unref()'d, but dispose() clears them
      // explicitly so nothing fires mid-shutdown.
      getOptionalIpcContext()?.mobileBridgeService.dispose();
      // Synchronously detach the desktop notifier's SessionManager listeners.
      // It holds no timers, so this is a pure listener-leak guard, not a
      // functional requirement of shutdown.
      getOptionalIpcContext()?.desktopNotifier.dispose();
    },
    isEphemeral,
  };
}

/**
 * Shared synchronous shutdown flush: app quit (before-quit), SIGINT/SIGTERM,
 * and OS-initiated shutdown/reboot/log-off (powerMonitor 'shutdown' on
 * Linux/macOS, BrowserWindow 'session-end' on Windows) all route through
 * this. Idempotent via isShuttingDown: returns false (and does nothing) if
 * a shutdown is already in progress.
 */
function performShutdown(): boolean {
  if (isShuttingDown()) return false;
  setShuttingDown();

  // Hard failsafe: if Electron's normal shutdown hangs, force-kill everything
  startHardShutdownFailsafe();

  trackShutdownAnalytics();

  // Synchronous cleanup - then let the quit proceed normally so Electron
  // tears down all Chromium child processes (GPU, utility, crashpad, etc.)
  syncShutdownCleanup(getShutdownDependencies());
  return true;
}

app.on('before-quit', () => {
  performShutdown();
});

// Handle force-close (Ctrl+C / SIGINT / SIGTERM) which may not fire before-quit
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (performShutdown()) process.exit(0);
  });
}
