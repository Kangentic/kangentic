#!/usr/bin/env node
/**
 * Mock Goose CLI for tests.
 *
 * Goose command shapes (see src/main/agent/adapters/goose/goose-adapter.ts):
 *   goose --version                                   -> detector probe (`goose 1.56.0`)
 *   goose run -t <prompt> [-s] [-r] [-n <name>]       -> process the prompt; -s stays interactive
 *   goose session [-r] [-n <name>]                    -> bare interactive session
 *
 * Markers for test assertions:
 *   MOCK_GOOSE_COMMAND:<run|session>   -> subcommand
 *   MOCK_GOOSE_NAME:<name>             -> the -n value
 *   MOCK_GOOSE_RESUMED:<name>          -> -r was passed
 *   MOCK_GOOSE_PROMPT:<text>           -> the -t text
 *   MOCK_GOOSE_MODE:<value>            -> GOOSE_MODE from the environment
 *
 * Like Goose 1.56 it writes an OSC 7501 program status (ESC ] 7501 ; state=<state>:app=goose ESC \)
 * on each change of state, unless GOOSE_CLI_PROGRAM_STATUS is set to a falsy word. The adapter's
 * parser reads the `blocked` ones. Goose's prompt is `( O)> `.
 *
 * Env knobs:
 *   MOCK_GOOSE_BLOCK=permission|question -> after the first reply, report `blocked` of that kind and
 *                                           wait for a line, then go back to `working` and `idle`.
 *
 * A `goose run -t` without `-s` answers and exits 0, as the real headless form does. With `-s`, and
 * for `goose session`, it stays at its prompt. Ctrl+C clears typed text, or exits on an empty line
 * (Goose's contextual Ctrl+C); `/exit` also exits.
 */

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-V')) {
  console.log('goose 1.56.0-mock');
  process.exit(0);
}

const command = args[0] === 'run' ? 'run' : 'session';
let prompt = null;
let name = null;
let resumed = false;
let interactive = command === 'session';

for (let i = 1; i < args.length; i++) {
  const flag = args[i];
  if ((flag === '-t' || flag === '--text') && args[i + 1] !== undefined) {
    prompt = args[++i];
  } else if ((flag === '-n' || flag === '--name') && args[i + 1] !== undefined) {
    name = args[++i];
  } else if (flag === '-r' || flag === '--resume') {
    resumed = true;
  } else if (flag === '-s' || flag === '--interactive') {
    interactive = true;
  }
}

const statusEnabled = !/^(0|false|off|no)$/i.test(process.env.GOOSE_CLI_PROGRAM_STATUS || '1');

function status(state, kind) {
  if (!statusEnabled) return;
  process.stdout.write('\x1b]7501;state=' + state + (kind ? ':kind=' + kind : '') + ':app=goose\x1b\\');
}

function showPrompt() {
  status('idle');
  process.stdout.write('\n( O)> ');
}

console.log('MOCK_GOOSE_COMMAND:' + command);
if (name) console.log('MOCK_GOOSE_NAME:' + name);
if (resumed) console.log('MOCK_GOOSE_RESUMED:' + (name || ''));
console.log('MOCK_GOOSE_MODE:' + (process.env.GOOSE_MODE || ''));

let awaitingBlockAnswer = false;

function finishTurn(text) {
  status('working');
  console.log('MOCK_GOOSE_REPLY:' + text);
  const blockKind = process.env.MOCK_GOOSE_BLOCK;
  if (blockKind === 'permission' || blockKind === 'question') {
    delete process.env.MOCK_GOOSE_BLOCK;
    awaitingBlockAnswer = true;
    status('blocked', blockKind);
    process.stdout.write('\nMOCK_GOOSE_WAITING:' + blockKind + ' ');
    return;
  }
  if (interactive) showPrompt();
  else process.exit(0);
}

if (prompt !== null) {
  console.log('MOCK_GOOSE_PROMPT:' + prompt);
  finishTurn(prompt);
} else {
  showPrompt();
}

const timeout = setTimeout(() => process.exit(0), 30000);
process.on('SIGTERM', () => { clearTimeout(timeout); process.exit(0); });
process.on('SIGINT', () => { clearTimeout(timeout); process.exit(0); });

let pendingInput = '';
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  pendingInput += data;
  for (;;) {
    const controlC = pendingInput.indexOf('\x03');
    const lineEnd = pendingInput.search(/[\r\n]/);
    if (controlC !== -1 && (lineEnd === -1 || controlC < lineEnd)) {
      const typedBefore = pendingInput.slice(0, controlC).trim();
      pendingInput = pendingInput.slice(controlC + 1);
      if (typedBefore === '') {
        clearTimeout(timeout);
        process.exit(0);
      }
      continue;
    }
    if (lineEnd === -1) break;
    const line = pendingInput.slice(0, lineEnd).trim();
    pendingInput = pendingInput.slice(lineEnd + 1);
    if (line === '') continue;
    if (line === '/exit' || line === 'exit') {
      clearTimeout(timeout);
      process.exit(0);
    }
    if (awaitingBlockAnswer) {
      awaitingBlockAnswer = false;
      status('working');
      console.log('MOCK_GOOSE_ANSWERED:' + line);
      if (interactive) showPrompt();
      else process.exit(0);
      continue;
    }
    finishTurn(line);
  }
});
