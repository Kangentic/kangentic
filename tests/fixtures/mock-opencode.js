#!/usr/bin/env node
/**
 * Mock OpenCode CLI for E2E tests.
 *
 * OpenCode command shapes (see src/main/agent/adapters/opencode/command-builder.ts):
 *   opencode --version                              -> detector probe
 *   opencode --session <id>                         -> resume existing session
 *   opencode [--prompt <text>]                      -> new session
 *
 * Markers for test assertions:
 *   MOCK_OPENCODE_SESSION:<id>    -> new session created
 *   MOCK_OPENCODE_RESUMED:<id>    -> existing session resumed via --session
 *   MOCK_OPENCODE_PROMPT:<text>   -> prompt text delivered
 *
 * Also prints `session id: <ses_*>` so the OpenCode adapter's runtime
 * `fromOutput` regex captures the session ID from PTY output.
 *
 * Env knobs:
 *   MOCK_OPENCODE_NO_HEADER=1  -> suppress the `session id:` header so tests
 *                                  can exercise the fromFilesystem fallback path.
 *
 * Stays alive for 30 seconds to simulate a running session, then exits cleanly.
 * Prints cursor-hide ESC `\x1b[?25l` so detectFirstOutput() fires and the
 * shimmer overlay clears.
 */

const args = process.argv.slice(2);

// Version detection (called by AgentDetector)
if (args.includes('--version')) {
  console.log('opencode 1.14.25-mock');
  process.exit(0);
}

// Fixed session ID for new sessions - uses the native ses_* format
// (ses_<26 alphanumeric>) that the adapter's fromOutput regex matches.
const MOCK_SESSION_ID = 'ses_2349b5c91ffeKd6qajuUTR4clq';

let sessionId = null;
let resumed = false;
let prompt = null;

for (let i = 0; i < args.length; i++) {
  const argument = args[i];

  // --session <id> or --session=<id> (resume form)
  if (argument === '--session' || argument === '-s') {
    if (i + 1 < args.length) {
      sessionId = args[++i].replace(/^['"]|['"]$/g, '');
      resumed = true;
    }
    continue;
  }
  if (argument.startsWith('--session=')) {
    sessionId = argument.slice('--session='.length).replace(/^['"]|['"]$/g, '');
    resumed = true;
    continue;
  }

  // --prompt <text> (new session form)
  if (argument === '--prompt' || argument === '-p') {
    if (i + 1 < args.length) {
      prompt = args[++i].replace(/^['"]|['"]$/g, '');
    }
    continue;
  }
  if (argument.startsWith('--prompt=')) {
    prompt = argument.slice('--prompt='.length).replace(/^['"]|['"]$/g, '');
    continue;
  }

  // Skip other flags
  if (argument.startsWith('-')) continue;
}

// Use the fixed mock session ID for new sessions
if (!sessionId) {
  sessionId = MOCK_SESSION_ID;
}

// Print the session ID header so fromOutput captures it.
// The label format "session id: <id>" matches the LABELED_SESSION_ID_REGEX
// in opencode-adapter.ts.
if (!process.env.MOCK_OPENCODE_NO_HEADER) {
  console.log('session id: ' + sessionId);
}

// Output test assertion markers
if (resumed) {
  console.log('MOCK_OPENCODE_RESUMED:' + sessionId);
} else {
  console.log('MOCK_OPENCODE_SESSION:' + sessionId);
}

if (prompt) {
  console.log('MOCK_OPENCODE_PROMPT:' + prompt);
}

// Hide-cursor escape so detectFirstOutput() fires and the shimmer overlay clears.
process.stdout.write('\x1b[?25l');

// Stay alive to simulate a running session (30s gives tests time to interact)
const timeout = setTimeout(() => { process.exit(0); }, 30000);

// Exit cleanly on SIGTERM/SIGINT
process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });

// Keep stdin open so PTY doesn't close
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  if (data.includes('\x03')) {
    clearTimeout(timeout);
    process.exit(0);
  }
});
