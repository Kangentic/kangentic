const PROCESS_START = performance.now();

import { app, BrowserWindow, clipboard, Menu, nativeImage, powerMonitor, session } from 'electron';
import path from 'node:path';
import { registerAllIpc, getSessionManager, getTerminalSubmitScheduler, getBoardConfigManager, getCurrentProjectId, getOptionalIpcContext, openProjectByPath, deleteProjectFromIndex, pruneStaleWorktreeProjects, activateAllProjects, getLastOpenedProject } from './ipc/register-all';
import { installDiagnostics } from './diagnostics/install';
import { startEventLoopLagMonitor } from './diagnostics/event-loop-lag';
// Dev-only (dropped from prod via __KANGENTIC_DEV__ dead-code elimination).
import { createPreviewClone, fillPreviewClone, registerEphemeralProjectDevIpc } from '../devtools/main/ephemeral-projects';
import { resolvePreviewTaskTitle } from '../devtools/main/preview-task-title';
import { registerSeedGitChangesDevIpc } from '../devtools/main/seed-git-changes';
import { registerSeedEmbeddingBacklogDevIpc } from '../devtools/main/seed-embedding-backlog';
import { registerSeedLargeConversationDevIpc } from '../devtools/main/seed-large-conversation';
import { registerSeedUsageDataDevIpc } from '../devtools/main/seed-usage-data';
import { installDevtools } from '../devtools/install';
import { startMcpHttpServer, type McpHttpServerHandle } from './agent/mcp-http-server';
import { readBrowserAutomationConfig } from './browser/browser-automation-config';
import { browserPaneRegistry } from './browser/browser-pane-registry';
import { createRequestResolver } from './agent/mcp-project-context';
import { IPC, PROJECT_PATH_MISSING_PREFIX } from '../shared/ipc-channels';
import { ConfigManager } from './config/config-manager';
import { isShuttingDown, setShuttingDown } from './shutdown-state';
import { isBenignStreamWriteError } from './diagnostics/benign-stream-error';
const windowConfigManager = new ConfigManager();
import { initAnalytics, trackEvent, sanitizeErrorMessage, shouldEmitHeartbeat, setAnalyticsClientId } from './analytics/analytics';
import { resolveClientId } from './analytics/client-id';
import { PATHS } from './config/paths';
import { initStartupTimer, mark, phase, endPhase, finishStartupTimer } from './startup-timer';
import { resolveBackgroundColor, resolveIconPath, resolveWindowBounds, resolveRendererIndexPath } from './window-utils';
import { popOutWindowManager } from './pop-out/pop-out-window-manager';
import { loadReactDevTools } from './devtools';
import { syncShutdownCleanup, startHardShutdownFailsafe } from './shutdown';
import { prRefreshScheduler } from './pr/pr-refresh-scheduler';
import { retrievalService } from './retrieval/retrieval-service';
import { lineCountClient } from './git/line-count/line-count-client';
import { setProjectDbInitializer } from './db/database';
import { loadVecExtension } from './retrieval/vec-extension';
import { restoreShellEnv } from './shell-env';
import { isFirstPartyPermissionAllowed } from './permission-policy';
import { MIN_ZOOM, MAX_ZOOM } from '../shared/zoom-steps';
import { defaultDeveloperFlag, type DeveloperFlagKey } from '../shared/developer-flag-defaults';

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

// Dev-only: the original task's title for a `/preview` window, resolved once from
// the real parent project DB (the preview clones never contain it). Surfaced to the
// renderer via additionalArguments so the title bar can identify the task both clones
// belong to. Memoized; null outside dev-preview or when resolution misses (graceful).
let cachedPreviewTaskTitle: string | null | undefined;
function getPreviewTaskTitle(): string | null {
  if (cachedPreviewTaskTitle === undefined) {
    cachedPreviewTaskTitle =
      __KANGENTIC_DEV__ && isEphemeral ? resolvePreviewTaskTitle(getCwdArg() ?? '') : null;
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

  // The remaining handlers apply only to webview contents themselves.
  if (contents.getType() !== 'webview') return;

  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Deny all permission requests (camera, mic, geolocation, notifications, ...)
  // on the embedded pane. The pane is for viewing dev servers, which need none
  // of these, and agent-driven navigation could otherwise reach a page that
  // auto-prompts. (embedded-browser.md decision log item 5.)
  contents.session.setPermissionRequestHandler((_requestingContents, _permission, callback) => callback(false));

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
      hostWindow.webContents.send(IPC.BROWSER_ZOOM_CHANGED, clampedFactor);
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
  });
  contents.on('did-navigate', (_navigationEvent, navigatedUrl) => {
    browserPaneRegistry.updateUrlByWebContentsId(contents.id, navigatedUrl);
  });
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
      if (mainWindow.isMaximized()) {
        windowConfigManager.save({ windowMaximized: true });
      } else {
        const bounds = mainWindow.getBounds();
        windowConfigManager.save({ windowBounds: bounds, windowMaximized: false });
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

    // Set window title to include worktree name so the taskbar entry
    // is distinguishable from the main project window.
    if (cwd && mainWindow) {
      const worktreeMatch = cwd.replace(/\\/g, '/').match(/\.kangentic\/worktrees\/([^/]+)/);
      if (worktreeMatch) {
        mainWindow.setTitle(`Kangentic - ${worktreeMatch[1]}`);
      }
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

  // Start the in-process MCP HTTP server BEFORE createWindow so the URL
  // is available when projects.ts writes per-project mcp-config.json
  // and command-builder writes per-session mcp.json. Bound to 127.0.0.1
  // only -- no firewall prompt, no exposure to other machines.
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
    mcpServerHandle = await startMcpHttpServer(
      (projectId) => {
        const ctx = getOptionalIpcContext();
        if (!ctx) return null;
        const globalConfig = ctx.configManager.load();
        if (globalConfig.mcpServer?.enabled === false) return null;
        return createRequestResolver(ctx, projectId);
      },
      () => readBrowserAutomationConfig(getOptionalIpcContext()?.configManager ?? windowConfigManager),
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
