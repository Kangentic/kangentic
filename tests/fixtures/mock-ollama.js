#!/usr/bin/env node
/**
 * Mock Ollama CLI for tests.
 *
 * Ollama command shapes (see src/main/agent/adapters/ollama/ollama-adapter.ts):
 *   ollama --version                       -> detector probe (`ollama version is 0.5.0`)
 *   ollama list                            -> the model table `ollama list` prints
 *   ollama run <model> [-- <prompt>]       -> one-shot answer, or the interactive REPL with no prompt
 *
 * Markers for test assertions:
 *   MOCK_OLLAMA_MODEL:<model>    -> the model argument
 *   MOCK_OLLAMA_PROMPT:<text>    -> the prompt argument
 *
 * The REPL prompt is `>>> `, which the adapter's idle detector matches at the end of the output. A
 * typed line gets a fake reply and the prompt again. `/bye` ends the process with status 0. Ctrl+C
 * at the prompt clears the line, as the real REPL does, and does not exit.
 *
 * Env knobs:
 *   MOCK_OLLAMA_MODELS=a,b   -> the names `ollama list` prints (default two models)
 *   MOCK_OLLAMA_STAY=1       -> stay at the REPL after a one-shot prompt instead of exiting 0
 */

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('ollama version is 0.5.0-mock');
  process.exit(0);
}

if (args[0] === 'list') {
  const names = (process.env.MOCK_OLLAMA_MODELS || 'llama3.2:latest,qwen2.5-coder:7b').split(',').filter(Boolean);
  console.log('NAME                ID              SIZE      MODIFIED');
  for (const modelName of names) {
    console.log(modelName.padEnd(19) + ' a80c4f17acd5    2.0 GB    2 days ago');
  }
  process.exit(0);
}

if (args[0] !== 'run' || !args[1]) {
  console.error('mock-ollama: expected "run <model>" or "list"');
  console.error('Got:', args.join(' '));
  process.exit(1);
}

const model = args[1];
let prompt = null;
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--') continue; // end-of-options marker
  if (prompt === null) prompt = args[i];
}

console.log('MOCK_OLLAMA_MODEL:' + model);

function reply(text) {
  console.log('MOCK_OLLAMA_REPLY:' + text);
}

function showPrompt() {
  process.stdout.write('\n>>> ');
}

if (prompt !== null) {
  console.log('MOCK_OLLAMA_PROMPT:' + prompt);
  reply(prompt);
  if (!process.env.MOCK_OLLAMA_STAY) process.exit(0);
}

showPrompt();

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
      // Clears what was typed on the line; the REPL stays.
      pendingInput = pendingInput.slice(controlC + 1);
      continue;
    }
    if (lineEnd === -1) break;
    const line = pendingInput.slice(0, lineEnd).trim();
    pendingInput = pendingInput.slice(lineEnd + 1);
    if (line === '') continue;
    if (line === '/bye') {
      clearTimeout(timeout);
      process.exit(0);
    }
    reply(line);
    showPrompt();
  }
});
