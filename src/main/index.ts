const PROCESS_START = performance.now();

import { app, BrowserWindow, clipboard, Menu, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { registerAllIpc, getSessionManager, getCommandInjector, getBoardConfigManager, getCurrentProjectId, openProjectByPath, deleteProjectFromIndex, pruneStaleWorktreeProjects, activateAllProjects, getLastOpenedProject } from './ipc/register-all';
import { IPC } from '../shared/ipc-channels';
import { ConfigManager } from './config/config-manager';
import { isShuttingDown, setShuttingDown } from './shutdown-state';
const windowConfigManager = new ConfigManager();
import { initAnalytics, trackEvent, sanitizeErrorMessage } from './analytics/analytics';
import { initStartupTimer, mark, phase, endPhase, finishStartupTimer } from './startup-timer';
import { resolveBackgroundColor, resolveIconPath, resolveWindowBounds } from './window-utils';
import { loadReactDevTools } from './devtools';
import { syncShutdownCleanup, startHardShutdownFailsafe } from './shutdown';

initStartupTimer(PROCESS_START);
mark('process_start');

// Global error handlers -- keep the app running through transient IPC/PTY errors.
// During shutdown, skip analytics calls to avoid new network requests that block exit.
process.on('uncaughtException', (error) => {
  console.error('[APP] Uncaught exception:', error);
  if (!isShuttingDown()) {
    trackEvent('app_error', {
      source: 'uncaughtException',
      message: sanitizeErrorMessage(error.message),
    });
  }
});
process.on('unhandledRejection', (reason) => {
  console.error('[APP] Unhandled rejection:', reason);
  if (!isShuttingDown()) {
    trackEvent('app_error', {
      source: 'unhandledRejection',
      message: sanitizeErrorMessage(reason instanceof Error ? reason.message : String(reason)),
    });
  }
});

import { initUpdater, updateUpdaterWindow, stopUpdaterTimers } from './updater';
import { ensureSpawnHelperPermissions } from './pty/spawn-helper-permissions';

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

  // Register IPC handlers early so speculative preloading (below) can use them.
  // Idempotent: on macOS dock re-activation, the guard in registerAllIpc()
  // updates the window reference without re-registering handlers.
  registerAllIpc(mainWindow);

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
    // Check both relative paths: ../renderer/ (legacy Forge layout) and ./renderer/ (esbuild)
    const legacyPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    const standalonePath = path.join(__dirname, `renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    mainWindow.loadFile(fs.existsSync(legacyPath) ? legacyPath : standalonePath);
  }

  endPhase('createWindow');

  // Speculative preloading: start project opening immediately after createWindow()
  // instead of waiting for did-finish-load (~2s later). DB init, session recovery,
  // and Claude CLI detection all overlap with the renderer loading phase.
  // IPC handlers were registered earlier in this function (registerAllIpc),
  // and Electron queues any webContents.send() calls until the renderer is ready.
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

  // Fix node-pty spawn-helper permissions on macOS before any PTY spawns.
  // Must run before createWindow() which triggers session recovery.
  ensureSpawnHelperPermissions();

  createWindow();
  initUpdater(mainWindow!);

  // Fire app_launch event (analytics initialized before app.whenReady above).
  // trackEvent is a no-op if analytics is disabled, so no guard needed here.
  trackEvent('app_launch', { platform: process.platform, arch: process.arch });
  setInterval(() => {
    const sessionManager = getSessionManager();
    const counts = sessionManager.getSessionCounts();

    trackEvent('app_heartbeat', {
      activeSessions: counts.active,
      suspendedSessions: counts.suspended,
      queuedSessions: sessionManager.queuedCount,
      totalSessions: counts.total,
    });
  }, 60 * 60 * 1000);

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
  if (isShuttingDown()) return;
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    updateUpdaterWindow(mainWindow!);
  }
});

/** Build the shutdown dependencies from current module-level state. */
function getShutdownDependencies() {
  return {
    getSessionManager,
    getBoardConfigManager,
    getCommandInjector,
    getCurrentProjectId,
    deleteProjectFromIndex,
    stopUpdaterTimers,
    clearPendingTimers: () => {
      if (activateAllProjectsTimer) {
        clearTimeout(activateAllProjectsTimer);
        activateAllProjectsTimer = null;
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

  // Fire-and-forget shutdown analytics (don't await - must not block quit)
  const durationSeconds = Math.round((Date.now() - appLaunchTime) / 1000);
  trackEvent('app_close', { durationSeconds });

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
    syncShutdownCleanup(getShutdownDependencies());
    process.exit(0);
  });
}
