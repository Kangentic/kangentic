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

app.on('before-quit', () => {
  const sessionManager = getSessionManager();
  const projectId = getCurrentProjectId();

  // Suspend running sessions instead of killing them outright
  const suspendedIds = sessionManager.suspendAll();

  // Persist suspended status to DB
  if (projectId && suspendedIds.length > 0) {
    try {
      const db = getProjectDb(projectId);
      const sessionRepo = new SessionRepository(db);
      const now = new Date().toISOString();
      for (const sessionId of suspendedIds) {
        // Find session record by claude_session_id (which matches the PTY session ID)
        const record = db.prepare(
          `SELECT id FROM sessions WHERE claude_session_id = ? AND status = 'running' LIMIT 1`
        ).get(sessionId) as { id: string } | undefined;
        if (record) {
          sessionRepo.updateStatus(record.id, 'suspended', { suspended_at: now });
        }
      }
    } catch {
      // DB may already be closing
    }
  }

  sessionManager.killAll();
  closeAll();
});
