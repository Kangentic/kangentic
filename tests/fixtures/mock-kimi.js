#!/usr/bin/env node
/**
 * Mock Kimi Code CLI (2.x) for E2E tests. Behaves as
 * src/main/agent/adapters/kimi/ reads the real CLI's docs and source:
 *
 *   kimi --version                                 -> bare version
 *   kimi [--session <id>] [--model <alias>]        -> interactive session
 *        [--plan | --yolo | --auto]
 *
 * - No working-directory flag and no `--mcp-config-file`: either is an error.
 * - No prompt on the command line: a positional argument is an error, so a
 *   builder that puts one back fails its spec.
 * - `--session` only resumes. An id with no session is an error.
 * - A new session has no id and no folder until its first typed message. So
 *   MOCK_KIMI_SESSION in scrollback proves the typed first prompt arrived.
 *
 * Markers for test assertions:
 *   MOCK_KIMI_SESSION:<id>   -> a new session, created by the first message
 *   MOCK_KIMI_RESUMED:<id>   -> resumed through --session
 *   MOCK_KIMI_PROMPT:<text>  -> a message typed in, on one line
 *   MOCK_KIMI_CWD:<path>     -> the process cwd
 *
 * Writes under $KIMI_CODE_HOME (the E2E launch points it at the test's data
 * dir, so no real home is touched):
 *   session_index.jsonl
 *   sessions/wd_<slug>_<sha256 prefix>/<id>/agents/main/wire.jsonl
 *
 * Env knobs:
 *   MOCK_KIMI_NO_BANNER=1   -> no welcome box and no exit hint, so the id can
 *                              only come from the session index.
 *   MOCK_KIMI_NO_WIRE=1     -> no wire records beyond the metadata line.
 *   MOCK_KIMI_SUBAGENT=1    -> subagent.spawned + subagent.completed records.
 *   MOCK_KIMI_PLAN_EXIT=1   -> plan_mode.enter and an approved ExitPlanMode.
 */

const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-V')) {
  console.log('2.4.1-mock');
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

// --- Argument parsing -------------------------------------------------------

const FLAGS_WITH_VALUES = new Set(['--model', '-m', '--add-dir', '--skills-dir', '--agent', '--agent-file']);
const BOOLEAN_FLAGS = new Set(['--yolo', '-y', '--auto', '--plan', '--continue', '-c']);

let requestedSessionId = null;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--session' || arg === '-S' || arg === '--resume' || arg === '-r') {
    requestedSessionId = args[index + 1] ?? null;
    index += 1;
  } else if (FLAGS_WITH_VALUES.has(arg)) {
    index += 1;
  } else if (BOOLEAN_FLAGS.has(arg)) {
    continue;
  } else if (arg.startsWith('-')) {
    fail(`unknown option '${arg}'`);
  } else {
    fail(`unknown command '${arg}'`);
  }
}

// --- Data locations ---------------------------------------------------------

const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
const indexPath = path.join(home, 'session_index.jsonl');
const cwd = process.cwd();

function workDirKey(workDir) {
  const normalized = workDir.replaceAll('\\', '/').replace(/\/+$/, '');
  const base = normalized.split('/').pop() ?? normalized;
  const slug = base.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 40) || 'workspace';
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `wd_${slug}_${hash}`;
}

function findSessionDir(sessionId) {
  let text;
  try {
    text = fs.readFileSync(indexPath, 'utf-8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record.sessionId === sessionId && record.sessionDir) return record.sessionDir;
    } catch {
      // A line another mock process is appending.
    }
  }
  return null;
}

let sessionId = null;
let wirePath = null;

if (requestedSessionId) {
  const sessionDir = findSessionDir(requestedSessionId);
  if (!sessionDir) fail(`failed to start shell: Session "${requestedSessionId}" not found.`);
  sessionId = requestedSessionId;
  wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
}
const resumed = sessionId !== null;

/** A new session exists only once its first message is sent. */
function createSession() {
  sessionId = `session_${randomUUID()}`;
  const sessionDir = path.join(home, 'sessions', workDirKey(cwd), sessionId);
  wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  fs.mkdirSync(path.dirname(wirePath), { recursive: true });
  fs.writeFileSync(wirePath, JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: Date.now() }) + '\n');
  fs.appendFileSync(indexPath, JSON.stringify({ sessionId, sessionDir, workDir: cwd }) + '\n');
  console.log(`MOCK_KIMI_SESSION:${sessionId}`);
}

// --- wire.jsonl -------------------------------------------------------------

