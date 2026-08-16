#!/usr/bin/env node
/**
 * Mock Grok Build CLI for E2E tests.
 *
 * Real-CLI command shapes (see src/main/agent/adapters/grok/command-builder.ts,
 * verified against grok 1.0.0):
 *   grok --version                                        -> detector probe
 *   grok -s <uuid> --permission-mode <mode> -- "<prompt>" -> new session
 *   grok --resume <uuid> --permission-mode <mode>         -> resume
 *   grok -p "<prompt>" --output-format plain              -> headless single turn
 *
 * Markers for test assertions (mirrors mock-kimi):
 *   MOCK_GROK_SESSION:<id>   -> new session
 *   MOCK_GROK_RESUMED:<id>   -> resumed session
 *   MOCK_GROK_PROMPT:<text>  -> prompt text delivered (first line)
 *   MOCK_GROK_CWD:<path>     -> the process cwd (grok has no --cwd flag)
 *
 * Writes the real on-disk session layout under
 * `$GROK_HOME|~/.grok/sessions/<encodeURIComponent(cwd)>/<uuid>/`:
 * `updates.jsonl` (user_message_chunk with `_meta.modelId`, chunks carrying
 * `params._meta.totalTokens`, tool_call, turn_completed with the cumulative
 * usage block incl. `costUsdTicks` at 1e-10 USD), `chat_history.jsonl`
 * (user record wrapped in `<user_query>` tags), and `summary.json` - so the
 * SessionHistoryReader locate -> parse pipeline and the transcript parser
 * run against the exact shapes the adapter was built for.
 *
 * HOOK EMULATION: like the real grok, the mock loads
 * `<cwd>/.grok/hooks/kangentic.json` (the file GrokCommandBuilder writes at
 * spawn) and executes each entry's command for SessionStart,
 * UserPromptSubmit, PreToolUse, PostToolUse, and Stop with grok-shaped
 * camelCase stdin payloads. The commands inherit this process's env - which
 * carries KANGENTIC_EVENTS_PATH from buildGrokEnv - so the E2E spec
 * exercises the FULL production pipeline: static hook file -> env-routed
 * event-bridge `env:` sentinel -> per-session events.jsonl -> parseEvent.
 * (The real grok gates project hooks on folder trust; the mock does not
 * model trust - the E2E spec covers the trusted path.)
 *
 * Env knobs:
 *   MOCK_GROK_NO_HOOKS=1    -> skip hook execution (untrusted-folder path:
 *                              activity must then settle via PTY silence).
 *   MOCK_GROK_NO_SESSION=1  -> skip session-store writes.
 */

const { randomUUID } = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log('grok 1.0.0-mock (deadbeef) [stable]');
  process.exit(0);
}

// --- Argument parsing -------------------------------------------------------

const FLAGS_WITH_VALUES = new Set([
  '--permission-mode', '--model', '-m', '--reasoning-effort', '--effort',
  '--output-format', '--sandbox', '--agent', '--agents', '--max-turns',
  '--rules', '--prompt-file', '--prompt-json', '--cwd',
]);

let sessionId = null;
let resume = false;
let headless = false;
let prompt = null;
let afterDoubleDash = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (afterDoubleDash) {
    prompt = prompt === null ? arg : `${prompt} ${arg}`;
    continue;
  }
  if (arg === '--') {
    afterDoubleDash = true;
  } else if (arg === '-s' || arg === '--session-id') {
    sessionId = args[++i] ?? null;
  } else if (arg === '-r' || arg === '--resume') {
    // The real flag takes an optional value; the adapter always passes one.
    const next = args[i + 1];
    if (next && !next.startsWith('-')) { sessionId = next; i++; }
    resume = true;
  } else if (arg === '-p' || arg === '--single') {
    headless = true;
    const next = args[i + 1];
    if (next && !next.startsWith('-')) { prompt = next; i++; }
  } else if (FLAGS_WITH_VALUES.has(arg)) {
    i++;
  }
  // booleans (--fullscreen, --minimal, --no-alt-screen, --always-approve,
  // --fork-session, ...) intentionally fall through.
}

const cwd = path.resolve(process.cwd());

// Real semantics: -s names a NEW session (errors if it exists); --resume
// requires an existing one. The mock is forgiving about the error cases -
// the specs never exercise them - but mirrors the create/resume split.
if (!sessionId) sessionId = randomUUID();

const grokHome = process.env.GROK_HOME && process.env.GROK_HOME.trim().length > 0
  ? process.env.GROK_HOME
  : path.join(os.homedir(), '.grok');
const sessionDir = path.join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId);
const resumed = resume && fs.existsSync(path.join(sessionDir, 'updates.jsonl'));

// --- Session store write ----------------------------------------------------

function updateLine(update, paramsMeta) {
  return JSON.stringify({
    timestamp: Math.floor(Date.now() / 1000),
    method: 'session/update',
    params: {
      sessionId,
      update,
      ...(paramsMeta ? { _meta: paramsMeta } : {}),
    },
  });
}

