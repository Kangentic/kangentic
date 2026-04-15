#!/usr/bin/env node
/**
 * Mock Cursor CLI for E2E tests.
 *
 * Cursor CLI command shapes (see src/main/agent/adapters/cursor/cursor-adapter.ts):
 *   agent --version                              -> detector probe
 *   agent --resume="<chat-id>"                   -> resume existing session
 *   agent "prompt"                               -> new interactive session
 *   agent -p "prompt" --output-format stream-json -> new non-interactive session
 *
 * Markers for test assertions (mirrors mock-claude):
 *   MOCK_CURSOR_SESSION:<id>    -> new session created
 *   MOCK_CURSOR_RESUMED:<id>   -> existing session resumed via --resume
 *   MOCK_CURSOR_PROMPT:<text>  -> prompt text delivered
 *   MOCK_CURSOR_MODE:interactive   -> spawned in interactive mode
 *   MOCK_CURSOR_MODE:noninteractive -> spawned with -p flag
 *
 * Env knobs:
 *   MOCK_CURSOR_TUI_REDRAWS=1 -> emit periodic ANSI-only cursor repositioning
 *                                 sequences (500ms interval) to simulate TUI
 *                                 redraws that happen even when idle.
 *
 * Stays alive for 30 seconds to simulate a running session,
 * then exits cleanly.
 */

const { randomUUID } = require('node:crypto');

const args = process.argv.slice(2);

// Version detection (called by AgentDetector)
if (args.includes('--version')) {
  console.log('0.50.3');
  process.exit(0);
}

let sessionId = null;
let resumed = false;
let prompt = null;
let nonInteractive = false;

for (let i = 0; i < args.length; i++) {
  const argument = args[i];

  // --resume="<chat-id>" or --resume <chat-id>
  if (argument.startsWith('--resume=')) {
    sessionId = argument.slice('--resume='.length).replace(/^['"]|['"]$/g, '');
    resumed = true;
    continue;
  }
  if (argument === '--resume' && i + 1 < args.length) {
    sessionId = args[++i];
    resumed = true;
    continue;
  }

  // Non-interactive flag
  if (argument === '-p' || argument === '--print') {
    nonInteractive = true;
    continue;
  }

  // Output format (skip value)
  if (argument === '--output-format' && i + 1 < args.length) {
    i++;
    continue;
  }

  // Model override (skip value)
  if (argument === '--model' && i + 1 < args.length) {
    i++;
    continue;
  }

  // Skip other flags
  if (argument.startsWith('-')) continue;

  // First bare positional is the prompt
  if (!prompt) {
    prompt = argument;
  }
}

// Generate a session ID for new sessions (Cursor CLI generates its own)
if (!sessionId) {
  sessionId = randomUUID();
}

// Output markers for test assertions
if (resumed) {
  console.log('MOCK_CURSOR_RESUMED:' + sessionId);
} else {
  console.log('MOCK_CURSOR_SESSION:' + sessionId);
}

if (nonInteractive) {
  console.log('MOCK_CURSOR_MODE:noninteractive');
  // Emit realistic NDJSON events matching Cursor CLI's stream-json format.
  // The init event contains session_id which the adapter's runtime.sessionId
  // .fromOutput parser captures for session resume.
  console.log(JSON.stringify({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'login',
    cwd: process.cwd(),
    session_id: sessionId,
    model: 'Claude 4 Sonnet',
    permissionMode: 'default',
  }));
  if (prompt) {
    console.log(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      session_id: sessionId,
    }));
    console.log(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Mock response for: ' + prompt }] },
      session_id: sessionId,
    }));
    console.log(JSON.stringify({
      type: 'result',
      subtype: 'success',
      duration_ms: 1234,
      duration_api_ms: 1234,
      is_error: false,
      result: 'Mock response for: ' + prompt,
      session_id: sessionId,
    }));
  }
} else {
  console.log('MOCK_CURSOR_MODE:interactive');
}

// Always emit the prompt marker regardless of mode - it's a test
// observability hook, not a behavioral flag. Non-interactive mode
// delivers the prompt via the NDJSON `{"type":"user",...}` event above,
// so without this line the prompt test couldn't tell the difference
// between "prompt missing" and "prompt delivered through the other path".
if (prompt) {
  console.log('MOCK_CURSOR_PROMPT:' + prompt);
}

// Simulate TUI redraws: periodic full-screen repaints with ANSI positioning
// and visible text content. Real Cursor CLI likely redraws the screen when
// idle (like Codex's Ink TUI). The content is IDENTICAL each frame - this
// is key for testing the content deduplication logic in isSignificantOutput.
let redrawInterval = null;
if (process.env.MOCK_CURSOR_TUI_REDRAWS) {
  const idleFrame =
    '\x1b[H\x1b[2J' +                                             // cursor home + clear screen
    '\x1b[1;1H\x1b[1mCursor Agent (v0.50.3)\x1b[0m\r\n' +        // header
    '\x1b[2;1Hmodel: Claude 4 Sonnet\r\n' +                       // model line
    '\x1b[4;1H\x1b[36m>\x1b[0m Waiting for input...\r\n' +       // idle prompt
    '\x1b[6;1HClaude 4 Sonnet \xc2\xb7 ready\x1b[?25l';          // status bar + hide cursor
  redrawInterval = setInterval(() => {
    process.stdout.write(idleFrame);
  }, 500);
}

// Stay alive to simulate a running session (30s gives tests time to interact)
const timeout = setTimeout(() => { cleanup(); process.exit(0); }, 30000);

function cleanup() {
  if (redrawInterval) clearInterval(redrawInterval);
  clearTimeout(timeout);
}

// Exit cleanly on SIGTERM/SIGINT
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('exit', () => { if (redrawInterval) clearInterval(redrawInterval); });

// Keep stdin open so PTY doesn't close
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  if (data.includes('\x03')) {
    cleanup();
    process.exit(0);
  }
});
