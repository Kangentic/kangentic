#!/usr/bin/env node
/**
 * Mock Qwen Code CLI for E2E tests.
 *
 * Mirrors the real Qwen Code 0.15.3 on-disk layout so the Kangentic
 * adapter pipeline (filesystem capture -> locate -> parse) is exercised
 * end-to-end with realistic inputs. See
 * `src/main/agent/adapters/qwen-code/session-history-parser.ts` for the
 * canonical scheme description.
 *
 * Qwen command shapes (see src/main/agent/adapters/qwen-code/command-builder.ts):
 *   qwen --version                                                       -> detector probe
 *   qwen [--approval-mode <m>] --resume <sessionId> [-i|-p <prompt>]     -> resume
 *   qwen [--approval-mode <m>] --session-id <sessionId> [-i|-p <prompt>] -> new (caller-owned)
 *   qwen [--approval-mode <m>] [-i|-p <prompt>]                          -> new session
 *
 * Prompt is always delivered via -i (interactive TUI) or -p (one-shot).
 * Bare positional prompts are never emitted by the adapter, since real
 * Qwen Code treats them as headless / one-shot.
 *
 * `--session-id` and `--resume` are mutex (real Qwen's yargs enforces
 * this); the mock rejects with exit code 1 if both are passed.
 *
 * Markers for test assertions:
 *   MOCK_QWEN_SESSION:<id>   -> new session
 *   MOCK_QWEN_RESUMED:<id>   -> resumed session via --resume
 *   MOCK_QWEN_PROMPT:<text>  -> prompt text delivered
 *
 * Also prints `Session ID: <uuid>` so the Qwen adapter's runtime
 * `fromOutput` regex (`Session ID:\s+<uuid>`) can capture from scrollback.
 *
 * Env knobs:
 *   MOCK_QWEN_NO_HEADER=1         -> suppress the `Session ID:` header so tests
 *                                    can verify behavior when only the resume
 *                                    regex catches the ID at suspend.
 *   MOCK_QWEN_NO_SESSION_FILE=1   -> suppress the chat session JSONL file.
 *   MOCK_QWEN_KEEP_SESSION_FILE=1 -> skip the session-file cleanup on exit so
 *                                    integration tests can read it after the
 *                                    process has terminated. Tests must clean
 *                                    up themselves via afterEach.
 */

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('mock-qwen 0.0.0-test');
  process.exit(0);
}

let sessionId = null;
let resumed = false;
let callerOwnedId = false;
let prompt = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--resume' && args[i + 1]) {
    sessionId = args[i + 1];
    resumed = true;
    i++;
    continue;
  }
  if (a === '--session-id' && args[i + 1]) {
    sessionId = args[i + 1];
    callerOwnedId = true;
    i++;
    continue;
  }
  if (a === '--approval-mode') {
    if (args[i + 1] && !args[i + 1].startsWith('-')) i++;
    continue;
  }
  // -p / --prompt-non-interactive: one-shot headless mode - consume next arg as prompt.
  if (a === '-p') {
    if (args[i + 1] && !args[i + 1].startsWith('-')) {
      prompt = args[i + 1];
      i++;
    }
    continue;
  }
  // -i / --prompt-interactive: launches TUI with the prompt pre-loaded.
  // This is the flag the Kangentic adapter emits for all interactive spawns.
  if (a === '-i') {
    if (args[i + 1] && !args[i + 1].startsWith('-')) {
      prompt = args[i + 1];
      i++;
    }
    continue;
  }
  if (a.startsWith('-')) continue;
  if (prompt === null) prompt = a;
}

if (resumed && callerOwnedId) {
  console.error('mock-qwen: --resume and --session-id are mutually exclusive');
  process.exit(1);
}

if (!sessionId) sessionId = randomUUID();

// ---------- Session JSONL file ----------
// Mirrors real Qwen 0.15.3 layout:
//   ~/.qwen/projects/<sanitizeCwd(cwd)>/chats/<sessionId>.jsonl
// where sanitizeCwd lowercases on Windows then replaces every
// non-alphanumeric char with '-'.
let sessionFilePath = null;

function sanitizeCwd(cwd) {
  const normalized = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

function writeSessionFile() {
  if (process.env.MOCK_QWEN_NO_SESSION_FILE) return;
  if (resumed) return; // Resume reuses existing session file

  const spawnCwd = process.cwd();
  const projectsDir = path.join(os.homedir(), '.qwen', 'projects', sanitizeCwd(spawnCwd), 'chats');
  fs.mkdirSync(projectsDir, { recursive: true });

  sessionFilePath = path.join(projectsDir, `${sessionId}.jsonl`);

  const now = new Date();
  const userEvent = {
    uuid: randomUUID(),
    parentUuid: null,
    sessionId,
    timestamp: now.toISOString(),
    type: 'user',
    cwd: spawnCwd,
    version: 'mock-0.0.0',
    gitBranch: 'mock',
    message: { role: 'user', parts: [{ text: prompt || 'hello' }] },
  };
  const assistantEvent = {
    uuid: randomUUID(),
    parentUuid: userEvent.uuid,
    sessionId,
    timestamp: new Date(now.getTime() + 100).toISOString(),
    type: 'assistant',
    cwd: spawnCwd,
    version: 'mock-0.0.0',
    gitBranch: 'mock',
    model: 'claude-haiku-4-5-20251001',
    message: { role: 'model', parts: [{ text: 'Hello! I am mock Qwen Code.' }] },
    usageMetadata: {
      cachedContentTokenCount: 0,
      promptTokenCount: 11199,
      candidatesTokenCount: 47,
      totalTokenCount: 11246,
    },
    contextWindowSize: 200000,
  };

  // Append-only JSONL: one event per line.
  fs.writeFileSync(
    sessionFilePath,
    JSON.stringify(userEvent) + '\n' + JSON.stringify(assistantEvent) + '\n',
  );
}

function cleanupSessionFile() {
  if (!sessionFilePath) return;
  if (process.env.MOCK_QWEN_KEEP_SESSION_FILE) return;
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

if (!process.env.MOCK_QWEN_NO_HEADER) {
  console.log('Session ID: ' + sessionId);
}

if (resumed) {
  console.log('MOCK_QWEN_RESUMED:' + sessionId);
} else {
  console.log('MOCK_QWEN_SESSION:' + sessionId);
}

if (prompt) {
  console.log('MOCK_QWEN_PROMPT:' + prompt);
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
  // Qwen exit sequence is Ctrl+C followed by `/quit\r` (inherited from Gemini).
  if (data.includes('\x03') || data.includes('/quit')) {
    clearTimeout(timeout);
    process.exit(0);
  }
});
