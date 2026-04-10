#!/usr/bin/env node
/**
 * Mock Codex CLI for E2E tests.
 *
 * Codex command shapes (see src/main/agent/adapters/codex/command-builder.ts):
 *   codex --version                                  -> detector probe
 *   codex resume <sessionId> -C <cwd>                -> resume existing
 *   codex -C <cwd> [--full-auto|--sandbox ...] "<prompt>"  -> new session
 *
 * Markers for test assertions (mirrors mock-claude):
 *   MOCK_CODEX_SESSION:<id>   -> new session
 *   MOCK_CODEX_RESUMED:<id>   -> resumed session via `resume` subcommand
 *   MOCK_CODEX_PROMPT:<text>  -> prompt text delivered
 *
 * Also prints `session id: <uuid>` so the Codex adapter's runtime
 * `fromOutput` regex (`session id:\s+<uuid>`) sees a real header to capture.
 *
 * Writes a rollout JSONL file to ~/.codex/sessions/<YYYY>/<MM>/<DD>/ so the
 * session history reader pipeline (captureSessionIdFromFilesystem -> locate
 * -> parse) is exercised end-to-end. Includes session_meta, task_started,
 * turn_context, token_count, response_item (function_call), and task_complete
 * entries. Cleaned up on process exit.
 *
 * Env knobs:
 *   MOCK_CODEX_NO_HEADER=1  -> suppress the `session id:` header so tests can
 *                              exercise the scrollback fallback path.
 *   MOCK_CODEX_NO_ROLLOUT=1 -> suppress rollout JSONL file creation.
 */

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('mock-codex 0.118.0-test');
  process.exit(0);
}

let sessionId = null;
let resumed = false;
let prompt = null;
let cwd = null;

// Subcommand form: `resume <id> -C <cwd>`
if (args[0] === 'resume' && args[1]) {
  sessionId = args[1];
  resumed = true;
  // Parse -C for cwd
  const cwdIndex = args.indexOf('-C');
  if (cwdIndex !== -1 && args[cwdIndex + 1]) {
    cwd = args[cwdIndex + 1];
  }
} else {
  // New-session form: scan for the positional prompt (anything after the
  // recognized flags). We don't need to validate flags exhaustively - just
  // skip flag/value pairs and grab the first bare positional.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-C') {
      cwd = args[++i];
      continue;
    }
    if (a === '--sandbox' || a === '--ask-for-approval') {
      i++; // skip value
      continue;
    }
    if (a === '--full-auto' || a === '--dangerously-bypass-approvals-and-sandbox' || a === '-q' || a === '--json') {
      continue;
    }
    if (a.startsWith('-')) continue;
    prompt = a;
    break;
  }
  sessionId = randomUUID();
}

// ---------- Rollout JSONL ----------
// Writes a realistic rollout file for the session history reader pipeline.
let rolloutPath = null;

function writeRolloutJsonl() {
  if (process.env.MOCK_CODEX_NO_ROLLOUT) return;
  if (resumed) return; // Resume reuses existing rollout

  const now = new Date();
  const iso = now.toISOString();
  const year = iso.slice(0, 4);
  const month = iso.slice(5, 7);
  const day = iso.slice(8, 10);
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions', year, month, day);
  fs.mkdirSync(sessionsDir, { recursive: true });

  // Filename matches real Codex format: rollout-<ISO-ish>-<uuid>.jsonl
  const safeTimestamp = iso.replace(/[:.]/g, '-').replace('Z', '');
  const fileName = `rollout-${safeTimestamp}-${sessionId}.jsonl`;
  rolloutPath = path.join(sessionsDir, fileName);

  // Normalize cwd to forward slashes (matches real Codex behavior)
  const normalizedCwd = (cwd || process.cwd()).replace(/\\/g, '/');

  const lines = [
    {
      timestamp: iso,
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: iso,
        cwd: normalizedCwd,
        cli_version: '0.118.0-test',
      },
    },
    {
      timestamp: iso,
      type: 'task_started',
      payload: {
        turn_id: 'turn-1',
        model_context_window: 258400,
      },
    },
    {
      timestamp: iso,
      type: 'turn_context',
      payload: {
        turn_id: 'turn-1',
        model: 'mock-codex-model',
      },
    },
    {
      timestamp: iso,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell',
        arguments: JSON.stringify({ command: ['echo', 'hello'] }),
      },
    },
    {
      timestamp: iso,
      type: 'token_count',
      payload: {
        info: {
          total_token_usage: {
            input_tokens: 11214,
            cached_input_tokens: 0,
            output_tokens: 35,
            total_tokens: 11249,
          },
          last_token_usage: {
            input_tokens: 11214,
            cached_input_tokens: 0,
            output_tokens: 35,
            total_tokens: 11249,
          },
          model_context_window: 258400,
        },
      },
    },
    {
      timestamp: iso,
      type: 'task_complete',
      payload: { turn_id: 'turn-1' },
    },
  ];

  fs.writeFileSync(rolloutPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function cleanupRollout() {
  if (!rolloutPath) return;
  const toDelete = rolloutPath;
  rolloutPath = null; // Prevent double-cleanup from exit + signal handlers
  try { fs.unlinkSync(toDelete); } catch { /* may already be gone */ }
  // Try to clean up the date directory if empty
  try {
    const parentDir = path.dirname(toDelete);
    const remaining = fs.readdirSync(parentDir);
    if (remaining.length === 0) {
      fs.rmSync(parentDir);
    }
  } catch { /* ignore */ }
}

writeRolloutJsonl();

// ---------- PTY output ----------

if (!process.env.MOCK_CODEX_NO_HEADER) {
  console.log('session id: ' + sessionId);
}

if (resumed) {
  console.log('MOCK_CODEX_RESUMED:' + sessionId);
} else {
  console.log('MOCK_CODEX_SESSION:' + sessionId);
}

if (prompt) {
  console.log('MOCK_CODEX_PROMPT:' + prompt);
}

// Hide-cursor escape so detectFirstOutput() returns true and the shimmer overlay clears.
process.stdout.write('\x1b[?25l');

const timeout = setTimeout(() => { cleanupRollout(); process.exit(0); }, 30000);
process.on('SIGTERM', () => { clearTimeout(timeout); cleanupRollout(); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); cleanupRollout(); process.exit(0); });
process.on('exit', cleanupRollout);

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  if (data.includes('\x03')) {
    clearTimeout(timeout);
    cleanupRollout();
    process.exit(0);
  }
});