function writeTurn(prompt) {
  if (process.env.MOCK_KIMI_NO_WIRE) return;
  const start = Date.now();
  const stepUuid = randomUUID();
  const loop = (event, offset) => ({ type: 'context.append_loop_event', agentId: 'main', event, time: start + offset });
  const records = [
    { type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: prompt }], origin: 'user', turnId: 1, time: start },
    { type: 'llm.request', agentId: 'main', kind: 'loop', provider: 'mock', model: 'kimi-k3', modelAlias: 'kimi-code/k3', toolSelect: false, systemPromptHash: 'x', toolsHash: 'x', messageCount: 1, time: start + 5 },
    loop({ type: 'step.begin', uuid: stepUuid, step: 1 }, 10),
    loop({ type: 'content.part', stepUuid, part: { type: 'text', text: 'Working on it.' } }, 20),
    loop({ type: 'tool.call', stepUuid, toolCallId: 'tc-mock-1', name: 'Bash', args: { command: 'ls' } }, 30),
    loop({ type: 'tool.result', toolCallId: 'tc-mock-1', result: { output: 'ok\n' } }, 40),
    { type: 'token_counting.measured', agentId: 'main', length: 2, tokens: 24576, time: start + 50 },
    loop({ type: 'step.end', uuid: stepUuid, usage: { inputOther: 800, output: 150, inputCacheRead: 1024, inputCacheCreation: 256 } }, 60),
  ];
  if (process.env.MOCK_KIMI_PLAN_EXIT) {
    records.push(
      { type: 'plan_mode.enter', agentId: 'main', id: 'plan-1', time: start + 70 },
      loop({ type: 'tool.call', stepUuid, toolCallId: 'tc-plan-1', name: 'ExitPlanMode', args: {} }, 71),
      loop({ type: 'tool.result', toolCallId: 'tc-plan-1', result: { output: 'Exited plan mode. Plan mode deactivated. All tools are now available.\n## Approved Plan:\nDo it' } }, 72),
      { type: 'plan_mode.exit', agentId: 'main', id: 'plan-1', time: start + 73 },
    );
  }
  if (process.env.MOCK_KIMI_SUBAGENT) {
    records.push(
      { type: 'subagent.spawned', subagentId: 'sub-mock-1', subagentName: 'explore', parentToolCallId: 'tc-mock-1', runInBackground: false, time: start + 80 },
      { type: 'subagent.completed', subagentId: 'sub-mock-1', resultSummary: 'done', time: start + 90 },
    );
  }
  records.push({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed', time: start + 100 });
  fs.appendFileSync(wirePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

// --- PTY output -------------------------------------------------------------

// Hide-cursor escape, as a full-screen TUI draws, and bracketed paste on.
process.stdout.write('\x1b[?25l\x1b[?2004h');

if (!process.env.MOCK_KIMI_NO_BANNER) {
  console.log('Welcome to Kimi Code!');
  console.log('Send /help for help information.');
  console.log(`Directory: ${cwd}`);
  console.log(`Session:   ${sessionId ?? ''}`);
  console.log('Model:     kimi-code/k3');
  console.log('Version:   2.4.1-mock');
  if (!resumed) console.log('No session yet - one will be created on your first message.');
}
if (resumed) console.log(`MOCK_KIMI_RESUMED:${sessionId}`);
console.log(`MOCK_KIMI_CWD:${cwd}`);

// Idle timeout - exits after 30s if not interrupted.
let timeout = setTimeout(() => process.exit(0), 30000);

function quit(code) {
  clearTimeout(timeout);
  process.stdout.write('\x1b[?2004l\x1b[?25h');
  if (sessionId && !process.env.MOCK_KIMI_NO_BANNER) {
    console.log(' Bye!');
    console.error(` To resume this session: kimi -r ${sessionId}`);
  }
  process.exit(code);
}

function submit(line) {
  const text = line.replaceAll('\x1b', '').trim();
  if (text.length === 0) return;
  if (text === '/exit' || text === '/quit') quit(0);
  clearTimeout(timeout);
  timeout = setTimeout(() => process.exit(0), 30000);
  if (!sessionId) createSession();
  console.log(`MOCK_KIMI_PROMPT:${text.replaceAll(/\s+/g, ' ')}`);
  writeTurn(text);
}

process.on('SIGTERM', () => quit(0));
process.on('SIGINT', () => quit(130));

// Raw mode, as a TUI runs: Enter arrives as \r, and a bracketed paste's line
// breaks stay inside the message.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
let pending = '';
let line = '';
let inPaste = false;

process.stdin.on('data', (data) => {
  if (data.includes('\x03')) quit(130);
  pending += data;
  for (;;) {
    if (inPaste) {
      const end = pending.indexOf(PASTE_END);
      if (end < 0) return;
      line += pending.slice(0, end);
      pending = pending.slice(end + PASTE_END.length);
      inPaste = false;
      continue;
    }
    const start = pending.indexOf(PASTE_START);
    const enter = pending.search(/[\r\n]/);
    if (start >= 0 && (enter < 0 || start < enter)) {
      line += pending.slice(0, start);
      pending = pending.slice(start + PASTE_START.length);
      inPaste = true;
      continue;
    }
    if (enter >= 0) {
      const submitted = line + pending.slice(0, enter);
      pending = pending.slice(enter + 1);
      line = '';
      submit(submitted);
      continue;
    }
    line += pending;
    pending = '';
    return;
  }
});
