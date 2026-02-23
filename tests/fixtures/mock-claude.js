#!/usr/bin/env node
/**
 * Mock Claude CLI for E2E tests.
 *
 * Handles:
 *   --version           → prints version string and exits
 *   --session-id ID     → NEW session with given ID (prints SESSION marker)
 *   --resume ID         → RESUMED session with given ID (prints RESUMED marker)
 *   <positional arg>    → prints the prompt text for verification
 *
 * Markers for test assertions:
 *   MOCK_CLAUDE_SESSION:<id>   → new session created via --session-id
 *   MOCK_CLAUDE_RESUMED:<id>   → existing session resumed via --resume
 *   MOCK_CLAUDE_PROMPT:<text>  → prompt/task text delivered
 *   MOCK_CLAUDE_NO_PROMPT      → no session-id and no prompt
 *   MOCK_CLAUDE_SETTINGS:<path> → settings file path from --settings
 *
 * Stays alive for a few seconds to simulate a running session,
 * then exits cleanly.
 */

const args = process.argv.slice(2);

// Version detection (called by ClaudeDetector)
if (args.includes('--version')) {
  console.log('mock-claude 0.0.0-test');
  process.exit(0);
}

// Parse flags to find the prompt (last positional arg)
let sessionId = null;
let resumed = false;
let prompt = null;
let settingsPath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-id' && i + 1 < args.length) {
    sessionId = args[i + 1];
    resumed = false;
    i++; // skip value
  } else if (args[i] === '--resume' && i + 1 < args.length) {
    sessionId = args[i + 1];
    resumed = true;
    i++; // skip value
  } else if (args[i] === '--settings' && i + 1 < args.length) {
    settingsPath = args[i + 1];
    i++; // skip value
  } else if (args[i] === '--permission-mode') {
    i++; // skip value
  } else if (args[i] === '--dangerously-skip-permissions' || args[i] === '--print') {
    // flag without value, skip
  } else if (!args[i].startsWith('-')) {
    prompt = args[i];
  }
}

if (settingsPath) {
  console.log('MOCK_CLAUDE_SETTINGS:' + settingsPath);
}

if (sessionId) {
  if (resumed) {
    console.log('MOCK_CLAUDE_RESUMED:' + sessionId);
  } else {
    console.log('MOCK_CLAUDE_SESSION:' + sessionId);
  }
}

if (prompt) {
  console.log('MOCK_CLAUDE_PROMPT:' + prompt);
} else if (!sessionId) {
  console.log('MOCK_CLAUDE_NO_PROMPT');
}

// Stay alive to simulate a running session (30s gives tests time to interact)
const timeout = setTimeout(() => process.exit(0), 30000);

// Exit cleanly on SIGTERM/SIGINT
process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });

// Keep stdin open so PTY doesn't close
process.stdin.resume();

// Listen for /exit command on stdin (graceful shutdown)
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  if (data.includes('/exit')) {
    clearTimeout(timeout);
    process.exit(0);
  }
});
