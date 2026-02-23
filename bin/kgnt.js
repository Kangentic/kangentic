#!/usr/bin/env node

// Kangentic CLI entry point
// Usage: kgnt [path]  — opens the Kanban board linked to the given (or current) directory

const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);

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
