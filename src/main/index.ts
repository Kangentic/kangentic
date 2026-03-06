import { app, BrowserWindow, Menu, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { registerAllIpc, getSessionManager, getCommandInjector, getCurrentProjectId, openProjectByPath, cleanupProject, deleteProjectFromIndex, pruneStaleWorktreeProjects, activateAllProjects } from './ipc/register-all';
import { closeAll, getProjectDb } from './db/database';
import { SessionRepository } from './db/repositories/session-repository';
import { ConfigManager } from './config/config-manager';
import { IPC } from '../shared/ipc-channels';
import { THEME_BACKGROUNDS } from '../shared/types';

// Global error handlers -- keep the app running through transient IPC/PTY errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Handle Squirrel.Windows lifecycle events (install/update/uninstall shortcuts)
if (require('electron-squirrel-startup')) app.quit();

// Auto-update from GitHub Releases (Squirrel on Windows, autoUpdater on macOS)
import { updateElectronApp } from 'update-electron-app';
if (app.isPackaged) {
  updateElectronApp({
    repo: 'Kangentic/kangentic',
    updateInterval: '1 hour',
  });
}

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
app.setAppUserModelId('com.kangentic.app');

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
    const cm = new ConfigManager();
    const config = cm.load();
    return THEME_BACKGROUNDS[config.theme] ?? '#18181b';
  } catch {
    return '#18181b';
  }
}

const createWindow = () => {
  const isTest = process.env.NODE_ENV === 'test';

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: resolveBackgroundColor(),
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
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

  // Once the renderer is ready, auto-open the project if --cwd was provided.
  // Await session recovery/reconciliation so tasks in agent columns have
  // live PTY sessions before the renderer is notified.
  mainWindow.webContents.on('did-finish-load', async () => {
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
        const project = await openProjectByPath(cwd);
        mainWindow.webContents.send(IPC.PROJECT_AUTO_OPENED, project);
      } catch (err) {
        console.error('Failed to auto-open project:', err);
      }
    }

    // Activate all other projects' sessions in the background
    activateAllProjects().catch((err) => console.error('Failed to activate all projects:', err));
  });
};

app.whenReady().then(async () => {
  // Load React DevTools extension in development
  if (!app.isPackaged) {
    try {
      const reactDevToolsId = 'fmkadmapgofadopljbjfkapdkoienihi';
      const extDir = path.join(
        os.homedir(),
        'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Extensions',
        reactDevToolsId,
      );
      if (fs.existsSync(extDir)) {
        const versions = fs.readdirSync(extDir).sort();
        const latest = versions[versions.length - 1];
        if (latest) {
          await session.defaultSession.extensions.loadExtension(path.join(extDir, latest));
          console.log('React DevTools loaded');
        }
      }
    } catch (err) {
      console.log('Failed to load React DevTools:', err);
    }
  }

  createWindow();

  // Prune stale worktree projects from crashed/force-killed preview instances.
  // Only runs in the main app during development -- preview is a dev-only feature.
  // Must run after createWindow() since pruneStaleWorktreeProjects uses IPC context
  // initialized by registerAllIpc() inside createWindow().
  if (!isEphemeral && !app.isPackaged) {
    try {
      await pruneStaleWorktreeProjects();
    } catch (err) {
      console.error('Failed to prune stale worktree projects:', err);
    }
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
  await sessionManager.suspendAll();

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
