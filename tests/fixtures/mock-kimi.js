#!/usr/bin/env node
/**
 * Mock Kimi CLI for E2E tests.
 *
 * Real-CLI command shapes (see src/main/agent/adapters/kimi/command-builder.ts):
 *   kimi --version                                      -> detector probe
 *   kimi -w <cwd> [--session <uuid>] [--yolo|--plan]    -> spawn (interactive)
 *        [--prompt "..."]                                  Kimi accepts the same
 *                                                          --session flag for both
 *                                                          create (caller-owned UUID)
 *                                                          and resume.
 *
 * Markers for test assertions (mirrors mock-codex):
 *   MOCK_KIMI_SESSION:<id>   -> new session
 *   MOCK_KIMI_RESUMED:<id>   -> resumed session (the same --session flag was reused
 *                               with a UUID that already has a wire.jsonl on disk)
 *   MOCK_KIMI_PROMPT:<text>  -> prompt text delivered
 *   MOCK_KIMI_CWD:<path>     -> the work_dir argument that was applied
 *
 * Mimics the real welcome banner so the adapter's PTY regex anchor
 *   `Session:\s+<uuid>`
 * captures the session ID end-to-end through SessionIdScanner.
 *
 * Writes a wire.jsonl under ~/.kimi/sessions/<work_dir_hash>/<uuid>/ so the
 * SessionHistoryReader pipeline (locate -> parse) is exercised. Includes a
 * metadata header, TurnBegin, StatusUpdate (with a real model_id, context
 * usage, and token_usage payload), ToolCall, ToolResult, and TurnEnd.
 *
 * The work_dir hash is computed as md5(absolute_cwd_path) so it stays stable
 * across multiple invocations on the same project (mirroring real Kimi
 * behaviour - the algorithm is opaque upstream but the SCANNER does NOT rely
 * on it; it globs across all hash dirs).
 *
 * Env knobs:
 *   MOCK_KIMI_NO_BANNER=1  -> suppress the welcome banner so tests can
 *                             exercise the filesystem fallback capture path.
 *   MOCK_KIMI_NO_WIRE=1    -> suppress wire.jsonl creation.
 *   MOCK_KIMI_SUBAGENT=1   -> inject a SubagentEvent TurnBegin + TurnEnd pair
 *                             (subagent_type='explore') into the wire.jsonl,
 *                             exercising the SubagentStart / SubagentStop
 *                             lifecycle decoding path end-to-end.
 *   MOCK_KIMI_WRITE_KIMI_JSON=1 -> simulate real Kimi's racy read-modify-write of
 *                                  the kimi.json work_dirs[].last_session_id state.
 *                                  Intentionally non-atomic so concurrent invocations
 *                                  can corrupt the file - this models the upstream
 *                                  pattern that kimi-concurrent-spawns.spec.ts hunts.
 *   MOCK_KIMI_KIMI_JSON_PATH=path -> override the kimi.json write target to an
 *                                    absolute test-specific path, instead of the
 *                                    default ~/.kimi/kimi.json. Lets tests opt into
 *                                    the racy write without ever touching the real
 *                                    user state. Only consulted when
 *                                    MOCK_KIMI_WRITE_KIMI_JSON=1.
 *   MOCK_KIMI_KIMI_JSON_DELAY_MS=N -> insert N ms of synchronous busy-wait between
 *                                     read and write of kimi.json, widening the race
 *                                     window so concurrent mock processes interleave
 *                                     deterministically.
 */

const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-V')) {
  console.log('kimi, version 1.37.0-mock');
  process.exit(0);
}

// --- Argument parsing -------------------------------------------------------

// Flags whose value we don't care about for the test scenarios but that
// take an argument we need to skip past so the next token isn't
// misinterpreted as a positional (Kimi has no positional args, but
// guarding against it keeps the parser honest).
const FLAGS_WITH_VALUES = new Set([
  '--output-format', '--input-format',
  '--config', '--config-file',
  '--model', '-m',
  '--mcp-config', '--mcp-config-file',
  '--skills-dir', '--add-dir',
  '--max-steps-per-turn', '--max-retries-per-step', '--max-ralph-iterations',
  '--agent', '--agent-file',
]);

