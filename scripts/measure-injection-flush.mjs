#!/usr/bin/env node
/**
 * MANUAL MEASUREMENT SCRIPT - not wired to CI or any npm script.
 *
 * Measures, per agent CLI, how long it takes for a submitted user turn to
 * appear in the session history file that agent's parser resolves. This is the
 * gate for implementing `getSubmissionVerifier('command-injection')`: a
 * verifier polls for ~2s and then declares failure, so an agent that flushes
 * its history on turn-end rather than on submit would read "never landed"
 * every time.
 *
 * That failure is not benign, which is the whole reason this script exists:
 *   - No verifier      -> outcome `unconfirmed`, escalation never fires.
 *   - Too-slow verifier -> false `failed` -> escalation -> session RESTART
 *                          that destroys live work.
 * A wrong verifier is worse than no verifier. Do not implement one for an
 * adapter whose latency was not measured here.
 *
 * HOW IT MEASURES
 * Rather than reimplement each agent's record shape (that is the verifier's
 * job, and is exactly what may be buggy), each probe embeds a unique nonce and
 * we measure when that nonce first appears in the history file. That is
 * agent-agnostic ground truth and stays honest even when the app's own
 * resolver is broken. The containing record is captured so the record shape
 * can be read off the report later.
 *
 * THE PAIRED-TRIAL DISCRIMINATOR (the load-bearing part)
 * A trivial prompt ends its turn in under a second, so a turn-end-flushed
 * history still reads sub-second and every agent looks like a PASS. Each agent
 * is therefore probed with BOTH a trivial prompt and one that forces a
 * multi-second turn. If append latency tracks turn duration, the agent flushes
 * at turn-end and FAILS the gate.
 *
 * OFFLINE MODE
 * `--offline` runs with credentials stripped. If the CLI appends the user turn
 * before calling the API, the probe costs no quota. But an unauthenticated run
 * has no turn to flush at turn-end, so a fast append there proves nothing:
 * offline can only ever yield "absent" (a negative) or "needs live
 * confirmation". Offline NEVER yields a PASS. The report enforces this.
 *
 * Usage:
 *   node scripts/measure-injection-flush.mjs --agent codex
 *   node scripts/measure-injection-flush.mjs --agent codex --offline
 *   node scripts/measure-injection-flush.mjs --agent all --trials 3
 *   node scripts/measure-injection-flush.mjs --list
 *
 * Flags:
 *   --agent <name|all>  agent to probe (required unless --list)
 *   --trials <n>        trials per case, default 3. Report uses the MAX.
 *   --offline           strip credentials; never produces a PASS
 *   --case <name>       run only one case: short | long | slash
 *   --keep              keep the temp workspace for inspection
 *   --timeout <ms>      per-probe appearance timeout, default 60000
 *   --out <path>        write the JSON report here
 *   --pattern <regex>   narrow the scan to the file the VERIFIER would read,
 *                       e.g. --agent qwen --pattern "^[0-9a-f-]+\.jsonl$"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nodePty = require('node-pty');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function readFlag(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const agentArg = readFlag('agent');
const trialCount = Number(readFlag('trials', 3));
const offlineMode = hasFlag('offline');
const caseFilter = readFlag('case', null);
const keepWorkspace = hasFlag('keep');
const appearTimeoutMs = Number(readFlag('timeout', 60_000));
const reportPath = readFlag('out', null);

/**
 * Narrow the scan to one filename shape.
 *
 * A verifier must be measured against the file IT will read, not merely the
 * first file on disk that happens to learn the text. Qwen showed why: the probe
 * landed in `logs.json` (a prompt log) in ~130ms, while the verifier would read
 * `chats/<sessionId>.jsonl`. Reporting the fast file would have credited the
 * verifier with a latency belonging to a file it never opens.
 */
const patternOverride = readFlag('pattern', null);
const overridePattern = patternOverride && patternOverride !== true
  ? new RegExp(patternOverride)
  : null;

// ---------------------------------------------------------------------------
// Agent configuration
//
// `sessionRoots` are scanned before and after the spawn so the session file is
// discovered by observation rather than by the app's resolver. `filePattern`
// only narrows the scan.
// ---------------------------------------------------------------------------

const home = os.homedir();

/**
 * Observe OpenCode by querying its SQLite store read-only.
 *
 * Uses the built-in `node:sqlite` rather than `better-sqlite3`: the native
 * module is built against Electron's ABI and cannot load in a stand-alone Node
 * runtime (the same reason `opencode/transcript-parser.ts` splits its pure
 * row-mapping out for unit tests).
 *
 * OpenCode owns this database and holds it in WAL, so the handle is read-only
 * and journal mode is never touched.
 */
