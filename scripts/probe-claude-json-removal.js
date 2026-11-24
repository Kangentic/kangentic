#!/usr/bin/env node
/*
 * MANUAL PROBE - NEVER WIRED INTO TESTS OR CI.
 *
 * Does a running Claude Code put back `projects` entries another process removed from its
 * `.claude.json`? It is the evidence behind Kangentic dropping a removed worktree's entry
 * (`removeWorktreeEntry` and `sweepRemovedFolderEntries` in
 * `src/main/agent/adapters/claude/trust-manager.ts`, task #1190). Task #1182 swept 6,456 dead
 * entries and found them all back ten minutes later, and blamed a running Claude saving the copy
 * it held in memory.
 *
 * Each round starts Claude's TUI in node-pty on the classic renderer
 * (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1, which never arms the boot canary) against a local
 * stand-in for the Messages API (ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, so no account is
 * used and nothing is billed). HOME, USERPROFILE and CLAUDE_CONFIG_DIR point into a sandbox, so
 * no real state file is read or written. The state file is seeded with `--entries` worktree
 * entries. Once Claude is at its prompt, the probe removes them the way Kangentic does: under
 * `.claude.json.lock` (a `mkdir`), written to a temp file and renamed. Then it makes Claude save:
 * one turn, then `/exit`. It counts the entries after each, and how many times Claude rewrote the
 * file after the removal, since a run where Claude never saved proves nothing.
 *
 * Rounds:
 *   settled    the removal, a 3 s pause (Claude's freshness watch polls every 1 s), then the turn
 *   immediate  the turn is submitted as soon as the removal's rename lands
 *   trust      the folder starts untrusted; the removal lands while the trust prompt is open, and
 *              accepting it is a save that adds a folder to `projects`
 *
 * Usage:
 *   node scripts/probe-claude-json-removal.js [--claude <path>] [--rounds settled,immediate,trust]
 *        [--entries 2000] [--out <results.jsonl>]
 *
 * On Windows `--claude` must name a `claude.exe`: node-pty cannot start an npm `claude.cmd` shim.
 *
 * Measured 2026-11-23 on Claude Code 2.1.331, Windows 11 build 26200, node-pty 1.1.0, 2,000
 * entries, every round: no entry came back. Claude rewrote the file 3 to 4 times after the removal
 * in settled and immediate, and 9 times in trust, where the accepted folder was saved. See
 * `docs/integrations/agents/claude-code.md`, "Removed worktree entries".
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const ROUNDS = ['settled', 'immediate', 'trust'];
const READY_TIMEOUT_MS = 45000;
const TURN_TIMEOUT_MS = 45000;
const EXIT_TIMEOUT_MS = 15000;
const PROBE_FOLDER_PREFIX = 'C:/probe-checkout/.kangentic/worktrees/task-';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

/** Answers every Messages API call with one short text reply, streamed or not. */
class FakeAnthropicApi {
  constructor() {
    this.messageCount = 0;
    this.server = http.createServer((request, response) => this.handle(request, response));
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port)));
  }

  close() {
    // Claude's keep-alive connections would hold the server, and the probe, open.
    this.server.closeAllConnections();
    this.server.close();
  }

  handle(request, response) {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const route = (request.url ?? '').split('?')[0];
      if (request.method !== 'POST') return this.json(response, {});
      if (route.endsWith('/count_tokens')) return this.json(response, { input_tokens: 10 });
      if (!route.endsWith('/v1/messages')) return this.json(response, {});
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        payload = {};
      }
      this.messageCount += 1;
      this.respond(response, payload, 'Done.');
    });
  }

  json(response, value) {
    const data = JSON.stringify(value);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    response.end(data);
  }

  respond(response, payload, text) {
    const message = {
      id: `msg_probe_${Date.now()}`, type: 'message', role: 'assistant', model: payload.model ?? 'claude-haiku', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
    };
    if (!payload.stream) {
      message.content = [{ type: 'text', text }];
      message.stop_reason = 'end_turn';
      return this.json(response, message);
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (name, data) => response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    event('message_start', { type: 'message_start', message });
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    event('content_block_stop', { type: 'content_block_stop', index: 0 });
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    event('message_stop', { type: 'message_stop' });
    response.end();
  }
}