function writeSessionStore() {
  if (process.env.MOCK_GROK_NO_SESSION) return;
  fs.mkdirSync(sessionDir, { recursive: true });

  const promptText = prompt ?? '';
  const updates = [
    updateLine({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: promptText },
      _meta: { modelId: 'grok-4.6', promptIndex: 0 },
    }),
    updateLine(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on it.' } },
      { totalTokens: 12000 },
    ),
    updateLine(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-mock-1',
        title: 'read_file',
        rawInput: { target_file: 'hello.txt' },
        _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read' } },
      },
      { totalTokens: 12400 },
    ),
    updateLine({
      sessionUpdate: 'turn_completed',
      prompt_id: 'prompt-mock-1',
      stop_reason: 'end_turn',
      usage: {
        inputTokens: 12400,
        outputTokens: 180,
        totalTokens: 12580,
        cachedReadTokens: 512,
        costUsdTicks: 236720000,
        apiDurationMs: 1500,
        modelCalls: 1,
        numTurns: 1,
        modelUsage: { 'grok-4.6': { inputTokens: 12400, outputTokens: 180 } },
      },
    }),
  ];

  const chatHistory = [
    JSON.stringify({ type: 'system', content: 'You are mock Grok.' }),
    JSON.stringify({
      type: 'user',
      content: { type: 'text', text: `<user_query>\n${promptText}\n</user_query>` },
    }),
    JSON.stringify({
      type: 'assistant',
      content: 'Done.',
      model_id: 'grok-4.6',
      reasoning_effort: 'high',
      tool_calls: [{ id: 'call-mock-1', name: 'read_file', arguments: '{"target_file":"hello.txt"}' }],
    }),
    JSON.stringify({ type: 'tool_result', tool_call_id: 'call-mock-1', content: 'mock file contents' }),
  ];

  const flag = resumed ? 'a' : 'w';
  fs.writeFileSync(path.join(sessionDir, 'updates.jsonl'), updates.join('\n') + '\n', { flag });
  fs.writeFileSync(path.join(sessionDir, 'chat_history.jsonl'), chatHistory.join('\n') + '\n', { flag });
  fs.writeFileSync(path.join(sessionDir, 'summary.json'), JSON.stringify({
    info: { id: sessionId, cwd },
    session_summary: 'mock session',
    current_model_id: 'grok-4.6',
    reasoning_effort: 'high',
    num_messages: 3,
  }, null, 2));
}

writeSessionStore();

// --- Hook emulation ---------------------------------------------------------

function runHooks() {
  if (process.env.MOCK_GROK_NO_HOOKS) return;
  const hooksPath = path.join(cwd, '.grok', 'hooks', 'kangentic.json');
  let hooks;
  try {
    hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')).hooks;
  } catch {
    return; // No hook file - the adapter spawned without an events pipeline.
  }
  if (!hooks || typeof hooks !== 'object') return;

  const common = {
    sessionId,
    cwd,
    workspaceRoot: cwd.replace(/\\/g, '/') + '/',
    timestamp: new Date().toISOString(),
    permissionMode: 'auto',
  };
  const firings = [
    ['SessionStart', { ...common, hookEventName: 'session_start', source: 'new' }],
    ['UserPromptSubmit', { ...common, hookEventName: 'user_prompt_submit', prompt: `<user_query>\n${prompt ?? ''}\n</user_query>` }],
    ['PreToolUse', { ...common, hookEventName: 'pre_tool_use', toolName: 'read_file', toolUseId: 'call-mock-1', toolInput: { target_file: 'hello.txt' } }],
    ['PostToolUse', { ...common, hookEventName: 'post_tool_use', toolName: 'read_file', toolUseId: 'call-mock-1', toolInput: { target_file: 'hello.txt' }, toolResult: { type: 'ReadFile' } }],
    ['Stop', { ...common, hookEventName: 'stop', reason: 'end_turn', stopHookActive: false, lastAssistantMessage: 'Done.', backgroundTasks: [], sessionCrons: [] }],
  ];

  for (const [eventName, payload] of firings) {
    const entries = hooks[eventName];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (!hook || hook.type !== 'command' || typeof hook.command !== 'string') continue;
        try {
          // Shell exec like the real hook runner; env (incl. the adapter's
          // KANGENTIC_EVENTS_PATH) is inherited from this process.
          childProcess.execSync(hook.command, {
            input: JSON.stringify(payload),
            timeout: 10_000,
            windowsHide: true,
          });
        } catch (error) {
          console.error(`MOCK_GROK_HOOK_ERROR:${eventName}:${error.message}`);
        }
      }
    }
  }
}

// --- PTY output -------------------------------------------------------------

// Hide-cursor escape first, so detectFirstOutput() returns true.
process.stdout.write('\x1b[?25l');

console.log('Grok Build  1.0.0-mock');
console.log(`MOCK_GROK_${resumed ? 'RESUMED' : 'SESSION'}:${sessionId}`);
console.log(`MOCK_GROK_CWD:${cwd}`);
if (prompt) console.log(`MOCK_GROK_PROMPT:${prompt.split('\n')[0]}`);

if (headless) {
  runHooks();
  console.log('OK');
  process.exit(0);
}

// Fire hooks AFTER a short settle, modeling the real CLI (SessionStart
// lands ~2s after launch, tool/Stop hooks over the following seconds).
// Firing them synchronously at spawn raced the app's events.jsonl reader
// attach, which deliberately skips bytes that predate the attach (stale-
// replay protection) - a window the real grok never hits.
const hooksTimer = setTimeout(() => { runHooks(); }, 1500);

// Idle timeout - exits after 30s if not interrupted.
const timeout = setTimeout(() => { process.exit(0); }, 30000);

function shutdown(signal) {
  clearTimeout(timeout);
  clearTimeout(hooksTimer);
  process.exit(signal === 'SIGINT' ? 130 : 0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  // Ctrl+C and the real exit sequence's "/quit\r" both trigger clean shutdown.
  if (data.includes('\x03') || data.includes('/quit')) {
    shutdown('STDIN');
  }
});
