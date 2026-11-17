#!/usr/bin/env node
/**
 * Mock Claude variant for paste-engine retry coverage.
 *
 * Behaves like mock-claude.js for argument parsing and session markers, but
 * disables PTY echo (setRawMode(true)) and reads stdin in raw mode so the
 * variant has full control over what bytes the engine sees as evidence.
 *
 * Paste-engine submission-evidence behavior:
 *   - First \r: swallow silently (no stdout). The engine's 3s window times
 *     out -> retry path triggers with a second \r.
 *   - Second \r: write a reply line. The engine's 2s retry window resolves
 *     on data evidence -> pasteAndSubmit succeeds.
 *
 * The reply has to be longer than the engine's post-Enter data floor
 * (POST_ENTER_DATA_FLOOR_BYTES, 50 bytes), below which output reads as a
 * cursor blip and not as a submit. This fixture once answered with a single
 * '.' and a 22-byte marker. That was under the floor, so on Linux CI the
 * retry window timed out and the send ended in "Paste landed but Enter did
 * not submit". The spec did not assert the error strip then and passed
 * anyway. The same send passed on Windows, where ConPTY writes sequences of
 * its own around an agent's output.
 *
 * Used by tests/e2e/browser-evidence-retry.spec.ts to verify the engine's
 * retry path lands the message on a session that initially swallows \r.
 */

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('mock-claude-eats-first-cr 0.0.0-test');
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: claude [options]');
  console.log('  --model <name>       Override model');
  console.log('  --effort <level>     Effort level for the current session (low, medium, high, xhigh, max)');
  process.exit(0);
}

let sessionId = null;
let resumed = false;
let prompt = null;
let settingsPath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-id' && i + 1 < args.length) {
    sessionId = args[i + 1];
    resumed = false;
    i++;
  } else if (args[i] === '--resume' && i + 1 < args.length) {
    sessionId = args[i + 1];
    resumed = true;
    i++;
  } else if (args[i] === '--settings' && i + 1 < args.length) {
    settingsPath = args[i + 1];
    i++;
  } else if (args[i] === '--permission-mode') {
    i++;
  } else if (args[i] === '--dangerously-skip-permissions' || args[i] === '--print') {
    /* no value */
  } else if (args[i] === '--') {
    if (i + 1 < args.length) prompt = args[i + 1];
    break;
  } else if (!args[i].startsWith('-')) {
    prompt = args[i];
  }
}

if (settingsPath) console.log('MOCK_CLAUDE_SETTINGS:' + settingsPath);
if (sessionId) {
  if (resumed) console.log('MOCK_CLAUDE_RESUMED:' + sessionId);
  else console.log('MOCK_CLAUDE_SESSION:' + sessionId);
}
if (prompt) console.log('MOCK_CLAUDE_PROMPT:' + prompt);
else if (!sessionId) console.log('MOCK_CLAUDE_NO_PROMPT');

// Suppress kernel-level PTY echo so the engine only sees bytes we
// explicitly write. Without this, `\r` would echo back as data and
// the first evidence window would resolve immediately, defeating the test.
if (process.stdin.isTTY) {
  try { process.stdin.setRawMode(true); } catch { /* ignore */ }
}

let crCount = 0;

process.stdin.on('data', (chunk) => {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0d) {
      crCount += 1;
      if (crCount === 1) {
        // Swallow first \r silently to force the engine into the retry path.
        continue;
      }
      // Second \r: reply as an agent that took the submit does, with more
      // output than the engine's 50-byte floor (see the header).
      console.log('MOCK_CLAUDE_CR_COUNT:' + crCount);
      console.log('MOCK_CLAUDE_REPLY: the retried Enter reached the prompt and the turn started.');
    }
  }
});

const timeout = setTimeout(() => process.exit(0), 30000);
process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });
process.stdin.resume();