/** The environment of a sandboxed Claude: no inherited Claude or Anthropic variable reaches it. */
function runEnvironment(port, fakeHome, configDir) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    // CLAUDE_CONFIG_DIR too: a probe started from an account session would inherit its folder.
    if (/^CLAUDE_?CODE/i.test(key) || key === 'CLAUDE_CONFIG_DIR' || key.startsWith('ANTHROPIC_')) continue;
    environment[key] = value;
  }
  environment.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  environment.ANTHROPIC_AUTH_TOKEN = 'probe-placeholder';
  environment.DISABLE_AUTOUPDATER = '1';
  environment.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1';
  if (fakeHome) {
    environment.HOME = fakeHome;
    environment.USERPROFILE = fakeHome;
  }
  if (configDir) environment.CLAUDE_CONFIG_DIR = configDir;
  return environment;
}

function stripEscapes(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ' ')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b./g, ' ');
}

/** The probe's entries in the state file, or null while it reads torn or missing. */
function countProbeEntries(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return Object.keys(state.projects ?? {}).filter((key) => key.startsWith(PROBE_FOLDER_PREFIX)).length;
  } catch {
    return null;
  }
}

async function countSettled(statePath) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const count = countProbeEntries(statePath);
    if (count !== null) return count;
    await sleep(50);
  }
  return null;
}

