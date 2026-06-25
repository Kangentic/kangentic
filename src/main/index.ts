const PROCESS_START = performance.now();

import { app, BrowserWindow, clipboard, Menu, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { registerAllIpc, getSessionManager, getTerminalSubmitScheduler, getBoardConfigManager, getCurrentProjectId, getOptionalIpcContext, openProjectByPath, deleteProjectFromIndex, pruneStaleWorktreeProjects, activateAllProjects, getLastOpenedProject } from './ipc/register-all';
import { installDiagnostics } from './diagnostics/install';
// Dev-only (dropped from prod via __KANGENTIC_DEV__ dead-code elimination).
import { createPreviewClone, fillPreviewClone, registerEphemeralProjectDevIpc } from '../devtools/main/ephemeral-projects';
import { registerSeedGitChangesDevIpc } from '../devtools/main/seed-git-changes';
import { installDevtools } from '../devtools/install';
import { startMcpHttpServer, type McpHttpServerHandle } from './agent/mcp-http-server';
import { readBrowserAutomationConfig } from './browser/browser-automation-config';
import { browserPaneRegistry } from './browser/browser-pane-registry';
import { createRequestResolver } from './agent/mcp-project-context';
import { IPC, PROJECT_PATH_MISSING_PREFIX } from '../shared/ipc-channels';
import { ConfigManager } from './config/config-manager';
import { isShuttingDown, setShuttingDown } from './shutdown-state';
const windowConfigManager = new ConfigManager();
import { initAnalytics, trackEvent, sanitizeErrorMessage } from './analytics/analytics';
import { initStartupTimer, mark, phase, endPhase, finishStartupTimer } from './startup-timer';
import { resolveBackgroundColor, resolveIconPath, resolveWindowBounds } from './window-utils';
import { loadReactDevTools } from './devtools';
import { syncShutdownCleanup, startHardShutdownFailsafe } from './shutdown';
import { prRefreshScheduler } from './pr/pr-refresh-scheduler';
import { restoreShellEnv } from './shell-env';
import { MIN_ZOOM, MAX_ZOOM } from '../shared/zoom-steps';

initStartupTimer(PROCESS_START);
mark('process_start');

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

function safeReadDeveloperFlag(
  key:
    | 'activityDebugOverlay'
    | 'persistConsoleLogs'
    | 'recordIpcTraffic'
    | 'previewInspectionServer'
    | 'previewEvalEnabled',
): boolean {
  try {
    const ctx = getOptionalIpcContext();
    const manager = ctx?.configManager ?? windowConfigManager;
    const stored = manager.load().developer?.[key];
    if (stored !== undefined) return stored === true;
    // Default values when the user has never touched the toggle. The
    // inspection bridge AND its eval/unsafe gate default ON in dev builds:
    // anyone running `npm start` / `/preview` is by definition a kangentic dev
    // session and almost certainly wants the agent-driven inspection bridge
    // (including eval, inject-event, raw-PTY) available without flipping a
    // toggle each launch. Both are localhost-only and dropped from production
    // builds via `__KANGENTIC_DEV__`. The other toggles (overlay, log mirror,
    // IPC recorder) still default OFF because they have a visible/disk cost the
    // user should opt into deliberately. An explicit stored value always wins.
    if (key === 'previewInspectionServer' || key === 'previewEvalEnabled') return __KANGENTIC_DEV__;
    return false;
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

process.on('uncaughtException', (error) => {
  if (isBenignShutdownStreamError(error)) return;
  console.error('[APP] Uncaught exception:', error);
  if (!isShuttingDown()) {
    trackEvent('app_error', {
      source: 'uncaughtException',
      message: sanitizeErrorMessage(error.message),
    });
  }
});
process.on('unhandledRejection', (reason) => {
  if (isBenignShutdownStreamError(reason)) return;
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.BROWSER_ZOOM_CHANGED, clampedFactor);
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

const createWindow = () => {
  phase('createWindow');
  const isTest = process.env.NODE_ENV === 'test';

  const iconPath = resolveIconPath();
  const iconImage = nativeImage.createFromPath(iconPath);

  const savedBounds = resolveWindowBounds();

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
      // Surface the ephemeral-preview flag to the renderer (read in preload via
      // process.argv). Set ONLY in dev-preview mode (`--ephemeral`), so the dev
      // TestHarness stays out of the regular `npm start` dogfood.
      additionalArguments: __KANGENTIC_DEV__ && isEphemeral ? ['--kangentic-ephemeral'] : [],
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
    const { x, y } = params;

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

    const menu = Menu.buildFromTemplate([
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
              } else {
                document.execCommand('selectAll');
              }
            })()
          `);
        },
      },
    ]);
    menu.popup();
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
    // The esbuild layout ships the renderer alongside the main bundle
    // (./renderer/). The legacy Forge layout kept it in ../renderer/.
    // Prefer the esbuild layout because the legacy path can be populated
    // by a stale `npm start` dev-server cache (`.vite/renderer/`) that
    // survives `npm run build`, causing the packaged app to load an
    // outdated bundle. Fall back to the legacy path only when the
    // standalone layout is missing.
    const standalonePath = path.join(__dirname, `renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    const legacyPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    mainWindow.loadFile(fs.existsSync(standalonePath) ? standalonePath : legacyPath);
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
          // Seed-changes dev IPC for the TestHarness "Seed Changes" button. Only
          // registered in ephemeral preview, the one place its safety guard
          // (preview-projects root) has clones to operate on.
          registerSeedGitChangesDevIpc();
          // Adopt the two clones the /preview script pre-cloned (overlapping the
          // build); add more on demand via the TestHarness "Create Project" button.
          const project1 = await createPreviewClone(ephemeralContext, cwd); // adopts "Project 1"
          const project2 = await createPreviewClone(ephemeralContext, cwd); // adopts "Project 2"
          const opened = await openProjectByPath(project1.path);
          mark('project_opened');
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

  createWindow();
  initUpdater(mainWindow!);

  // Fire app_launch event (analytics initialized before app.whenReady above).
  // trackEvent is a no-op if analytics is disabled, so no guard needed here.
  trackEvent('app_launch', { platform: process.platform, arch: process.arch });
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

/** Send a heartbeat event with current session counts. */
function trackHeartbeat(): void {
  const sessionManager = getSessionManager();
  const counts = sessionManager.getSessionCounts();
  trackEvent('app_heartbeat', {
    activeSessions: counts.active,
    suspendedSessions: counts.suspended,
    queuedSessions: sessionManager.queuedCount,
    totalSessions: counts.total,
  });
}

/**
 * Fire-and-forget shutdown analytics. Sends a final heartbeat so Aptabase can
 * calculate session duration (its "Avg. Duration" metric is the time between
 * first and last event in a session), then sends the app_close event.
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
      // Stop accepting new MCP requests synchronously. The server's close()
      // is non-blocking; in-flight requests are abandoned, which is fine
      // because they're idempotent (the agent will retry on reconnect or
      // surface an error to the user).
      if (mcpServerHandle) {
        mcpServerHandle.close();
        mcpServerHandle = null;
      }
    },
    isEphemeral,
  };
}

app.on('before-quit', () => {
  if (isShuttingDown()) return;
  setShuttingDown();

  // Hard failsafe: if Electron's normal shutdown hangs, force-kill everything
  startHardShutdownFailsafe();

  trackShutdownAnalytics();

  // Synchronous cleanup - then let the quit proceed normally so Electron
  // tears down all Chromium child processes (GPU, utility, crashpad, etc.)
  syncShutdownCleanup(getShutdownDependencies());
});

// Handle force-close (Ctrl+C / SIGINT / SIGTERM) which may not fire before-quit
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (isShuttingDown()) return;
    setShuttingDown();
    startHardShutdownFailsafe();
    trackShutdownAnalytics();
    syncShutdownCleanup(getShutdownDependencies());
    process.exit(0);
  });
}
