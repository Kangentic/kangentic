#!/usr/bin/env node
/**
 * Mock Gemini CLI for E2E tests.
 *
 * Gemini command shapes (see src/main/agent/adapters/gemini/command-builder.ts):
 *   gemini --version                                            -> detector probe
 *   gemini [--approval-mode <m>] --resume <sessionId> [prompt]  -> resume
 *   gemini [--approval-mode <m>] [-p] [prompt]                  -> new session
 *
 * Markers for test assertions:
 *   MOCK_GEMINI_SESSION:<id>   -> new session
 *   MOCK_GEMINI_RESUMED:<id>   -> resumed session via --resume
 *   MOCK_GEMINI_PROMPT:<text>  -> prompt text delivered
 *
 * Also prints `Session ID: <uuid>` so the Gemini adapter's runtime
 * `fromOutput` regex (`Session ID:\s+<uuid>`) can capture from scrollback.
 *
 * Env knobs:
 *   MOCK_GEMINI_NO_HEADER=1  -> suppress the `Session ID:` header so tests
 *                               can verify behavior when only the resume
 *                               regex catches the ID at suspend.
 */

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('mock-gemini 0.0.0-test');
  process.exit(0);
}

let sessionId = null;
let resumed = false;
let prompt = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--resume' && args[i + 1]) {
    sessionId = args[i + 1];
    resumed = true;
    i++;
    continue;
  }
  if (a === '--approval-mode' || a === '-p') {
    if (args[i + 1] && !args[i + 1].startsWith('-')) i++;
    continue;
  }
  if (a.startsWith('-')) continue;
  if (prompt === null) prompt = a;
}

if (!sessionId) sessionId = randomUUID();

// ---------- Session JSON file ----------
// Writes a realistic session JSON to ~/.gemini/tmp/<basename(cwd)>/chats/
// so the session history reader pipeline (captureSessionIdFromFilesystem ->
// locate -> parse) is exercised end-to-end. Cleaned up on process exit.
//
// Env knobs:
//   MOCK_GEMINI_NO_SESSION_FILE=1 -> suppress session file creation
let sessionFilePath = null;

function writeSessionFile() {
  if (process.env.MOCK_GEMINI_NO_SESSION_FILE) return;
  if (resumed) return; // Resume reuses existing session file

  const spawnCwd = process.cwd();
  const projectDirName = path.basename(spawnCwd).toLowerCase();
  const chatsDir = path.join(os.homedir(), '.gemini', 'tmp', projectDirName, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });

  const now = new Date();
  const shortId = sessionId.slice(0, 8);
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const fileName = 'session-' + timestamp + shortId + '.json';
  sessionFilePath = path.join(chatsDir, fileName);

  const content = JSON.stringify({
    sessionId: sessionId,
    projectHash: 'mock-hash',
    startTime: now.toISOString(),
    lastUpdated: now.toISOString(),
    messages: [
      {
        id: 'user-1',
        timestamp: now.toISOString(),
        type: 'user',
        content: [{ text: prompt || 'hello' }],
      },
      {
        id: 'gemini-1',
        timestamp: now.toISOString(),
        type: 'gemini',
        content: 'Hello! I am mock Gemini.',
        tokens: { input: 11199, output: 47, cached: 0, thoughts: 0, tool: 0, total: 11246 },
        model: 'gemini-3-flash-preview',
      },
    ],
    kind: 'main',
  }, null, 2);

  fs.writeFileSync(sessionFilePath, content);
}

function cleanupSessionFile() {
  if (!sessionFilePath) return;
  const toDelete = sessionFilePath;
  sessionFilePath = null; // Prevent double-cleanup
  try { fs.unlinkSync(toDelete); } catch { /* may already be gone */ }
  // Clean up the chats directory if empty
  try {
    const parentDir = path.dirname(toDelete);
    const remaining = fs.readdirSync(parentDir);
    if (remaining.length === 0) fs.rmSync(parentDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

writeSessionFile();

// ---------- PTY output ----------

if (!process.env.MOCK_GEMINI_NO_HEADER) {
  console.log('Session ID: ' + sessionId);
}

if (resumed) {
  console.log('MOCK_GEMINI_RESUMED:' + sessionId);
} else {
  console.log('MOCK_GEMINI_SESSION:' + sessionId);
}

if (prompt) {
  console.log('MOCK_GEMINI_PROMPT:' + prompt);
}

// Hide-cursor escape so detectFirstOutput() returns true.
process.stdout.write('\x1b[?25l');

const timeout = setTimeout(() => { cleanupSessionFile(); process.exit(0); }, 30000);
process.on('SIGTERM', () => { clearTimeout(timeout); cleanupSessionFile(); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); cleanupSessionFile(); process.exit(0); });
process.on('exit', cleanupSessionFile);

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  // Gemini exit sequence is Ctrl+C followed by `/quit\r`.
  if (data.includes('\x03') || data.includes('/quit')) {
    clearTimeout(timeout);
    process.exit(0);
  }
});