let sessionId = null;
let cwd = null;
let prompt = null;
let resumed = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-w' || arg === '--work-dir') {
    cwd = args[++i] ?? null;
  } else if (arg === '--session' || arg === '--resume' || arg === '-S' || arg === '-r') {
    sessionId = args[++i] ?? null;
  } else if (arg === '--prompt' || arg === '--command' || arg === '-p' || arg === '-c') {
    prompt = args[++i] ?? null;
  } else if (FLAGS_WITH_VALUES.has(arg)) {
    i++;
  }
  // booleans (--yolo, --plan, --print, --thinking, --no-thinking, --quiet,
  // --final-message, --verbose, --debug, --wire) intentionally fall through.
}

if (!cwd) cwd = process.cwd();
// Canonicalize so the work_dir hash matches what cleanupKimiSessionsForCwd
// in tests/e2e/helpers.ts computes (path.resolve normalizes separators
// and trailing slashes so md5 lands on the same digest on both sides).
cwd = path.resolve(cwd);

// Detect resume vs create: a resume call passes a UUID whose session
// directory already exists on disk. Mirrors the way real Kimi's
// `Session.find(work_dir, id)` discovers an existing session and replays
// its context.jsonl before the next TurnBegin.
function workDirHash(cwdAbsolute) {
  return createHash('md5').update(cwdAbsolute).digest('hex');
}

const sessionsRoot = path.join(os.homedir(), '.kimi', 'sessions');
const hashDir = path.join(sessionsRoot, workDirHash(cwd));

if (sessionId) {
  // Caller-owned UUID. If a wire.jsonl exists under this work_dir hash
  // for this UUID, treat the call as a resume.
  const candidate = path.join(hashDir, sessionId, 'wire.jsonl');
  resumed = fs.existsSync(candidate);
} else {
  sessionId = randomUUID();
}

const sessionDir = path.join(hashDir, sessionId);
const wirePath = path.join(sessionDir, 'wire.jsonl');

// --- wire.jsonl write -------------------------------------------------------

function writeWireEvents() {
  if (process.env.MOCK_KIMI_NO_WIRE) return;
  fs.mkdirSync(sessionDir, { recursive: true });

  const now = Date.now() / 1000;
  const lines = [];
  if (!resumed) {
    // Fresh session: write the metadata header.
    lines.push(JSON.stringify({ type: 'metadata', protocol_version: '1.9' }));
  }
  lines.push(JSON.stringify({
    timestamp: now,
    message: { type: 'TurnBegin', payload: { user_input: prompt ?? '' } },
  }));
  lines.push(JSON.stringify({
    timestamp: now + 0.05,
    message: {
      type: 'StatusUpdate',
      payload: {
        context_usage: 0.12,
        context_tokens: 24576,
        max_context_tokens: 200000,
        token_usage: {
          input_other: 800,
          output: 150,
          input_cache_read: 1024,
          input_cache_creation: 256,
        },
        message_id: 'msg-mock-1',
        plan_mode: false,
      },
    },
  }));
  lines.push(JSON.stringify({
    timestamp: now + 0.1,
    message: {
      type: 'ToolCall',
      payload: {
        type: 'function',
        id: 'tc-mock-1',
        function: { name: 'Shell', arguments: '{"command": "ls"}' },
      },
    },
  }));
  lines.push(JSON.stringify({
    timestamp: now + 0.15,
    message: {
      type: 'ToolResult',
      payload: {
        tool_call_id: 'tc-mock-1',
        return_value: { is_error: false, output: 'ok\n', message: 'ok', display: [] },
      },
    },
  }));
  // MOCK_KIMI_SUBAGENT=1: inject a SubagentEvent TurnBegin + TurnEnd pair
  // (subagent_type='explore') before the outer TurnEnd, exercising the
  // SubagentStart / SubagentStop lifecycle decoding path end-to-end.
  if (process.env.MOCK_KIMI_SUBAGENT) {
    lines.push(JSON.stringify({
      timestamp: now + 0.18,
      message: {
        type: 'SubagentEvent',
        payload: {
          parent_tool_call_id: 'tc-mock-1',
          agent_id: 'sub-mock-1',
          subagent_type: 'explore',
          event: { type: 'TurnBegin', payload: { user_input: 'explore the repo' } },
        },
      },
    }));
    lines.push(JSON.stringify({
      timestamp: now + 0.19,
      message: {
        type: 'SubagentEvent',
        payload: {
          parent_tool_call_id: 'tc-mock-1',
          agent_id: 'sub-mock-1',
          subagent_type: 'explore',
          event: { type: 'TurnEnd', payload: {} },
        },
      },
    }));
  }

  lines.push(JSON.stringify({
    timestamp: now + 0.2,
    message: { type: 'TurnEnd', payload: {} },
  }));

  // Resume mode: append to the existing file. Fresh: create.
  const flag = resumed ? 'a' : 'w';
  fs.writeFileSync(wirePath, lines.join('\n') + '\n', { flag });
}

