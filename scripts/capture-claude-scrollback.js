#!/usr/bin/env node
/**
 * Capture real Claude Code PTY scrollback for marketing fixtures.
 *
 * Spawns Claude Code in a real PTY with a simple prompt, waits for it
 * to complete, then dumps the raw scrollback as a JSON string that
 * can be pasted into marketing-fixture.ts.
 *
 * Usage: node scripts/capture-claude-scrollback.js [project-dir]
 *
 * Requires node-pty (already in devDependencies).
 */

const path = require('node:path');
const fs = require('node:fs');

let pty;
try {
  pty = require('node-pty');
} catch (error) {
  console.error('Failed to load node-pty. Try: npm rebuild node-pty');
  console.error('Error:', error.message);
  process.exit(1);
}

const projectDir = process.argv[2] || process.cwd();
const prompt = process.argv[3] || 'Read the file README.md and summarize it in 2 sentences.';
const claudePath = process.env.CLAUDE_PATH || 'claude';

const COLS = 100;
const ROWS = 30;
const TIMEOUT_SECONDS = 60;

console.error('=== Claude Code Scrollback Capture ===');
console.error(`Claude: ${claudePath}`);
console.error(`Project: ${projectDir}`);
console.error(`Prompt: ${prompt}`);
console.error(`Terminal: ${COLS}x${ROWS}`);
console.error('');

let scrollback = '';
const startTime = Date.now();

// Use bash on all platforms (Git Bash on Windows)
const shell = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
const escapedPrompt = prompt.replace(/'/g, "'\\''");
// Launch Claude Code in interactive TUI mode with acceptEdits permissions
// (no bypass dialog). The prompt is sent via stdin after TUI initializes.
const shellArgs = ['-c', `${claudePath} --permission-mode acceptEdits`];

console.error(`Spawning: ${shell} ${shellArgs.join(' ')}\n`);

const ptyProcess = pty.spawn(shell, shellArgs, {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: projectDir,
  env: { ...process.env, TERM: 'xterm-256color' },
});

console.error(`PID: ${ptyProcess.pid}\n`);

let promptSent = false;

ptyProcess.onData((data) => {
  scrollback += data;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`[${elapsed}s] +${data.length} bytes (total: ${scrollback.length})`);

  // Wait for the TUI input prompt to appear
  if (!promptSent && (Date.now() - startTime) > 3000 && scrollback.length > 500) {
    promptSent = true;
    saveSnapshot('pre-prompt');
    setTimeout(() => {
      console.error(`\n[${((Date.now() - startTime) / 1000).toFixed(1)}s] Sending prompt: ${prompt}\n`);
      ptyProcess.write(prompt + '\r');
    }, 500);
  }

  // Save snapshots at interesting moments (large data bursts suggest tool output)
  if (promptSent && data.length > 200) {
    saveSnapshot(`burst-${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  }
});

// Save periodic snapshots of the scrollback so we can pick the best frame
const snapshots = [];

function saveSnapshot(label) {
  let snap = scrollback;
  const clearIdx = snap.indexOf('\x1b[2J');
  if (clearIdx > 0) snap = snap.slice(clearIdx);
  snap = '\x1b[0m' + snap;
  snapshots.push({ label, length: snap.length, data: snap });
  console.error(`  [snapshot] ${label}: ${snap.length} bytes`);
}

ptyProcess.onExit(({ exitCode }) => {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n[${elapsed}s] Exited with code ${exitCode}`);
  saveSnapshot('exit');
  saveAll();
  process.exit(0);
});

function saveAll() {
  const outputDir = path.join(__dirname, '..', 'tests', 'captures', 'fixtures');
  fs.mkdirSync(outputDir, { recursive: true });

  // Save the final scrollback
  const finalSnap = snapshots[snapshots.length - 1];
  fs.writeFileSync(path.join(outputDir, 'scrollback-sample.json'), JSON.stringify(finalSnap.data));

  // Save all snapshots for manual inspection
  snapshots.forEach((snap, i) => {
    fs.writeFileSync(path.join(outputDir, `scrollback-snap-${i}-${snap.label}.json`), JSON.stringify(snap.data));
  });

  console.error(`\nSaved ${snapshots.length} snapshots to: ${outputDir}`);
}

setTimeout(() => {
  console.error(`\nTimeout after ${TIMEOUT_SECONDS}s, killing...`);
  saveSnapshot('timeout');
  ptyProcess.kill();
  setTimeout(() => { saveAll(); process.exit(0); }, 1000);
}, TIMEOUT_SECONDS * 1000);

process.on('SIGINT', () => {
  console.error('\nInterrupted, killing...');
  ptyProcess.kill();
});
