#!/usr/bin/env node
/**
 * Mock Copilot CLI for E2E tests.
 *
 * Copilot command shapes (see src/main/agent/adapters/copilot/command-builder.ts):
 *   copilot --version                              -> detector probe
 *   copilot --resume <sessionId> [flags]           -> resume or new with caller UUID
 *   copilot --plan [flags] -i "<prompt>"           -> interactive with prompt
 *   copilot -p "<prompt>" [flags]                  -> non-interactive
 *
 * Markers for test assertions (mirrors mock-claude):
 *   MOCK_COPILOT_SESSION:<id>   -> new session (--resume with new UUID)
 *   MOCK_COPILOT_RESUMED:<id>   -> resumed session (--resume with existing UUID)
 *   MOCK_COPILOT_PROMPT:<text>  -> prompt text delivered
 *   MOCK_COPILOT_CONFIG_DIR:<path> -> config dir from --config-dir
 *   MOCK_COPILOT_NO_PROMPT      -> no prompt provided
 *
 * Stays alive for 30 seconds to simulate a running session, then exits.
 * Responds to Ctrl+C and /exit on stdin for graceful shutdown.
 */

const args = process.argv.slice(2);

// Version detection (called by CopilotDetector)
if (args.includes('--version') || args.includes('-v')) {
  console.log('GitHub Copilot CLI 1.0.24.');
  console.log("Run 'copilot update' to check for updates.");
  process.exit(0);
}

let sessionId = null;
let prompt = null;
let configDir = null;
let nonInteractive = false;

for (let i = 0; i < args.length; i++) {
  const argument = args[i];

  // --resume <sessionId> or --resume=<sessionId>
  if (argument === '--resume' && i + 1 < args.length) {
    sessionId = args[i + 1];
    i++; // skip value
  } else if (argument.startsWith('--resume=')) {
    sessionId = argument.slice('--resume='.length);
  }
  // --config-dir <path>
  else if (argument === '--config-dir' && i + 1 < args.length) {
    configDir = args[i + 1];
    i++; // skip value
  }
  // -i <prompt> (interactive with initial prompt)
  else if (argument === '-i' && i + 1 < args.length) {
    prompt = args[i + 1];
    i++; // skip value
  }
  // -p <prompt> (non-interactive)
  else if (argument === '-p' && i + 1 < args.length) {
    nonInteractive = true;
    prompt = args[i + 1];
    i++; // skip value
  }
  // Skip known flag/value pairs
  else if (argument === '--model' || argument === '--additional-mcp-config' || argument === '--mode') {
    i++; // skip value
  }
  // Skip known boolean flags
  else if (argument === '--plan' || argument === '--yolo' || argument === '--allow-all' ||
           argument === '--allow-all-tools' || argument === '--no-ask-user' ||
           argument === '--autopilot' || argument === '--experimental' ||
           argument === '-s' || argument === '--silent') {
    // flag without value, skip
  }
}

if (configDir) {
  console.log('MOCK_COPILOT_CONFIG_DIR:' + configDir);
}

if (sessionId) {
  // In real Copilot, --resume with a new UUID creates a new session,
  // --resume with an existing UUID resumes it. The mock can't distinguish,
  // so always emit SESSION marker. Tests that need RESUMED semantics
  // can check by spawning first, suspending, then resuming.
  console.log('MOCK_COPILOT_SESSION:' + sessionId);
}

if (prompt) {
  console.log('MOCK_COPILOT_PROMPT:' + prompt);
} else if (!sessionId) {
  console.log('MOCK_COPILOT_NO_PROMPT');
}

// Hide-cursor escape so detectFirstOutput() returns true and the shimmer overlay clears.
process.stdout.write('\x1b[?25l');

// Non-interactive mode: print output and exit
if (nonInteractive) {
  console.log('Mock Copilot response for: ' + (prompt || '(no prompt)'));
  process.exit(0);
}

// Stay alive to simulate a running interactive session (30s gives tests time to interact)
const timeout = setTimeout(() => process.exit(0), 30000);

// Exit cleanly on SIGTERM/SIGINT
process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });

// Keep stdin open so PTY doesn't close
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  // Respond to /exit, /quit, or Ctrl+C
  if (data.includes('/exit') || data.includes('/quit') || data.includes('\x03')) {
    clearTimeout(timeout);
    process.exit(0);
  }
});