writeWireEvents();

// --- kimi.json racy read-modify-write (opt-in) ------------------------------
// Real Kimi maintains ~/.kimi/kimi.json with a work_dirs[] array tracking the
// most recent session per work_dir. Under concurrent invocations against the
// same HOME, that read-modify-write can race and corrupt the file. The spec
// at tests/e2e/kimi-concurrent-spawns.spec.ts opts in to this branch via
// MOCK_KIMI_WRITE_KIMI_JSON=1 to detect that race deterministically.

if (process.env.MOCK_KIMI_WRITE_KIMI_JSON) {
  const kimiJsonPath = process.env.MOCK_KIMI_KIMI_JSON_PATH
    ? process.env.MOCK_KIMI_KIMI_JSON_PATH
    : path.join(os.homedir(), '.kimi', 'kimi.json');
  fs.mkdirSync(path.dirname(kimiJsonPath), { recursive: true });
  let data;
  try {
    data = JSON.parse(fs.readFileSync(kimiJsonPath, 'utf-8'));
  } catch {
    data = { work_dirs: [] };
  }
  if (!Array.isArray(data.work_dirs)) data.work_dirs = [];

  // Synchronous busy-wait widens the read-modify-write race window so two
  // concurrent mock processes interleave deterministically. Real Kimi does
  // nontrivial work between read and write; without a delay here, sub-ms
  // timing makes corruption statistically rare even when the bug exists.
  const delayMs = Number(process.env.MOCK_KIMI_KIMI_JSON_DELAY_MS ?? '0');
  if (delayMs > 0) {
    const target = Date.now() + delayMs;
    while (Date.now() < target) { /* spin */ }
  }

  const existingIndex = data.work_dirs.findIndex((entry) => entry && entry.path === cwd);
  if (existingIndex >= 0) data.work_dirs[existingIndex].last_session_id = sessionId;
  else data.work_dirs.push({ path: cwd, last_session_id: sessionId });

  // Intentionally non-atomic (no temp+rename). This models the racy pattern
  // upstream Kimi may exhibit; an atomic write would hide the very bug the
  // spec is hunting.
  fs.writeFileSync(kimiJsonPath, JSON.stringify(data, null, 2));
}

// Real Kimi never deletes wire.jsonl - it persists for the lifetime of
// the project so that future `kimi -r <uuid>` calls can replay context.
// We mirror that here: NO cleanup on exit. The test's afterAll hook
// (cleanupKimiSessionsForCwd in tests/e2e/helpers.ts) is responsible
// for wiping any session directories it created.

// --- PTY output -------------------------------------------------------------

// Hide-cursor escape so detectFirstOutput() returns true.
process.stdout.write('\x1b[?25l');

if (!process.env.MOCK_KIMI_NO_BANNER) {
  // Welcome banner that mirrors the real cyan-bordered TUI box.
  // Critical: the "Session: <uuid>" line is the regex anchor.
  console.log('Welcome to Kimi Code CLI!');
  console.log('Send /help for help information.');
  console.log('');
  console.log(`Directory: ${cwd}`);
  console.log(`Session: ${sessionId}`);
  console.log('Model: kimi-for-coding');
  console.log('');
  console.log('Tip: Spot a bug or have feedback? Type /feedback.');
}

console.log(`MOCK_KIMI_${resumed ? 'RESUMED' : 'SESSION'}:${sessionId}`);
console.log(`MOCK_KIMI_CWD:${cwd}`);
if (prompt) console.log(`MOCK_KIMI_PROMPT:${prompt}`);

// Idle timeout - exits after 30s if not interrupted.
const timeout = setTimeout(() => { process.exit(0); }, 30000);

function shutdown(signal) {
  clearTimeout(timeout);
  process.exit(signal === 'SIGINT' ? 130 : 0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  // Ctrl+C and the conventional "/exit\r" both trigger clean shutdown.
  if (data.includes('\x03') || data.includes('/exit')) {
    shutdown('STDIN');
  }
});