function findNonceInOpenCodeDatabase(nonce) {
  const databasePath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (!fs.existsSync(databasePath)) return null;

  let database;
  try {
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database
      .prepare("SELECT message_id, data FROM part WHERE data LIKE ? LIMIT 1")
      .all(`%${nonce}%`);
    if (rows.length === 0) return null;
    return {
      filePath: `${databasePath}#part:${rows[0].message_id}`,
      line: String(rows[0].data).slice(0, 2000),
    };
  } catch {
    // A locked or mid-write DB simply has no answer yet; keep polling.
    return null;
  } finally {
    try { database?.close(); } catch { /* already closed */ }
  }
}

const AGENTS = {
  codex: {
    binary: 'codex',
    buildArgs: () => [],
    sessionRoots: () => [path.join(home, '.codex', 'sessions')],
    filePattern: /\.jsonl$/,
    note: 'rollout-<ISO-timestamp>-<uuid>.jsonl under a UTC-dated directory',
  },
  gemini: {
    binary: 'gemini',
    buildArgs: () => [],
    sessionRoots: () => [path.join(home, '.gemini', 'tmp')],
    filePattern: /^session-.*\.jsonl?$/,
    note: 'chats/session-*.jsonl; migrated from .json on 2026-04-28',
  },
  qwen: {
    binary: 'qwen',
    buildArgs: () => [],
    sessionRoots: () => [
      path.join(home, '.qwen', 'projects'),
      path.join(home, '.qwen', 'tmp'),
    ],
    filePattern: /\.(jsonl|json)$/,
    note: 'projects/<slug>/chats/<sessionId>.jsonl',
  },
  kimi: {
    binary: 'kimi',
    buildArgs: () => [],
    sessionRoots: () => [path.join(home, '.kimi', 'sessions')],
    filePattern: /^wire\.jsonl$/,
    note: 'sessions/<workDirHash>/<uuid>/wire.jsonl; timestamps are unix SECONDS',
  },
  droid: {
    binary: 'droid',
    buildArgs: () => [],
    sessionRoots: () => [path.join(home, '.factory', 'sessions')],
    filePattern: /\.jsonl$/,
    note: 'sessions/<cwd-slug>/<uuid>.jsonl',
  },
  opencode: {
    binary: 'opencode',
    buildArgs: () => [],
    sessionRoots: () => [path.join(home, '.local', 'share', 'opencode')],
    filePattern: /^opencode\.db$/,
    // OpenCode keeps no history FILE - every session lives in one SQLite DB in
    // WAL mode. A byte scan of the page file is not a valid observation (the
    // text may sit in the WAL, in a partial page, or compressed out of reach),
    // so this agent overrides the nonce search with a real read-only query.
    // Without it OpenCode reports "never landed" for reasons that have nothing
    // to do with flush timing.
    findNonce: findNonceInOpenCodeDatabase,
    note: 'SQLite (opencode.db + WAL), queried read-only. Remote sessions have no local row.',
  },
  aider: {
    binary: 'aider',
    buildArgs: () => [],
    // Aider writes into the working directory, not a home-relative root.
    sessionRootsFromWorkspace: (workspace) => [workspace],
    filePattern: /^\.aider\.chat\.history\.md$/,
    note: 'per-cwd .aider.chat.history.md; #### lines are user prompts',
  },
  cursor: {
    binary: 'cursor-agent',
    buildArgs: () => [],
    sessionRoots: () => [path.join(home, '.cursor', 'projects')],
    filePattern: /\.jsonl$/,
    // NOTE the binary: `cursor-agent`, never `agent`. Grok's CLI publishes
    // `agent` too and its .exe wins PATHEXT, so probing the short name
    // measures the wrong product entirely.
    note: 'projects/<cwd-slug>/agent-transcripts/<id>/<id>.jsonl; records carry NO timestamp',
  },
  copilot: {
    binary: 'copilot',
    buildArgs: () => [],
    sessionRoots: () => [path.join(home, '.copilot')],
    filePattern: /^command-history-state\.json$/,
    // Not a transcript: a flat, global, newest-first prompt history with no
    // timestamps and no session id, rewritten in place. The open question a
    // measurement answers is WHEN it is written - a shell-style history file
    // that only flushes on exit would be useless for verification.
    note: 'command-history-state.json; global prompt history, no timestamps, slash commands included',
  },
  claude: {
    binary: 'claude',
    buildArgs: () => [],
    sessionRoots: () => [path.join(home, '.claude', 'projects')],
    filePattern: /\.jsonl$/,
    // The control. Claude already ships a verifier built on this transcript,
    // so measuring it validates the HARNESS: a number wildly out of line with
    // Claude's known-good behaviour means the instrument drifted.
    note: 'projects/<slug>/<sessionId>.jsonl; the reference implementation, used as a harness control',
  },
  antigravity: {
    binary: 'agy',
    buildArgs: () => [],
    sessionRoots: () => [path.join(home, '.gemini', 'antigravity-cli', 'brain')],
    filePattern: /^transcript\.jsonl$/,
    note: 'brain/<conversationId>/.system_generated/logs/transcript.jsonl; USER_INPUT steps wrap the prompt in <USER_REQUEST>',
  },
};

