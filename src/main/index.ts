const PROCESS_START = performance.now();

import { app, BrowserWindow, Menu, nativeImage, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { registerAllIpc, getSessionManager, getCommandInjector, getCurrentProjectId, openProjectByPath, cleanupProject, deleteProjectFromIndex, pruneStaleWorktreeProjects, activateAllProjects, getLastOpenedProject } from './ipc/register-all';
import { closeAll, getProjectDb } from './db/database';
import { SessionRepository } from './db/repositories/session-repository';
import { IPC } from '../shared/ipc-channels';
import { THEME_BACKGROUNDS } from '../shared/types';
import type { ThemeMode } from '../shared/types';
import { PATHS } from './config/paths';
import { initAnalytics, trackEvent } from './analytics/analytics';
import { initStartupTimer, mark, phase, endPhase, finishStartupTimer } from './startup-timer';

initStartupTimer(PROCESS_START);
mark('process_start');

// Global error handlers -- keep the app running through transient IPC/PTY errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Handle Squirrel.Windows lifecycle events (install/update/uninstall shortcuts)
import squirrelStartup from 'electron-squirrel-startup';
if (process.platform === 'win32' && squirrelStartup) app.quit();

// Auto-update from GitHub Releases (Squirrel on Windows, autoUpdater on macOS).
// Linux has no Squirrel/autoUpdater backend -- users update via the launcher package.
import { updateElectronApp } from 'update-electron-app';
if (app.isPackaged && process.platform !== 'linux') {
  updateElectronApp({
    repo: 'Kangentic/kangentic',
    updateInterval: '1 hour',
  });
}

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

// Tell Windows to display "Kangentic" in notification toasts instead of "Electron"
app.setAppUserModelId('com.squirrel.Kangentic.kangentic');

const isEphemeral = process.argv.includes('--ephemeral');

let mainWindow: BrowserWindow | null = null;

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
    .then(() => console.log('React DevTools loaded'))
    .catch((err) => console.log('Failed to load React DevTools:', err));
}

const createWindow = () => {
  phase('createWindow');
  const isTest = process.env.NODE_ENV === 'test';

  const iconPath = resolveIconPath();
  const iconImage = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    icon: iconImage,
    width: 1400,
    height: 900,
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
    if (!isTest) {
      mainWindow!.maximize();
    }
    mainWindow!.show();
  });

  // Register all IPC handlers
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

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    // Forge puts renderer at ../renderer/, standalone build puts it at ./renderer/
    const forgePath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    const standalonePath = path.join(__dirname, `renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    mainWindow.loadFile(fs.existsSync(forgePath) ? forgePath : standalonePath);
  }

  endPhase('createWindow');

  // Once the renderer is ready, auto-open the project if --cwd was provided.
  // Await session recovery/reconciliation so tasks in agent columns have
  // live PTY sessions before the renderer is notified.
  mainWindow.webContents.on('did-finish-load', async () => {
    mark('did_finish_load');
    const cwd = getCwdArg();

    // Set window title to include worktree name so the taskbar entry
    // is distinguishable from the main project window.
    if (cwd && mainWindow) {
      const worktreeMatch = cwd.replace(/\\/g, '/').match(/\.kangentic\/worktrees\/([^/]+)/);
      if (worktreeMatch) {
        mainWindow.setTitle(`Kangentic -- ${worktreeMatch[1]}`);
      }
    }

    if (cwd && mainWindow) {
      try {
        phase('openProjectByPath');
        const project = await openProjectByPath(cwd);
        endPhase('openProjectByPath');
        mark('project_opened');
        finishStartupTimer();
        mainWindow.webContents.send(IPC.PROJECT_AUTO_OPENED, project);
      } catch (err) {
        endPhase('openProjectByPath');
        console.error('Failed to auto-open project:', err);
      }
    }

    // Auto-open the last activated project if no --cwd was provided
    if (!cwd && mainWindow) {
      const lastProject = getLastOpenedProject();
      if (lastProject) {
        try {
          phase('openProjectByPath');
          const project = await openProjectByPath(lastProject.path);
          endPhase('openProjectByPath');
          mark('project_opened');
          finishStartupTimer();
          mainWindow.webContents.send(IPC.PROJECT_AUTO_OPENED, project);
        } catch (err) {
          endPhase('openProjectByPath');
          console.error('Failed to auto-open last project:', err);
        }
      } else {
        finishStartupTimer();
      }
    }

    // Activate all other projects' sessions in the background.
    // Defer by 5 seconds so the primary project's recovery completes
    // without CPU/IO contention from all other projects.
    setTimeout(() => {
      phase('activateAllProjects');
      activateAllProjects()
        .catch((err) => console.error('Failed to activate all projects:', err))
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
    ? Menu.buildFromTemplate([{ role: 'editMenu' }])
    : null,
);

app.whenReady().then(async () => {
  mark('app_ready');
  createWindow();

  // Fire app_launch event (analytics initialized before app.whenReady above).
  // trackEvent is a no-op if analytics is disabled, so no guard needed here.
  trackEvent('app_launch', { platform: process.platform, arch: process.arch });

  // Load React DevTools extension in development (fire-and-forget, after window is visible)
  if (!app.isPackaged) {
    loadReactDevTools();
  }

  // Prune stale worktree projects from crashed/force-killed preview instances.
  // Only runs in the main app during development -- preview is a dev-only feature.
  // Must run after createWindow() since pruneStaleWorktreeProjects uses IPC context
  // initialized by registerAllIpc() inside createWindow().
  if (!isEphemeral && !app.isPackaged) {
    phase('pruneStaleWorktreeProjects');
    pruneStaleWorktreeProjects()
      .catch((err) => console.error('Failed to prune stale worktree projects:', err))
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
  }
});

async function shutdownSessions(): Promise<void> {
  const sessionManager = getSessionManager();
  getCommandInjector().cancelAll();

  // Mark running DB records as 'suspended' BEFORE calling suspendAll().
  // suspendAll() triggers PTY exits whose async onExit handler would
  // otherwise race and overwrite 'running' → 'exited', preventing resume.
  // Group sessions by projectId so we suspend across ALL active projects.
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
          sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: now });
        }
      }
    } catch {
      // DB may already be closing
    }
  }

  // Gracefully suspend running sessions -- sends /exit then waits for
  // Claude Code to save its conversation state before force-killing.
  if (!app.isPackaged) console.time('[shutdown] suspendAll');
  await sessionManager.suspendAll();
  if (!app.isPackaged) console.timeEnd('[shutdown] suspendAll');

  sessionManager.killAll();
  closeAll();
}

async function shutdownEphemeral(): Promise<void> {
  const sessionManager = getSessionManager();
  getCommandInjector().cancelAll();
  sessionManager.killAll();

  const projectId = getCurrentProjectId();
  const cwd = getCwdArg();
  if (projectId && cwd) {
    await cleanupProject(projectId, cwd);
    deleteProjectFromIndex(projectId);
  }

  closeAll();
}

let isShuttingDown = false;

app.on('before-quit', (event) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Delay quit until async shutdown completes
  event.preventDefault();
  const shutdown = isEphemeral ? shutdownEphemeral() : shutdownSessions();
  shutdown.finally(() => {
    app.exit(0);
  });
});

// Handle force-close (Ctrl+C / SIGINT / SIGTERM) which may not fire before-quit
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const shutdown = isEphemeral ? shutdownEphemeral() : shutdownSessions();
    shutdown.finally(() => {
      process.exit(0);
    });
  });
}
