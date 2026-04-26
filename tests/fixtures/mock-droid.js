#!/usr/bin/env node
/**
 * Mock Droid CLI for E2E tests.
 *
 * Droid command shapes (see src/main/agent/adapters/droid/command-builder.ts):
 *   droid --version                                    -> detector probe
 *   droid --cwd <cwd> "<prompt>"                       -> new session
 *   droid --cwd <cwd> --resume <uuid> "<prompt>"       -> resume existing
 *
 * Markers for test assertions:
 *   MOCK_DROID_SESSION:<id>   -> new session started
 *   MOCK_DROID_RESUMED:<id>   -> resumed session via --resume <uuid>
 *   MOCK_DROID_PROMPT:<text>  -> prompt text delivered
 *
 * Writes a session JSONL file to ~/.factory/sessions/<cwd-slug>/<uuid>.jsonl
 * so the DroidAdapter filesystem-based capture pipeline is exercised end-to-end.
 * The file is created synchronously at startup and cleaned up on process exit.
 *
 * The cwd slug follows the exact pattern from session-id-capture.ts:
 *   replace [\:\\/]+ with '-', ensure leading '-'.
 */

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('droid 0.109.1-mock');
  process.exit(0);
}

let sessionId = null;
let resumed = false;
let prompt = null;
let cwd = null;

// Parse --cwd, --resume, and positional prompt from args.
for (let argIndex = 0; argIndex < args.length; argIndex++) {
  const currentArg = args[argIndex];
  if (currentArg === '--cwd') {
    cwd = args[++argIndex];
    continue;
  }
  if (currentArg === '--resume') {
    sessionId = args[++argIndex];
    resumed = true;
    continue;
  }
  if (currentArg.startsWith('-')) continue;
  // First bare positional is the prompt.
  if (prompt === null) prompt = currentArg;
}

if (!sessionId) {
  sessionId = randomUUID();
}

// Resolve the effective cwd: prefer the --cwd argument, fall back to process.cwd().
const effectiveCwd = cwd || process.cwd();

// ---------- Session JSONL ----------
// Writes ~/.factory/sessions/<cwd-slug>/<uuid>.jsonl so the
// captureSessionIdFromFilesystem() scanner picks up the UUID.

let sessionFilePath = null;

function cwdToSessionSlug(cwdPath) {
  // Mirror the logic in session-id-capture.ts exactly:
  //   replace runs of [\:\\/] with '-', ensure leading '-'.
  const replaced = cwdPath.replace(/[:\\/]+/g, '-');
  return replaced.startsWith('-') ? replaced : '-' + replaced;
}

function writeSessionFile() {
  const slug = cwdToSessionSlug(effectiveCwd);
  const sessionDir = path.join(os.homedir(), '.factory', 'sessions', slug);
  fs.mkdirSync(sessionDir, { recursive: true });

  const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
  const isoTimestamp = new Date().toISOString();

  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session_start',
      id: sessionId,
      title: prompt || '',
      cwd: effectiveCwd.replace(/\\/g, '/'),
      timestamp: isoTimestamp,
    }) + '\n',
  );

  sessionFilePath = sessionFile;
}

function cleanupSessionFile() {
  if (!sessionFilePath) return;
  const fileToDelete = sessionFilePath;
  sessionFilePath = null;
  try { fs.unlinkSync(fileToDelete); } catch { /* may already be gone */ }
  // Try to remove the slug directory if it is now empty.
  try {
    const parentDir = path.dirname(fileToDelete);
    const remaining = fs.readdirSync(parentDir);
    if (remaining.length === 0) {
      fs.rmdirSync(parentDir);
    }
  } catch { /* ignore */ }
}

writeSessionFile();

// ---------- PTY output ----------

// Cursor-hide ANSI sequence so detectFirstOutput() returns true and the
// shimmer overlay clears. Empirically Droid 0.109.1 emits this sequence
// as the first PTY output when its Ink TUI takes over the terminal.
process.stdout.write('\x1b[?25l');

if (resumed) {
  console.log('MOCK_DROID_RESUMED:' + sessionId);
} else {
  console.log('MOCK_DROID_SESSION:' + sessionId);
}

if (prompt) {
  console.log('MOCK_DROID_PROMPT:' + prompt);
}

// Simulate the Droid TUI banner so tests can assert a stable marker.
console.log('Factory Droid (mock)');

const exitTimeout = setTimeout(() => {
  cleanupSessionFile();
  process.exit(0);
}, 30000);

process.on('SIGTERM', () => {
  clearTimeout(exitTimeout);
  cleanupSessionFile();
  process.exit(0);
});

process.on('SIGINT', () => {
  clearTimeout(exitTimeout);
  cleanupSessionFile();
  process.exit(0);
});

process.on('exit', () => {
  cleanupSessionFile();
});

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  if (data.includes('\x03')) {
    clearTimeout(exitTimeout);
    cleanupSessionFile();
    process.exit(0);
  }
  // /quit is the graceful exit sequence DroidAdapter sends.
  if (data.includes('/quit')) {
    clearTimeout(exitTimeout);
    cleanupSessionFile();
    process.exit(0);
  }
});
