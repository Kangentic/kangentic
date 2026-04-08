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
 * Env knobs:
 *   MOCK_CODEX_NO_HEADER=1  -> suppress the `session id:` header so tests can
 *                              exercise the scrollback fallback path.
 */

const { randomUUID } = require('node:crypto');

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('mock-codex 0.118.0-test');
  process.exit(0);
}

let sessionId = null;
let resumed = false;
let prompt = null;

// Subcommand form: `resume <id> -C <cwd>`
if (args[0] === 'resume' && args[1]) {
  sessionId = args[1];
  resumed = true;
} else {
  // New-session form: scan for the positional prompt (anything after the
  // recognized flags). We don't need to validate flags exhaustively - just
  // skip flag/value pairs and grab the first bare positional.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-C' || a === '--sandbox' || a === '--ask-for-approval') {
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

const timeout = setTimeout(() => process.exit(0), 30000);
process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  if (data.includes('\x03')) {
    clearTimeout(timeout);
    process.exit(0);
  }
});
