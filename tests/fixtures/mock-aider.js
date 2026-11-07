#!/usr/bin/env node
/**
 * Mock Aider CLI for tests.
 *
 * Aider command shapes (see src/main/agent/adapters/aider/aider-adapter.ts):
 *   aider --version                                       -> detector probe
 *   aider [--message <text>] [--chat-mode ask|--architect] [--yes]
 *         [--restore-chat-history] [--notifications --notifications-command <cmd>] ...
 *
 * Markers for test assertions:
 *   MOCK_AIDER_MODE:<code|ask|architect>   -> chat mode the flags selected
 *   MOCK_AIDER_PROMPT:<text>               -> the --message text
 *   MOCK_AIDER_RESTORED                    -> --restore-chat-history was passed
 *   MOCK_AIDER_NOTIFY:<command>            -> the --notifications-command text
 *
 * Interactive prompt: Aider writes `{edit_format}> ` when it waits for input, where the prefix is
 * `ask`, `architect` and so on, and nothing for the default code mode. The adapter's idle detector
 * matches that prompt at the end of the output. A typed line gets a short fake reply, a Tokens line
 * and the prompt again. `/exit` ends the process with status 0. Ctrl+C at the prompt prints
 * "^C again to exit" (a second one exits), as the real CLI does.
 *
 * Deliberate differences from the real CLI:
 *   - The real Aider exits after a `--message` is answered. This mock stays at its prompt, so a
 *     test can see the idle prompt; set MOCK_AIDER_EXIT_AFTER_MESSAGE=1 for the real behavior.
 *   - The notification command is only printed. Set MOCK_AIDER_RUN_NOTIFY=1 to run it through a
 *     shell, as Aider does when it waits for input.
 */

const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('aider 0.50.1-mock');
  process.exit(0);
}

let message = null;
let mode = 'code';
let notificationsCommand = null;
let restored = false;

for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--message' && args[i + 1] !== undefined) {
    message = args[++i];
  } else if (flag === '--chat-mode' && args[i + 1] !== undefined) {
    mode = args[++i];
  } else if (flag === '--architect') {
    mode = 'architect';
  } else if (flag === '--notifications-command' && args[i + 1] !== undefined) {
    notificationsCommand = args[++i];
  } else if (flag === '--restore-chat-history') {
    restored = true;
  } else if ((flag === '--model' || flag === '--chat-history-file' || flag === '--input-history-file' || flag === '--message-file') && args[i + 1] !== undefined) {
    i++; // skip the value of flags this mock does not act on
  }
}

const promptText = (mode === 'code' ? '' : mode) + '> ';

function showPrompt() {
  process.stdout.write('\n' + promptText);
  if (notificationsCommand && process.env.MOCK_AIDER_RUN_NOTIFY) {
    // Aider runs this with subprocess.run(command, shell=True) when it waits for input.
    spawnSync(notificationsCommand, { shell: true, stdio: 'ignore' });
  }
}

function reply(text) {
  console.log('MOCK_AIDER_REPLY:' + text);
  console.log('Tokens: 1.2k sent, 45 received. Cost: $0.00 message, $0.00 session.');
}

console.log('Aider v0.50.1-mock');
console.log('Main model: mock-model with diff edit format');
console.log('Git repo: none');
console.log('MOCK_AIDER_MODE:' + mode);
if (restored) console.log('MOCK_AIDER_RESTORED');
if (notificationsCommand) console.log('MOCK_AIDER_NOTIFY:' + notificationsCommand);

if (message !== null) {
  console.log('MOCK_AIDER_PROMPT:' + message);
  reply(message);
  if (process.env.MOCK_AIDER_EXIT_AFTER_MESSAGE) process.exit(0);
}

showPrompt();

// Stay alive for 30s (matches the other mock agents); the exit sequence ends it sooner.
const timeout = setTimeout(() => process.exit(0), 30000);
process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });

let pendingInput = '';
let interruptedOnce = false;
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  pendingInput += data;
  for (;;) {
    const controlC = pendingInput.indexOf('\x03');
    const lineEnd = pendingInput.search(/[\r\n]/);
    if (controlC !== -1 && (lineEnd === -1 || controlC < lineEnd)) {
      pendingInput = pendingInput.slice(0, controlC) + pendingInput.slice(controlC + 1);
      if (interruptedOnce) {
        clearTimeout(timeout);
        process.exit(0);
      }
      interruptedOnce = true;
      process.stdout.write('\n^C again to exit');
      showPrompt();
      continue;
    }
    if (lineEnd === -1) break;
    const line = pendingInput.slice(0, lineEnd).trim();
    pendingInput = pendingInput.slice(lineEnd + 1);
    if (line === '') continue;
    interruptedOnce = false;
    if (line === '/exit') {
      clearTimeout(timeout);
      process.exit(0);
    }
    reply(line);
    showPrompt();
  }
});
