import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { registerAllIpc, getSessionManager, getCurrentProjectId, openProjectByPath } from './ipc/register-all';
import { closeAll, getProjectDb } from './db/database';
import { SessionRepository } from './db/repositories/session-repository';
import { IPC } from '../shared/ipc-channels';

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

const createWindow = () => {
  const isTest = process.env.NODE_ENV === 'test';

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#18181b',
    show: !isTest,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Register all IPC handlers
  registerAllIpc(mainWindow);

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
    if (cwd && mainWindow) {
      try {
        const project = await openProjectByPath(cwd);
        mainWindow.webContents.send(IPC.PROJECT_AUTO_OPENED, project);
      } catch (err) {
        console.error('Failed to auto-open project:', err);
      }
    }
  });
};

app.whenReady().then(createWindow);

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
  const projectId = getCurrentProjectId();

  // Mark running DB records as 'suspended' BEFORE calling suspendAll().
  // suspendAll() triggers PTY exits whose async onExit handler would
  // otherwise race and overwrite 'running' → 'exited', preventing resume.
  if (projectId) {
    try {
      const db = getProjectDb(projectId);
      const sessionRepo = new SessionRepository(db);
      const now = new Date().toISOString();
      for (const session of sessionManager.listSessions()) {
        if (session.status === 'running' || session.status === 'queued') {
          const record = sessionRepo.getLatestForTask(session.taskId);
          if (record && record.status === 'running') {
            sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: now });
          }
        }
      }
    } catch {
      // DB may already be closing
    }
  }

  // Gracefully suspend running sessions — sends /exit then waits for
  // Claude Code to save its conversation state before force-killing.
  await sessionManager.suspendAll();

  sessionManager.killAll();
  closeAll();
}

let isShuttingDown = false;

app.on('before-quit', (event) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Delay quit until async shutdown completes
  event.preventDefault();
  shutdownSessions().finally(() => {
    app.exit(0);
  });
});

// Handle force-close (Ctrl+C / SIGINT / SIGTERM) which may not fire before-quit
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    shutdownSessions().finally(() => {
      process.exit(0);
    });
  });
}
