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

const timeout = setTimeout(() => process.exit(0), 30000);
process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  // Gemini exit sequence is Ctrl+C followed by `/quit\r`.
  if (data.includes('\x03') || data.includes('/quit')) {
    clearTimeout(timeout);
    process.exit(0);
  }
});