// ---------------------------------------------------------------------------
// Probe cases. Each carries a nonce so appearance is unambiguous.
// ---------------------------------------------------------------------------

function buildCases(nonce) {
  return {
    short: {
      name: 'short',
      text: `Reply with exactly this token and nothing else: ${nonce}`,
      description: 'trivial prompt, turn ends fast',
    },
    long: {
      name: 'long',
      // The nonce goes at the END, never the front. Some TUIs drop leading
      // characters of typed input while they finish becoming interactive
      // (OpenCode ate between 6 and 40 of them), which silently destroys a
      // front-anchored marker and reads as "never landed" - blaming the agent's
      // flush timing for what is really an input race in this harness.
      text:
        'Do this slowly and thoroughly: count from 1 to 30, '
        + 'writing each number on its own line with a short comment about it. '
        + `Do not skip any number. Reference token ${nonce}`,
      description: 'forces a multi-second turn; the turn-end-flush discriminator',
    },
    slash: {
      name: 'slash',
      // A slash command that is very unlikely to be registered, so the CLI
      // either records it as a user turn or swallows it client-side. Either
      // answer is the one we need: if slash text never reaches history, a
      // command-injection verifier cannot work even when plain text lands.
      text: `/kng-probe-${nonce}`,
      description: 'slash invocation; may be handled client-side and never recorded',
      isSlash: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Filesystem observation
// ---------------------------------------------------------------------------

function walkFiles(root, pattern, accumulator = new Map(), depth = 0) {
  if (depth > 6) return accumulator;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return accumulator;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, pattern, accumulator, depth + 1);
    } else if (pattern.test(entry.name)) {
      try {
        const stats = fs.statSync(full);
        accumulator.set(full, { size: stats.size, mtimeMs: stats.mtimeMs });
      } catch {
        /* file vanished mid-scan */
      }
    }
  }
  return accumulator;
}

function snapshotRoots(roots, pattern) {
  const snapshot = new Map();
  for (const root of roots) walkFiles(root, pattern, snapshot);
  return snapshot;
}

