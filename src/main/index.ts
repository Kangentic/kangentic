const PROCESS_START = performance.now();

import { app, BrowserWindow, Menu, nativeImage, screen, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { registerAllIpc, updateMainWindow, getSessionManager, getCommandInjector, getBoardConfigManager, getCurrentProjectId, openProjectByPath, deleteProjectFromIndex, pruneStaleWorktreeProjects, activateAllProjects, getLastOpenedProject } from './ipc/register-all';
import { closeAll, getProjectDb } from './db/database';
import { SessionRepository } from './db/repositories/session-repository';
import { IPC } from '../shared/ipc-channels';
import { THEME_BACKGROUNDS } from '../shared/types';
import type { AppConfig, ThemeMode } from '../shared/types';
import { PATHS } from './config/paths';
import { ConfigManager } from './config/config-manager';
const windowConfigManager = new ConfigManager();
import { initAnalytics, trackEvent, sanitizeErrorMessage } from './analytics/analytics';
import { initStartupTimer, mark, phase, endPhase, finishStartupTimer } from './startup-timer';

initStartupTimer(PROCESS_START);
mark('process_start');

// Global error handlers -- keep the app running through transient IPC/PTY errors.
// During shutdown, skip analytics calls to avoid new network requests that block exit.
process.on('uncaughtException', (error) => {
  console.error('[APP] Uncaught exception:', error);
  if (!isShuttingDown) {
    trackEvent('app_error', {
      source: 'uncaughtException',
      message: sanitizeErrorMessage(error.message),
    });
  }
});
process.on('unhandledRejection', (reason) => {
  console.error('[APP] Unhandled rejection:', reason);
  if (!isShuttingDown) {
    trackEvent('app_error', {
      source: 'unhandledRejection',
      message: sanitizeErrorMessage(reason instanceof Error ? reason.message : String(reason)),
    });
  }
});

import { initUpdater, updateUpdaterWindow, stopUpdaterTimers } from './updater';

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

// Enforce single instance -- prevents manual double-launches from spawning
// duplicate windows. Ephemeral instances
// (worktree previews) skip this so they can coexist with the main app.
if (!isEphemeral) {
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
let isShuttingDown = false;

// Parse --cwd=<path> from command line args
function getCwdArg(): string | null {
  for (const arg of process.argv) {
    if (arg.startsWith('--cwd=')) {
      return arg.slice(6);
    }
  }
  return null;
}

function resolveBackgroundColor(): string {
  try {
    const raw = fs.readFileSync(PATHS.configFile, 'utf-8');
    const theme = (JSON.parse(raw) as { theme?: ThemeMode }).theme;
    if (theme && theme in THEME_BACKGROUNDS) {
      return THEME_BACKGROUNDS[theme];
    }
  } catch {
    // Config file missing or malformed -- use default
  }
  return '#18181b';
}

export function resolveIconPath(): string {
  const iconFilename = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return app.isPackaged
    ? path.join(process.resourcesPath, iconFilename)
    : path.join(app.getAppPath(), 'resources', iconFilename);
}

function loadReactDevTools(): void {
  const reactDevToolsId = 'fmkadmapgofadopljbjfkapdkoienihi';
  let chromeExtensionsBase: string;
  switch (process.platform) {
    case 'darwin':
      chromeExtensionsBase = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'User Data', 'Default', 'Extensions');
      break;
    case 'linux':
      chromeExtensionsBase = path.join(os.homedir(), '.config', 'google-chrome', 'Default', 'Extensions');
      break;
    default:
      chromeExtensionsBase = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Extensions');
      break;
  }
  const extensionDir = path.join(chromeExtensionsBase, reactDevToolsId);
  if (!fs.existsSync(extensionDir)) return;

  const versions = fs.readdirSync(extensionDir).sort();
  const latest = versions[versions.length - 1];
  if (!latest) return;

  session.defaultSession.extensions.loadExtension(path.join(extensionDir, latest))
    .then(() => console.log('[APP] React DevTools loaded'))
    .catch((err) => console.log('[APP] Failed to load React DevTools:', err));
}

/** Read saved window bounds from config, with screen-boundary validation. */
function resolveWindowBounds(): { x: number; y: number; width: number; height: number } | null {
  try {
    const raw = fs.readFileSync(PATHS.configFile, 'utf-8');
    const config = JSON.parse(raw) as Partial<AppConfig>;
    if (!config.restoreWindowPosition || !config.windowBounds) return null;
    const { x, y, width, height } = config.windowBounds;
    if (width < 400 || height < 300) return null;
    // Verify the window overlaps at least one display (e.g. external monitor disconnected)
    const displays = screen.getAllDisplays();
    const overlapsDisplay = displays.some((display) => {
      const { x: displayX, y: displayY, width: displayWidth, height: displayHeight } = display.bounds;
      return x < displayX + displayWidth && x + width > displayX
        && y < displayY + displayHeight && y + height > displayY;
    });
    if (!overlapsDisplay) return null;
    return { x, y, width, height };
  } catch {
    return null;
  }
}

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

  mainWindow.once('ready-to-show', () => {
    mark('ready_to_show');
    if (!isTest && !savedBounds) {
      mainWindow!.maximize();
    }
    mainWindow!.show();
  });

  // Debounced save of window bounds on move/resize
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
      const bounds = mainWindow.getBounds();
      windowConfigManager.save({ windowBounds: bounds });
    }, 500);
  };
  mainWindow.on('move', saveBounds);
  mainWindow.on('resize', saveBounds);

  // Native right-click context menu (Copy / Paste / Select All).
  // xterm.js renders to canvas/WebGL -- standard DOM copy/selectAll don't
  // reach its content.  We use the right-click coordinates (captured before
  // the menu opens) to detect if the click landed on a terminal, then
  // dispatch custom events with those coordinates so the correct terminal
  // hook can respond.
  const wc = mainWindow.webContents;
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const { x, y } = params;
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
        click: () => { wc.paste(); },
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
    // Check both relative paths: ../renderer/ (legacy Forge layout) and ./renderer/ (esbuild)
    const legacyPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    const standalonePath = path.join(__dirname, `renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    mainWindow.loadFile(fs.existsSync(legacyPath) ? legacyPath : standalonePath);
  }

  endPhase('createWindow');

  // Speculative preloading: start project opening immediately after createWindow()
  // instead of waiting for did-finish-load (~2s later). DB init, session recovery,
  // and Claude CLI detection all overlap with the renderer loading phase.
  // IPC handlers are already registered (registerAllIpc above), and Electron queues
  // any webContents.send() calls until the renderer is ready.
  const cwd = getCwdArg();
  const projectPath = cwd || getLastOpenedProject()?.path || null;
  const preloadPromise = projectPath
    ? (async () => {
        try {
          phase('openProjectByPath');
          const project = await openProjectByPath(projectPath);
          endPhase('openProjectByPath');
          mark('project_opened');
          return project;
        } catch (err) {
          endPhase('openProjectByPath');
          console.error('[APP] Failed to preload project:', err);
          return null;
        }
      })()
    : Promise.resolve(null);

  mainWindow.webContents.on('did-finish-load', async () => {
    mark('did_finish_load');

    // Set window title to include worktree name so the taskbar entry
    // is distinguishable from the main project window.
    if (cwd && mainWindow) {
      const worktreeMatch = cwd.replace(/\\/g, '/').match(/\.kangentic\/worktrees\/([^/]+)/);
      if (worktreeMatch) {
        mainWindow.setTitle(`Kangentic -- ${worktreeMatch[1]}`);
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

  createWindow();

  // Register all IPC handlers exactly once. On macOS, closing all windows
  // doesn't quit the app (dock behavior). Re-clicking the dock icon fires
  // `activate` which recreates the window, but must NOT re-register handlers
  // (ipcMain.handle throws on duplicate registration). The activate handler
  // below calls updateMainWindow() instead.
  registerAllIpc(mainWindow!);
  initUpdater(mainWindow!);

  // Fire app_launch event (analytics initialized before app.whenReady above).
  // trackEvent is a no-op if analytics is disabled, so no guard needed here.
  trackEvent('app_launch', { platform: process.platform, arch: process.arch });

  // Load React DevTools extension in development (fire-and-forget, after window is visible)
  if (!app.isPackaged) {
    loadReactDevTools();
  }

  // Prune stale worktree projects from crashed/force-killed preview instances.
  // Only runs in the main app during development -- preview is a dev-only feature.
  if (!isEphemeral && !app.isPackaged) {
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
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    // Update the IPC context and updater window references to the newly created
    // window. IPC handlers are already registered from app.whenReady() and must
    // not be re-registered (ipcMain.handle throws on duplicate registration).
    updateMainWindow(mainWindow!);
    updateUpdaterWindow(mainWindow!);
  }
});

const HARD_SHUTDOWN_DEADLINE_MS = 6000;

/**
 * Synchronous shutdown: mark sessions as suspended in DB, kill PTYs, close DBs.
 *
 * CRITICAL: This must be fully synchronous. The previous approach used
 * event.preventDefault() + async shutdown + process.exit(), but that cancelled
 * Electron's normal quit flow. If the async chain stalled (analytics network
 * call, PTY wait, uncaught error), the app became a permanent zombie -- all
 * Chromium child processes (GPU, utility, crashpad) stayed alive because
 * Electron never reached its own cleanup. By doing only sync work and letting
 * the quit proceed, Electron's normal shutdown tears down all child processes.
 */
function syncShutdownCleanup(): void {
  // Clear pending timers that could fire during shutdown
  if (activateAllProjectsTimer) {
    clearTimeout(activateAllProjectsTimer);
    activateAllProjectsTimer = null;
  }
  stopUpdaterTimers();

  try {
    // Close active project's file watchers before killing sessions
    getBoardConfigManager().detach();

    const sessionManager = getSessionManager();
    getCommandInjector().cancelAll();

    // Mark running DB records as 'suspended' so sessions can resume on next launch.
    // This must happen BEFORE killAll() because killAll's onExit handlers could
    // race and overwrite status to 'exited'.
    const allSessions = sessionManager.listSessions();
    const sessionsByProject = new Map<string, typeof allSessions>();
    for (const session of allSessions) {
      if (session.status === 'running' || session.status === 'queued') {
        const existing = sessionsByProject.get(session.projectId) || [];
        existing.push(session);
        sessionsByProject.set(session.projectId, existing);
      }
    }

    for (const [projectId, sessions] of sessionsByProject) {
      try {
        const db = getProjectDb(projectId);
        const sessionRepo = new SessionRepository(db);
        const now = new Date().toISOString();
        for (const session of sessions) {
          const record = sessionRepo.getLatestForTask(session.taskId);
          if (record && record.status === 'running') {
            sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: now, suspended_by: 'system' });
          }
        }
      } catch {
        // DB may already be closing
      }
    }

    // Kill all PTY sessions immediately. We skip the graceful suspendAll()
    // (which sends /exit and waits up to 2s) to keep shutdown synchronous.
    // Sessions are resumable via --resume <claude_session_id> from the DB record.
    sessionManager.killAll();

    // Ephemeral cleanup: delete project from index so it doesn't show on next launch.
    // The worktree directory cleanup (async) is skipped here -- pruneStaleWorktreeProjects()
    // handles it on next launch of the main app.
    if (isEphemeral) {
      const projectId = getCurrentProjectId();
      if (projectId) {
        deleteProjectFromIndex(projectId);
      }
    }

    closeAll();
  } catch (error) {
    console.error('[APP] Shutdown error:', error);
  }
}

/**
 * Start the hard failsafe timer. If Electron's normal shutdown hangs (e.g.
 * GPU process won't terminate), this guarantees process termination. On Windows,
 * uses taskkill /T to kill the entire process tree including Chromium children.
 */
function startHardShutdownFailsafe(): void {
  setTimeout(() => {
    console.error('[APP] Hard shutdown deadline reached -- forcing exit');
    if (process.platform === 'win32') {
      try {
        require('child_process').execSync(
          `taskkill /PID ${process.pid} /T /F`,
          { windowsHide: true, stdio: 'ignore' },
        );
      } catch {
        // taskkill may fail if process is already dying
      }
    } else {
      // macOS/Linux: SIGKILL the process group to ensure child processes are cleaned up.
      // Negative PID targets the entire process group, not just the main process.
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        // Process may already be dying
      }
    }
    process.exit(1);
  }, HARD_SHUTDOWN_DEADLINE_MS);
}

app.on('before-quit', () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Hard failsafe: if Electron's normal shutdown hangs, force-kill everything
  startHardShutdownFailsafe();

  // Fire-and-forget shutdown analytics (don't await -- must not block quit)
  const durationSeconds = Math.round((Date.now() - appLaunchTime) / 1000);
  trackEvent('app_close', { durationSeconds });

  // Synchronous cleanup -- then let the quit proceed normally so Electron
  // tears down all Chromium child processes (GPU, utility, crashpad, etc.)
  syncShutdownCleanup();
});

// Handle force-close (Ctrl+C / SIGINT / SIGTERM) which may not fire before-quit
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    startHardShutdownFailsafe();
    syncShutdownCleanup();
    process.exit(0);
  });
}
