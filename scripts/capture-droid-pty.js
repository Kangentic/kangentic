#!/usr/bin/env node
/**
 * Capture real Droid PTY output to understand TUI redraw behavior.
 *
 * Spawns Factory Droid in a real PTY, captures every data chunk with timing,
 * and analyzes: chunk sizes, content after ANSI stripping, whether
 * consecutive frames are identical, and whether detectIdle patterns match.
 *
 * Usage: node scripts/capture-droid-pty.js [project-dir]
 *
 * Requires node-pty (already in devDependencies).
 * Run from the worktree root so node-pty resolves.
 *
 * This is a development diagnostic tool, not used in production. Mirrors
 * scripts/capture-codex-pty.js with Droid-specific deltas:
 *   - No trust-dialog auto-approve (Droid does not prompt)
 *   - Spawn command uses `droid --cwd <projectDir> "..."` (no `--full-auto`)
 *
 * Used to seed the noise patterns in
 * src/main/agent/adapters/droid/transcript-cleanup.ts.
 */

const path = require('node:path');
const childProcess = require('node:child_process');

let pty;
try {
  pty = require('node-pty');
} catch (error) {
  console.error('Failed to load node-pty. It may be rebuilt for Electron.');
  console.error('Try: npm rebuild node-pty');
  console.error('Error:', error.message);
  process.exit(1);
}

// --- ANSI stripping (same as stripAnsiEscapes in transcript-writer.ts) ---
function stripAnsi(text) {
  let result = text.replace(
    /(?:\x1b[P\]X^_]|\x90|\x9d|\x9e|\x9f|\x98)[\s\S]*?(?:\x1b\\|\x07|\x9c)/g, '');
  result = result.replace(
    /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '');
  result = result.replace(/\x1b[\x20-\x7e]/g, '');
  result = result.replace(/[\x80-\x9f]/g, '');
  result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  result = result.replace(/\r\n/g, '\n');
  result = result.replace(/\r/g, '\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.replace(/[ \t]+$/gm, '');
  return result;
}

function findDroidBinary() {
  // Mirrors the lookup in scripts/test-transcript-cleanup.ts: prefer .cmd/.exe
  // on Windows so node-pty does not hit error code 193 from a bare script.
  try {
    const lookupCommand = process.platform === 'win32' ? 'where droid' : 'which droid';
    const output = childProcess.execSync(lookupCommand, { encoding: 'utf8' });
    const candidates = output.trim().split('\n').map((line) => line.trim());
    if (process.platform === 'win32') {
      const cmdOrExe = candidates.find((candidate) => /\.(cmd|exe)$/i.test(candidate));
      return cmdOrExe || candidates[0] || null;
    }
    return candidates[0] || null;
  } catch {
    return null;
  }
}

const projectDir = process.argv[2] || process.cwd();
const droidPath = findDroidBinary();
const CAPTURE_SECONDS = 30;

if (!droidPath) {
  console.error('Could not find droid on PATH. Install Factory Droid or run `where droid`.');
  process.exit(1);
}

console.log('=== Droid PTY Capture ===');
console.log(`Droid: ${droidPath}`);
console.log(`Project: ${projectDir}`);
console.log(`Duration: ${CAPTURE_SECONDS}s`);
console.log(`Platform: ${process.platform}`);
console.log('');

const startTime = Date.now();
const chunks = [];
let lastStrippedTrimmed = '';

function elapsed() {
  return ((Date.now() - startTime) / 1000).toFixed(2).padStart(7);
}

const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
const shellArgs = process.platform === 'win32'
  ? ['-NoProfile', '-Command', `& "${droidPath}" --cwd "${projectDir}" "Say hello and nothing else"`]
  : ['-c', `"${droidPath}" --cwd "${projectDir}" "Say hello and nothing else"`];

console.log(`Spawning: ${shell} ${shellArgs.join(' ')}\n`);

const ptyProcess = pty.spawn(shell, shellArgs, {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: projectDir,
  env: { ...process.env, TERM: 'xterm-256color' },
});

console.log(`PID: ${ptyProcess.pid}\n`);
console.log('--- Live Chunk Log ---');

ptyProcess.onData((data) => {
  const now = Date.now();
  const stripped = stripAnsi(data);
  const strippedTrimmed = stripped.trim();
  const isDuplicate = strippedTrimmed.length > 0 && strippedTrimmed === lastStrippedTrimmed;
  const isAnsiOnly = strippedTrimmed.length === 0 && data.length > 0;

  chunks.push({
    time: now - startTime,
    rawLength: data.length,
    strippedLength: strippedTrimmed.length,
    isAnsiOnly,
    isDuplicate,
    strippedPreview: strippedTrimmed.slice(0, 120).replace(/\n/g, '\\n'),
  });

  const tags = [];
  if (isAnsiOnly) tags.push('ANSI');
  if (isDuplicate) tags.push('DUP');
  const tagStr = tags.length > 0 ? ` [${tags.join(',')}]` : '';

  console.log(`[${elapsed()}s] ${data.length.toString().padStart(5)}B raw, ${strippedTrimmed.length.toString().padStart(4)}B stripped${tagStr}`);
  if (strippedTrimmed.length > 0 && strippedTrimmed.length < 200) {
    console.log(`           "${strippedTrimmed.slice(0, 120).replace(/\n/g, '\\n')}"`);
  }

  if (strippedTrimmed.length > 0) {
    lastStrippedTrimmed = strippedTrimmed;
  }
});

ptyProcess.onExit(({ exitCode }) => {
  console.log(`\n[${elapsed()}s] PTY exited with code ${exitCode}`);
  printAnalysis();
  process.exit(0);
});

setTimeout(() => {
  console.log(`\n[${elapsed()}s] Capture time elapsed, killing PTY...`);
  ptyProcess.kill();
  setTimeout(() => { printAnalysis(); process.exit(0); }, 1000);
}, CAPTURE_SECONDS * 1000);

process.on('SIGINT', () => {
  console.log('\nInterrupted, killing PTY...');
  ptyProcess.kill();
  setTimeout(() => { printAnalysis(); process.exit(0); }, 500);
});

function printAnalysis() {
  console.log('\n=== Analysis ===\n');
  const total = chunks.length;
  const ansiOnly = chunks.filter(c => c.isAnsiOnly).length;
  const duplicates = chunks.filter(c => c.isDuplicate).length;
  const significant = chunks.filter(c => !c.isAnsiOnly && !c.isDuplicate).length;

  console.log(`Total chunks: ${total}`);
  console.log(`  Significant (new content): ${significant}`);
  console.log(`  Duplicate frames:          ${duplicates}`);
  console.log(`  ANSI-only chunks:          ${ansiOnly}`);

  const lastSigIndex = chunks.findLastIndex(c => !c.isAnsiOnly && !c.isDuplicate);
  if (lastSigIndex >= 0) {
    const lastSigChunk = chunks[lastSigIndex];
    console.log(`\nLast significant output at: ${(lastSigChunk.time / 1000).toFixed(2)}s`);
    const tail = chunks.slice(lastSigIndex + 1);
    if (tail.length > 0) {
      console.log(`Chunks after: ${tail.length} (${tail.filter(c => c.isDuplicate).length} dups, ${tail.filter(c => c.isAnsiOnly).length} ANSI)`);
    } else {
      console.log('Complete silence after final significant chunk.');
    }
  }
}
