#!/usr/bin/env node

// Kangentic CLI entry point
// Usage: kgnt [path]   — opens the Kanban board linked to the given (or current) directory
//        kgnt --reset  — deletes all app data (databases, config) and exits

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const args = process.argv.slice(2);

// --reset: wipe all app data and exit
if (args.includes('--reset')) {
  const platform = process.platform;
  let base;
  if (platform === 'win32') {
    base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  }
  const dataDir = path.join(base, 'kangentic');

  if (!fs.existsSync(dataDir)) {
    console.log('Nothing to reset — no data directory found.');
    process.exit(0);
  }

  // Delete databases and config (preserve Electron cache dirs)
  const toDelete = ['index.db', 'index.db-shm', 'index.db-wal', 'config.json', 'projects'];
  let deleted = 0;
  let locked = false;
  for (const name of toDelete) {
    const target = path.join(dataDir, name);
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        deleted++;
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
          locked = true;
        } else {
          throw err;
        }
      }
    }
  }

  if (locked) {
    console.error('Error: database files are locked — close Kangentic first, then retry.');
    process.exit(1);
  } else if (deleted > 0) {
    console.log('Reset complete — all projects, databases, and config removed.');
    console.log('Next launch will start fresh.');
  } else {
    console.log('Nothing to reset — app data was already clean.');
  }
  process.exit(0);
}

// Find the electron binary
let electronPath;
try {
  electronPath = require('electron');
} catch {
  console.error('Error: electron not found. Run from the project directory or install globally.');
  process.exit(1);
}

const appPath = path.join(__dirname, '..');

// Determine the target project directory:
// - If a positional arg is given, resolve it
// - Otherwise, use the current working directory
let targetDir = process.cwd();
if (args.length > 0 && !args[0].startsWith('-')) {
  targetDir = path.resolve(args[0]);
}

// Launch Electron with --cwd pointing to the target directory
const child = spawn(electronPath, [appPath, `--cwd=${targetDir}`], {
  stdio: 'inherit',
  detached: process.platform !== 'win32',
});

child.on('close', (code) => {
  process.exit(code || 0);
});

// Don't wait for the Electron process on unix
if (process.platform !== 'win32') {
  child.unref();
}