/** Files that are new, or grew, since the baseline snapshot. */
function changedSince(baseline, current) {
  const changed = [];
  for (const [filePath, stats] of current) {
    const before = baseline.get(filePath);
    if (!before || stats.size !== before.size || stats.mtimeMs !== before.mtimeMs) {
      changed.push(filePath);
    }
  }
  return changed;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Find the nonce in any changed file. Returns the file, plus the containing
 * line so the record shape can be read off the report later.
 */
function findNonce(roots, pattern, baseline, nonce) {
  const current = snapshotRoots(roots, pattern);
  for (const filePath of changedSince(baseline, current)) {
    const content = readFileSafe(filePath);
    if (content === null || !content.includes(nonce)) continue;
    const line = content
      .split(/\r?\n/)
      .find((candidate) => candidate.includes(nonce));
    return { filePath, line: line ?? null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// PTY helpers (patterns lifted from scripts/validate-clear-fork.mjs)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[=>]/g, '');
}

/**
 * Strip this session's own agent identity markers so the child CLI persists
 * its own transcript. Mirrors buildSpawnEnv (src/main/pty/spawn/pty-spawn.ts).
 * In offline mode also strip credentials so no API call is made.
 */
function buildEnv({ offline }) {
  const env = {};
  const credentialPattern = /(API_KEY|AUTH_TOKEN|_TOKEN|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_|MOONSHOT_|DASHSCOPE_)/i;
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue;
    if (offline && credentialPattern.test(key)) continue;
    env[key] = value;
  }
  if (offline) {
    // Point the CLIs at a dead endpoint so an authenticated config file cannot
    // silently rescue the run and turn an offline probe into a real turn.
    env.HTTP_PROXY = 'http://127.0.0.1:9';
    env.HTTPS_PROXY = 'http://127.0.0.1:9';
    env.NO_PROXY = '';
  }
  return env;
}

function spawnAgent(agent, workspace, env) {
  const args = agent.buildArgs();
  const options = { cwd: workspace, env, cols: 120, rows: 40, name: 'xterm-256color' };
  if (process.platform === 'win32') {
    // This script runs from a bare `node` process with no attached console, and
    // ConPTY's console-list agent calls AttachConsole, which fails there and
    // kills the child immediately. The app itself does not need this (it runs
    // under Electron with a console); the winpty backend has no such
    // requirement, so force it for the harness only.
    options.useConpty = false;
    return nodePty.spawn('cmd.exe', ['/c', agent.binary, ...args], options);
  }
  return nodePty.spawn(agent.binary, args, options);
}

/**
 * Wait until the TUI has drawn and gone quiet. Deliberately agent-agnostic:
 * matching banner strings breaks on every CLI release. t0 for the measurement
 * is the Enter write, never the spawn, so this only needs to be "ready enough
 * to accept typing".
 */
async function waitForReady(state, { minBytes = 200, quietMs = 1500, timeoutMs = 90_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Exit is checked BEFORE the quiet heuristic and short-circuits. A crashing
    // CLI prints its stack trace and then goes quiet, which otherwise satisfies
    // "settled" and reports a dead process as a ready TUI - manufacturing a
    // false verdict, which is the exact failure this gate exists to prevent.
    if (state.exited) return false;
    maybeAnswerPrompt(state);
    const quietFor = Date.now() - state.lastDataAt;
    if (state.totalBytes >= minBytes && quietFor >= quietMs) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Accept the trust / onboarding prompts a fresh temp workspace triggers.
 * Each is answered at most once so a stray Enter cannot submit a probe early.
 */
function maybeAnswerPrompt(state) {
  const recent = stripAnsi(state.scrollback.slice(-6000));
  const patterns = [
    /trust\s*(this|the)\s*(folder|directory)/i,
    /safety\s*check/i,
    /do\s*you\s*trust/i,
    /allow\s*this\s*folder/i,
  ];
  for (const pattern of patterns) {
    const key = pattern.source;
    if (state.answeredPrompts.has(key)) continue;
    if (pattern.test(recent)) {
      state.answeredPrompts.add(key);
      state.pty.write('\r');
      return;
    }
  }
}

/**
 * Detect a CLI parked on a login / onboarding gate.
 *
 * A gated CLI draws a full TUI and then goes quiet, which satisfies the
 * "settled" heuristic exactly like a ready agent does. Without this check the
 * probe types into a login screen, nothing lands, and the run records a
 * measured "turn-end flushed" STOP for an agent that never ran a turn. Droid
 * did precisely that: it sat on a Factory device-code prompt and was reported
 * as a stop.
 *
 * A false STOP is far less dangerous than a false PASS (it only withholds a
 * verifier), but it is still a fabricated measurement, and the whole point of
 * this script is that the recorded verdicts are real.
 */
function detectAuthGate(scrollback) {
  const text = stripAnsi(scrollback).toLowerCase();
  // Phrase matching ALWAYS lags vendors, and this list has been wrong twice:
  // Droid's device-code prompt was added only after it drew a confident STOP,
  // and Cursor's ("Press any key to log in...", "Signing in with the
  // browser...") matched nothing here either. Treat a miss as expected rather
  // than surprising, and keep reading `scrollbackTail` on any STOP before
  // believing it. Broadened patterns reduce the gap; they do not close it.
  const patterns = [
    /please log ?in/,
    /log ?in with your/,
    /sign ?in to continue/,
    /waiting for authentication/,
    /device code|enter code [a-z0-9-]{4,}/,
    /not authenticated|unauthenticated/,
    /no api key|api key (is )?(required|missing|not set)/,
    /authentication (failed|required)/,
    // Cursor
    /press any key to log ?in/,
    /signing in with the browser/,
    /click this link to log ?in/,
    // Generic browser-handoff and prompt-to-authenticate shapes
    /browser did ?n[o']?t open/,
    /\blog ?in\b[^\n]{0,40}\bbrowser\b/,
    /\/login\?|\/login[a-z]*\?challenge=/,
  ];
  const match = patterns.find((pattern) => pattern.test(text));
  return match ? match.source : null;
}

async function typeSlowly(pty, text, perCharMs = 12) {
  for (const char of text) {
    pty.write(char);
    if (perCharMs > 0) await sleep(perCharMs);
  }
}

// ---------------------------------------------------------------------------
// One probe
// ---------------------------------------------------------------------------

async function runProbe({ agentName, agent, probeCase, trialIndex }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `kng-flush-${agentName}-`));
  fs.writeFileSync(path.join(workspace, 'README.md'), 'Measurement workspace.\n');

  const roots = agent.sessionRootsFromWorkspace
    ? agent.sessionRootsFromWorkspace(workspace)
    : agent.sessionRoots();
  const filePattern = overridePattern ?? agent.filePattern;
  const baseline = snapshotRoots(roots, filePattern);

  const env = buildEnv({ offline: offlineMode });
  const spawnedAt = Date.now();

  // A spawn throw (binary missing, or a node-pty backend failure) must degrade
  // to `unmeasurable-here` for THIS agent. Previously it escaped runProbe's try
  // and killed the whole sweep silently after the preceding agent's summary,
  // which reads exactly like "still running" and cost a full run.
  let pty;
  try {
    pty = spawnAgent(agent, workspace, env);
  } catch (error) {
    if (!keepWorkspace) {
      try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return {
      agent: agentName,
      case: probeCase.name,
      trial: trialIndex + 1,
      offline: offlineMode,
      ready: false,
      spawnToFileExistsMs: null,
      writeToRecordMs: null,
      turnDurationMs: null,
      filePath: null,
      recordLine: null,
      exitedDuringProbe: true,
      scrollbackTail: null,
      error: `spawn failed: ${String(error && error.message ? error.message : error)}`,
    };
  }

  const state = {
    pty,
    scrollback: '',
    totalBytes: 0,
    lastDataAt: Date.now(),
    exited: false,
    answeredPrompts: new Set(),
  };
  pty.onData((data) => {
    state.scrollback += data;
    state.totalBytes += data.length;
    state.lastDataAt = Date.now();
  });
  pty.onExit(() => { state.exited = true; });

  const result = {
    agent: agentName,
    case: probeCase.name,
    trial: trialIndex + 1,
    offline: offlineMode,
    ready: false,
    spawnToFileExistsMs: null,
    writeToRecordMs: null,
    turnDurationMs: null,
    filePath: null,
    recordLine: null,
    exitedDuringProbe: false,
    scrollbackTail: null,
    error: null,
  };

  try {
    result.ready = await waitForReady(state, {});
    if (!result.ready) {
      result.exitedDuringProbe = state.exited;
      result.scrollbackTail = stripAnsi(state.scrollback.slice(-1200)).trim() || null;
      // Also checked here, not only on the nonce-timeout path: a CLI whose
      // login prompt exits, or that prints less than `minBytes`, never reaches
      // "ready" at all. Both branches land in `unmeasurable-here` regardless,
      // but only this makes the REASON say so.
      result.authGate = detectAuthGate(state.scrollback);
      result.error = result.authGate
        ? `CLI is parked on a login / auth gate (matched /${result.authGate}/)`
        : state.exited
          ? 'CLI exited before the TUI was ready (missing auth, or a startup failure)'
          : 'timed out waiting for the TUI to settle';
      return result;
    }

    // Latency 1: spawn -> a session file exists at all. Production injects
    // near spawn time, so the file may not exist yet when polling starts. A
    // verifier that reads "file missing" as `failed` is the destructive bug by
    // another route, so this number matters independently.
    if (!agent.findNonce) {
      const existing = changedSince(baseline, snapshotRoots(roots, filePattern));
      if (existing.length > 0) result.spawnToFileExistsMs = Date.now() - spawnedAt;
    }

    // Settle again before typing. "The TUI stopped painting" is not the same as
    // "the TUI is accepting input": OpenCode swallowed the first 6-40 typed
    // characters after it had gone quiet. Production does not hit this because
    // `submitKeystrokes` runs its own Ctrl+U handshake and settle first; this
    // pause is the harness's stand-in for that.
    await sleep(1500);

    // Type the probe, then start the clock on the Enter, exactly as
    // TerminalSubmit does (text, settle, then \r).
    await typeSlowly(pty, probeCase.text);
    await sleep(probeCase.isSlash ? 600 : 250);

    const sentAt = Date.now();
    pty.write('\r');

    // Poll at the same cadence a real verifier uses (VERIFY_POLL_MS = 25).
    let found = null;
    const deadline = sentAt + appearTimeoutMs;
    while (Date.now() < deadline) {
      found = agent.findNonce
        ? agent.findNonce(probeCase.nonce)
        : findNonce(roots, filePattern, baseline, probeCase.nonce);
      if (found) break;
      if (state.exited) break;
      await sleep(25);
    }

    if (found) {
      result.writeToRecordMs = Date.now() - sentAt;
      result.filePath = found.filePath;
      result.recordLine = found.line ? found.line.slice(0, 2000) : null;
      if (result.spawnToFileExistsMs === null) {
        result.spawnToFileExistsMs = Date.now() - spawnedAt;
      }
    } else {
      result.exitedDuringProbe = state.exited;
      result.scrollbackTail = stripAnsi(state.scrollback.slice(-1200)).trim() || null;
      // Distinguish "the agent ran and did not record it" from "the agent was
      // never able to run", which are opposite verdicts.
      result.authGate = detectAuthGate(state.scrollback);
      result.error = result.authGate
        ? `CLI is parked on a login / auth gate (matched /${result.authGate}/)`
        : state.exited
          ? 'CLI exited before the nonce appeared'
          : `nonce never appeared within ${appearTimeoutMs}ms`;
    }

    // Turn duration: how long until output goes quiet. Comparing this against
    // writeToRecordMs is what separates submit-flush from turn-end-flush.
    //
    // Skipped offline: there is no real turn, and the CLI retries against the
    // dead proxy for a minute or more, which is pure wall-clock with nothing to
    // measure. Offline cannot yield a PASS anyway, so the discriminator is not
    // needed there.
    if (!offlineMode) {
      const turnDeadline = Date.now() + 90_000;
      while (Date.now() < turnDeadline && !state.exited) {
        if (Date.now() - state.lastDataAt > 4000) break;
        await sleep(200);
      }
      result.turnDurationMs = state.lastDataAt - sentAt;
    }
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
  } finally {
    try { pty.kill(); } catch { /* already gone */ }
    await sleep(300);
    if (!keepWorkspace) {
      try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
    } else {
      result.workspace = workspace;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * The bar, DERIVED from the delivery budget rather than picked.
 *
 * `submitKeystrokes` retries up to `MAX_SUBMIT_ATTEMPTS` (5) times, polling for
 * `VERIFY_WINDOW_MS` (400ms) after each Enter, so a submission has ~2000ms to
 * become visible before the outcome is `failed`. `sentAt` advances on every
 * retry, so a record written at Nms is caught by whichever attempt is in flight
 * when it lands - the agent does not have to beat a single 400ms window.
 *
 * The bar IS the budget, with no reserve, and that is a deliberate choice the
 * control forced. Two earlier attempts to hold reserve (1000ms, then 1500ms)
 * both failed CLAUDE - the reference implementation whose verifier ships and
 * works - at 1412ms and then 1876ms. Any bar that rejects the known-good
 * adapter is measuring the wrong thing, so the reserve had to go.
 *
 * Claude's control is BIMODAL: 775/791/779ms or 1812/1828/1876ms, nothing
 * between. That is a periodic flush being caught either side of its interval,
 * not jitter, so "typical" latency is meaningless here and only the upper mode
 * matters. It also means an adapter can sit at ~94% of budget and still work,
 * which is why the discriminators that matter are TURN-TRACKING and OUTRIGHT
 * MISSES, not a tidy millisecond cutoff.
 *
 * Re-run `--agent claude` after touching this constant. If the control does not
 * pass, the instrument is broken and no other verdict from it can be trusted.
 */
const PASS_THRESHOLD_MS = 2000;

/**
 * Three verdicts, never two. Auth failure is not a PASS and not a STOP: it is
 * `unmeasurable-here`, which documents as `null` WITH the reason.
 */
function decideVerdict(agentName, results) {
  const usable = results.filter((entry) => entry.ready);
  if (usable.length === 0) {
    return {
      verdict: 'unmeasurable-here',
      reason: 'the CLI never reached a ready TUI (not installed, not authenticated, or it failed at startup)',
    };
  }

  const byCase = {};
  for (const entry of usable) {
    byCase[entry.case] = byCase[entry.case] ?? [];
    byCase[entry.case].push(entry);
  }

  const landed = (entries) => entries.filter((entry) => entry.writeToRecordMs !== null);
  const worst = (entries) => Math.max(...landed(entries).map((entry) => entry.writeToRecordMs));

  const shortRuns = byCase.short ?? [];
  const longRuns = byCase.long ?? [];
  const slashRuns = byCase.slash ?? [];

  // A CLI that died mid-probe tells us nothing about flush timing. That is
  // `unmeasurable-here`, NOT a stop: reporting it as a stop would record a
  // measured "no" that was never measured.
  const nonSlash = [...shortRuns, ...longRuns];
  const crashed = nonSlash.filter((entry) => entry.exitedDuringProbe);
  const gated = nonSlash.filter((entry) => entry.authGate);

  // An auth gate outranks everything: the agent never ran a turn, so there is
  // no flush behaviour to have observed.
  if (gated.length > 0 && landed(nonSlash).length === 0) {
    return {
      verdict: 'unmeasurable-here',
      reason: `the CLI is parked on a login / auth gate (matched /${gated[0].authGate}/), so no turn ever ran`,
      diagnostic: gated[0].scrollbackTail,
    };
  }

  if (nonSlash.length > 0 && landed(nonSlash).length === 0 && crashed.length > 0) {
    return {
      verdict: 'unmeasurable-here',
      reason: 'the CLI exited mid-probe on every trial (most likely unauthenticated)',
      diagnostic: crashed[0].scrollbackTail,
    };
  }

  // A trial that NEVER landed is the worst possible observation, but it has no
  // `writeToRecordMs`, so `worst()` cannot see it - it averages only over
  // trials that arrived. Counting misses explicitly is what stops a miss from
  // being silently dropped: OpenCode had one probe never appear within 25s
  // alongside three sub-100ms hits, and without this it scored `implement` on a
  // 95ms worst case while a quarter of its submissions vanished.
  //
  // Only READY, un-gated, un-crashed trials count as misses; the auth-gate and
  // crash branches above already claimed the trials that prove nothing.
  const missed = nonSlash.filter((entry) => entry.writeToRecordMs === null);
  if (missed.length > 0) {
    return {
      verdict: 'stop',
      reason: `${missed.length} of ${nonSlash.length} probes never landed within the timeout`
        + `${landed(nonSlash).length > 0 ? `, despite others arriving in ${worst(nonSlash)}ms or less` : ''}`,
    };
  }

  // The discriminator: on a long turn, does the record land promptly, or only
  // once the turn ends?
  if (longRuns.length > 0) {
    const worstLong = worst(longRuns);
    const turnDurations = landed(longRuns).map((entry) => entry.turnDurationMs ?? 0);
    const longestTurn = Math.max(...turnDurations, 0);
    if (worstLong > PASS_THRESHOLD_MS && longestTurn > 0 && worstLong > longestTurn * 0.6) {
      return {
        verdict: 'stop',
        reason: `append latency tracks turn duration (${worstLong}ms against a ${longestTurn}ms turn): turn-end flushed`,
      };
    }
  }

  // The bar applies to EVERY observation, not just the long-turn ones. Droid is
  // why: its long turns appended in ~640ms while a short turn took 3202ms, so
  // gating on the long runs alone returned "implement" while reporting a worst
  // case three times over the bar. "Reliably under ~1s" means reliably, and a
  // verifier is the thing that authorizes a session-destroying restart, so the
  // worst observation governs.
  const allRuns = [...shortRuns, ...longRuns];
  if (landed(allRuns).length > 0) {
    const worstAny = worst(allRuns);
    if (worstAny > PASS_THRESHOLD_MS) {
      const best = Math.min(...landed(allRuns).map((entry) => entry.writeToRecordMs));
      return {
        verdict: 'stop',
        reason: `too variable: worst ${worstAny}ms against a best of ${best}ms, over the ${PASS_THRESHOLD_MS}ms bar`,
      };
    }
  }

  if (offlineMode) {
    return {
      verdict: 'needs-live-confirmation',
      reason:
        'offline run: the CLI wrote the user turn without an API call, but an unauthenticated run '
        + 'has no turn to flush at turn-end, so this cannot establish a PASS',
    };
  }

  const worstOverall = Math.max(
    shortRuns.length > 0 && landed(shortRuns).length > 0 ? worst(shortRuns) : 0,
    longRuns.length > 0 && landed(longRuns).length > 0 ? worst(longRuns) : 0,
  );

  const slashLanded = slashRuns.length === 0 ? null : landed(slashRuns).length > 0;

  return {
    verdict: 'implement',
    reason: `worst observed append latency ${worstOverall}ms across ${usable.length} ready trials`,
    slashRecorded: slashLanded,
    slashNote: slashLanded === false
      ? 'slash text never reached the history file: a submitted-mode verifier still works for prose, '
        + 'but slash auto_commands cannot be verified'
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function measureAgent(agentName) {
  const agent = AGENTS[agentName];
  if (!agent) throw new Error(`unknown agent: ${agentName}`);

  console.log(`\n=== ${agentName} ${offlineMode ? '(offline)' : '(live)'} ===`);
  console.log(`    ${agent.note}`);

  const results = [];
  const caseNames = caseFilter ? [caseFilter] : ['short', 'long', 'slash'];

  for (const caseName of caseNames) {
    for (let trialIndex = 0; trialIndex < trialCount; trialIndex += 1) {
      const nonce = `KNGPROBE${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
      const probeCase = { ...buildCases(nonce)[caseName], nonce };
      if (!probeCase.text) throw new Error(`unknown case: ${caseName}`);

      process.stdout.write(`  ${caseName} trial ${trialIndex + 1}/${trialCount} ... `);

      // Hard per-probe ceiling. A CLI that never reaches a usable TUI can hang
      // well past the sum of the individual waits (kimi did, for over seven
      // minutes on a single trial), and a stalled probe is indistinguishable
      // from a slow one while it is happening. Capping it turns "the sweep
      // silently stopped" into a recorded `unmeasurable-here`.
      const probeCeilingMs = 4 * 60_000;
      const result = await Promise.race([
        runProbe({ agentName, agent, probeCase, trialIndex }),
        sleep(probeCeilingMs).then(() => ({
          agent: agentName,
          case: caseName,
          trial: trialIndex + 1,
          offline: offlineMode,
          ready: false,
          spawnToFileExistsMs: null,
          writeToRecordMs: null,
          turnDurationMs: null,
          filePath: null,
          recordLine: null,
          exitedDuringProbe: false,
          scrollbackTail: null,
          error: `probe exceeded the ${Math.round(probeCeilingMs / 1000)}s ceiling`,
        })),
      ]);
      results.push(result);

      if (result.error) {
        console.log(`ERROR: ${result.error}`);
      } else {
        console.log(
          `appeared in ${result.writeToRecordMs}ms `
          + `(turn ${result.turnDurationMs}ms, file ${path.basename(result.filePath ?? '?')})`,
        );
      }
    }
  }

  const verdict = decideVerdict(agentName, results);
  console.log(`  -> ${verdict.verdict.toUpperCase()}: ${verdict.reason}`);
  if (verdict.slashNote) console.log(`     ${verdict.slashNote}`);

  return { agent: agentName, offline: offlineMode, results, ...verdict };
}

async function main() {
  if (hasFlag('list')) {
    console.log('Agents:');
    for (const [name, agent] of Object.entries(AGENTS)) {
      console.log(`  ${name.padEnd(10)} ${agent.note}`);
    }
    return;
  }

  if (!agentArg || agentArg === true) {
    console.error('Usage: node scripts/measure-injection-flush.mjs --agent <name|all> [--offline]');
    console.error('       node scripts/measure-injection-flush.mjs --list');
    process.exitCode = 1;
    return;
  }

  const names = agentArg === 'all' ? Object.keys(AGENTS) : [agentArg];
  const report = {
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    offline: offlineMode,
    trials: trialCount,
    passThresholdMs: PASS_THRESHOLD_MS,
    agents: [],
  };

  for (const name of names) {
    try {
      report.agents.push(await measureAgent(name));
    } catch (error) {
      // Keep going: one agent's failure must never end the sweep, or every
      // later agent silently reports nothing at all.
      console.error(`  ${name}: ${error.message}`);
      report.agents.push({
        agent: name,
        verdict: 'unmeasurable-here',
        reason: error.message,
        results: [],
      });
    }
  }

  console.log('\n=== SUMMARY ===');
  for (const entry of report.agents) {
    console.log(`  ${entry.agent.padEnd(10)} ${entry.verdict.padEnd(24)} ${entry.reason}`);
  }
  if (offlineMode) {
    console.log('\n  NOTE: offline runs can never establish a PASS. Re-run authenticated');
    console.log('        for any agent reported as needs-live-confirmation.');
  }

  const destination = reportPath && reportPath !== true
    ? reportPath
    : path.join(os.tmpdir(), `kng-flush-report-${Date.now()}.json`);
  fs.writeFileSync(destination, JSON.stringify(report, null, 2));
  console.log(`\nreport: ${destination}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