/** Kangentic's removal: under Claude's own lock, a temp file renamed over the state file. */
async function removeProbeEntries(statePath) {
  const lockPath = `${statePath}.lock`;
  const startedAt = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() - startedAt > 12000) throw error;
      await sleep(50);
    }
  }
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const key of Object.keys(state.projects ?? {})) {
      if (key.startsWith(PROBE_FOLDER_PREFIX)) delete state.projects[key];
    }
    const temporaryPath = `${statePath}.probe.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
    fs.renameSync(temporaryPath, statePath);
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

/** Counts each rewrite of the state file from now on, by its size and change time. */
function watchWrites(statePath) {
  const seen = { writes: 0, last: null };
  const read = () => {
    try {
      const stat = fs.statSync(statePath);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  };
  seen.last = read();
  const timer = setInterval(() => {
    const now = read();
    if (now !== null && now !== seen.last) {
      seen.writes += 1;
      seen.last = now;
    }
  }, 25);
  return { seen, stop: () => clearInterval(timer) };
}

async function runRound(claude, api, port, round, entryCount, version) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `kangentic-claude-json-removal-${round}-`)));
  const fakeHome = path.join(root, 'home');
  const configDir = path.join(root, 'config');
  const runDir = path.join(root, 'project');
  for (const folder of [fakeHome, configDir, runDir]) fs.mkdirSync(folder, { recursive: true });
  const statePath = path.join(configDir, '.claude.json');
  // The `trust` round leaves the folder untrusted, so Claude opens on its trust prompt.
  const projects = round === 'trust' ? {} : { [runDir.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } };
  for (let index = 0; index < entryCount; index += 1) {
    projects[`${PROBE_FOLDER_PREFIX}${index}`] = { allowedTools: [], enabledMcpjsonServers: ['kangentic'], disabledMcpjsonServers: [], hasTrustDialogAccepted: true };
  }
  fs.writeFileSync(statePath, JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5, projects }, null, 2));

  const nodePtyDir = path.dirname(require.resolve('node-pty/package.json'));
  const pty = require(nodePtyDir);
  const terminal = pty.spawn(claude, ['--model', 'haiku'], {
    name: 'xterm-256color', cols: 140, rows: 40, cwd: runDir, env: runEnvironment(port, fakeHome, configDir),
  });
  let output = '';
  let exited = false;
  terminal.onData((data) => { output += data; });
  terminal.onExit(() => { exited = true; });
  const screen = () => stripEscapes(output).replace(/\s+/g, ' ');
  const waitFor = async (test, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !exited) {
      if (test()) return true;
      await sleep(200);
    }
    return test();
  };

  const record = { at: new Date().toISOString(), platform: process.platform, version, round, seeded: entryCount };
  try {
    let writes;
    if (round === 'trust') {
      // Removed while the trust prompt is open, so accepting it is a save that adds a folder to
      // `projects` from a process that loaded the file before the removal.
      record.trustPrompt = await waitFor(() => /trust this folder/i.test(screen()) && /Enter to confirm/i.test(screen()), READY_TIMEOUT_MS);
      await sleep(3000);
      record.beforeRemoval = await countSettled(statePath);
      await removeProbeEntries(statePath);
      writes = watchWrites(statePath);
      record.afterRemoval = await countSettled(statePath);
      // The cursor starts on "No, exit" (2.1.306): move to "Yes", then confirm.
      terminal.write('\x1b[B');
      await sleep(400);
      terminal.write('\r');
    }
    // The prompt's footer: "? for shortcuts", or the permission mode's own line (2.1.331 opens in
    // "auto mode on (shift+tab to cycle)" against the stand-in).
    record.ready = await waitFor(() => /for shortcuts|shift\+tab to cycle/i.test(screen()), READY_TIMEOUT_MS);
    if (round === 'trust') {
      await sleep(2000);
      record.afterTrust = await countSettled(statePath);
      record.trustSaved = (() => {
        try {
          const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          return Object.values(state.projects ?? {}).some((entry) => entry?.hasTrustDialogAccepted === true);
        } catch {
          return null;
        }
      })();
    } else {
      // Past boot: Claude's own startup saves (numStartups and the like) have landed.
      await sleep(3000);
      record.beforeRemoval = await countSettled(statePath);
      await removeProbeEntries(statePath);
      writes = watchWrites(statePath);
      record.afterRemoval = await countSettled(statePath);
      if (round === 'settled') await sleep(3000);
    }

    const repliesBefore = api.messageCount;
    terminal.write('PROBE-TURN say done');
    await sleep(400);
    terminal.write('\r');
    record.turnAnswered = await waitFor(() => api.messageCount > repliesBefore && /Done\./.test(screen()), TURN_TIMEOUT_MS);
    await sleep(2000);
    record.afterTurn = await countSettled(statePath);
    record.writesBeforeExit = writes.seen.writes;

    terminal.write('/exit');
    await sleep(400);
    terminal.write('\r');
    record.exitedByItself = await waitFor(() => exited, EXIT_TIMEOUT_MS);
    await sleep(1000);
    writes.stop();
    record.afterExit = await countSettled(statePath);
    record.claudeWritesAfterRemoval = writes.seen.writes;
    record.cameBack = (record.afterTrust ?? 0) > 0 || (record.afterTurn ?? 0) > 0 || (record.afterExit ?? 0) > 0;
    if (!record.ready || !record.turnAnswered) record.screenTail = screen().slice(-600);
  } finally {
    if (!exited) terminal.kill();
    await sleep(1500);
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      record.cleanup = `left ${root}: ${error.code}`;
    }
  }
  return record;
}

/**
 * An absolute path for a bare command name: node-pty does not search PATH. On Windows only an
 * `.exe` will do, since node-pty cannot start an npm shim (`claude.cmd`).
 */
function resolveExecutable(command) {
  if (path.isAbsolute(command)) return command;
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8' });
  const found = (lookup.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform !== 'win32') return found[0] ?? command;
  const executable = found.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
  if (!executable) {
    throw new Error(`no ${command}.exe on PATH (found ${found.join(', ') || 'nothing'}); pass --claude <path to claude.exe>`);
  }
  return executable;
}

async function main() {
  const claude = resolveExecutable(argument('claude', 'claude'));
  const rounds = argument('rounds', ROUNDS.join(',')).split(',');
  const entryCount = Number(argument('entries', '2000'));
  const outPath = argument('out');
  for (const round of rounds) if (!ROUNDS.includes(round)) throw new Error(`unknown round ${round}`);
  const versionResult = spawnSync(claude, ['--version'], { encoding: 'utf8', env: runEnvironment(1, null, null) });
  const version = (versionResult.stdout ?? '').trim().split(' ')[0];
  const api = new FakeAnthropicApi();
  const port = await api.listen();
  try {
    for (const round of rounds) {
      const line = JSON.stringify(await runRound(claude, api, port, round, entryCount, version));
      console.log(line);
      if (outPath) fs.appendFileSync(outPath, line + '\n');
    }
  } finally {
    api.close();
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  // node-pty's handles would keep a failed run open.
  process.exit(1);
});
