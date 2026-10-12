#!/usr/bin/env node
/*
 * MANUAL PROBE - NEVER WIRED INTO TESTS OR CI. WINDOWS (ConPTY) ONLY.
 *
 * Reproduces Sentry DESKTOP-1V: node-pty 1.1.0 keeps every ConPTY in one
 * unlocked `std::vector` (src/win/conpty.cc), and each PTY's exit thread runs
 * `remove_if` then `erase` on it. Two exits at once let one thread read a
 * moved-out `unique_ptr` and the process dies with an access violation at 0x0.
 * node-pty 1.2.0-beta.13 put `g_ptyHandlesMutex` around every access. This
 * probe runs the same loop against any extracted node-pty so the two can be
 * compared; `tests/unit/node-pty-version-pin.test.ts` keeps the fixed source
 * pinned.
 *
 * The parent re-runs this file as a worker under the same runtime, reads one
 * line per round, and reports how many rounds each worker survived and how it
 * exited. 3221225477 (0xC0000005) is the access violation.
 *
 * Run it under Electron as Node, the runtime the pty host uses, with node-pty
 * extracted from its npm tarball into a folder of its own:
 *   npm pack node-pty@<version> --pack-destination <dir>
 *   tar -xzf <dir>/node-pty-<version>.tgz -C <dir> --force-local
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/probe-conpty-exit-race.js --node-pty <dir>/package [--mode kill]
 *
 * Options:
 *   --node-pty <dir>   the extracted package root (required)
 *   --mode <mode>      kill (default), natural, churn, or pid
 *   --children <n>     PTYs per round (default 16)
 *   --rounds <n>       rounds per worker (default 500)
 *   --attempts <n>     workers to run, each from round 1 (default 1)
 *   --settle-ms <ms>   natural mode: how long after the spawns the shared
 *                      deadline falls, before the per-child allowance (default 1500)
 *   --no-release       churn mode: no kill() after a PTY exits on its own, which is
 *                      what the pty host did before it released them (pty-host-core.ts)
 *
 * Modes:
 *   kill      every round starts the children as cmd.exe, waits until each has
 *             printed (node-pty defers kill() until first output), then kills
 *             them all in one synchronous loop: the app's quit, `killAll()`.
 *   natural   every round starts the children as node.exe (from PATH) sleeping
 *             to one shared deadline, so they all exit in the same millisecond
 *             without a kill: several tasks ending together.
 *   churn     one cmd.exe that exits at once per round, never two alive
 *             together, so nothing races: it measures what natural exits
 *             leave behind instead. node-pty never closes the pseudoconsole
 *             after a natural exit (microsoft/node-pty#965), so each round
 *             leaves a console host in the worker.
 *   pid       one cmd.exe; logs `pty.pid` at the return of spawn(), the first
 *             time it reads non-zero, at first output, and at exit.
 *
 * Measured 2026-10-12 on Windows 11 build 26200, Electron 44.5.1, 16 children:
 *   1.1.0          kill      3 of 3 workers died (0xC0000005) after 0, 20 and 5 rounds
 *   1.2.0-beta.15  kill      3 of 3 workers survived 500 rounds each
 *   1.1.0          natural   3 of 3 workers died (0xC0000005) after 1, 2 and 1 rounds
 *   1.2.0-beta.15  natural   3 of 3 workers survived 200 rounds each
 *   1.2.0-beta.15  churn      survived 1500 rounds (one console host left per round)
 *   1.1.0          churn      --no-release, 100 rounds: rss 36 MB to 688 MB
 *   1.2.0-beta.15  churn      --no-release, 100 rounds: rss 36 MB to 690 MB; with the kill, 62 MB
 *   1.1.0          pid       the real pid at the return of spawn()
 *   1.2.0-beta.15  pid       0 at the return, set at 155 ms, first output at 196 ms
 *                            (the pty host waits for it: src/main/pty/host/root-pid-gate.ts)
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const MODES = ['kill', 'natural', 'churn', 'pid'];
const ROUND_TIMEOUT_MS = 30000;
const ACCESS_VIOLATION = 3221225477;

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function positiveInteger(name, fallback) {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

if (process.platform !== 'win32') throw new Error('This probe measures ConPTY behaviour and runs on Windows only.');
const nodePtyDir = argument('node-pty');
if (!nodePtyDir || !fs.existsSync(path.join(nodePtyDir, 'package.json'))) {
  throw new Error('--node-pty must name an extracted node-pty package root (the folder holding its package.json).');
}
const mode = argument('mode', 'kill');
if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
const children = positiveInteger('children', 16);
const rounds = positiveInteger('rounds', 500);
const attempts = positiveInteger('attempts', 1);
const settleMs = Number(argument('settle-ms', '1500'));
if (!Number.isInteger(settleMs) || settleMs < 0) throw new Error('--settle-ms must be a whole number of milliseconds');
const releaseAfterExit = !process.argv.includes('--no-release');

function loadNodePty() {
  const pty = require(path.resolve(nodePtyDir));
  const { WindowsPtyAgent } = require(path.join(path.resolve(nodePtyDir), 'lib', 'windowsPtyAgent'));
  // The app's patch (src/main/pty/spawn/conpty-console-list.ts), so a kill does
  // not fork a console-list helper per PTY.
  WindowsPtyAgent.prototype._getConsoleProcessList = function consoleList() {
    return Promise.resolve(this._exitCode === undefined && this._innerPid > 0 ? [this._innerPid] : []);
  };
  return pty;
}

function spawnOptions() {
  return { name: 'xterm-256color', cols: 80, rows: 24, cwd: os.tmpdir(), env: process.env };
}

/** Resolves with the elapsed time when `predicate` first holds, polling each millisecond. */
function waitFor(predicate, startedAt) {
  return new Promise((resolve) => {
    const check = () => {
      if (predicate()) resolve(Date.now() - startedAt);
      else setTimeout(check, 1);
    };
    check();
  });
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ROUND_TIMEOUT_MS} ms`)), ROUND_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function killRound(pty) {
  const terminals = [];
  const firstOutput = [];
  const exits = [];
  for (let index = 0; index < children; index += 1) {
    const terminal = pty.spawn('cmd.exe', ['/d', '/k'], spawnOptions());
    terminals.push(terminal);
    firstOutput.push(new Promise((resolve) => {
      const listener = terminal.onData(() => {
        listener.dispose();
        resolve();
      });
    }));
    exits.push(new Promise((resolve) => terminal.onExit(resolve)));
  }
  await withTimeout(Promise.all(firstOutput), 'first output from every child');
  for (const terminal of terminals) terminal.kill();
  await withTimeout(Promise.all(exits), 'every exit');
}

async function naturalRound(pty) {
  // Each child is node.exe from PATH: it prints once, sleeps (no CPU) to just
  // short of the shared deadline, then spins the last two milliseconds so they
  // all leave together. Both halves of that matter. node-pty runs kill() only
  // after a PTY's first output, so a silent child's kill below never runs and
  // its conout worker thread is never ended. And this runtime cannot be the
  // child: electron.exe is a GUI program, so even as Node its output never
  // reaches the pseudoconsole. Measured with Electron children: a thread and
  // about 13 MB per child, and a 1.2.0-beta.15 worker died in round 40 of 16
  // children, every time. 1.1.0 leaked the same way at one child a round.
  const deadline = Date.now() + settleMs + children * 60;
  const script = `process.stdout.write('.');const deadline=${deadline};const remaining=deadline-Date.now()-2;`
    + 'if(remaining>0)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,remaining);'
    + 'while(Date.now()<deadline){}';
  const terminals = [];
  const exits = [];
  for (let index = 0; index < children; index += 1) {
    const terminal = pty.spawn('node.exe', ['-e', script], spawnOptions());
    terminals.push(terminal);
    exits.push(new Promise((resolve) => terminal.onExit(resolve)));
  }
  await withTimeout(Promise.all(exits), 'every exit');
  // node-pty ends a PTY's conout worker thread only in kill(), not after a
  // natural exit, so without this every round would leave its threads running.
  // Every exit thread has finished by now, so these kills race nothing.
  for (const terminal of terminals) terminal.kill();
}

async function churnRound(pty) {
  // One PTY at a time, so no two exits ever race: whatever this runs into is
  // what natural exits leave behind, not the handle-list crash.
  const terminal = pty.spawn('cmd.exe', ['/d', '/c', 'exit 0'], spawnOptions());
  await withTimeout(new Promise((resolve) => terminal.onExit(resolve)), 'the exit');
  if (releaseAfterExit) terminal.kill();
}

async function pidProbe(pty) {
  const startedAt = Date.now();
  const terminal = pty.spawn('cmd.exe', ['/d', '/c', 'echo probe'], spawnOptions());
  const atReturn = terminal.pid;
  const firstNonZero = waitFor(() => terminal.pid > 0, startedAt);
  let pidAtFirstOutput = null;
  let firstOutputMs = null;
  const listener = terminal.onData(() => {
    if (firstOutputMs !== null) return;
    firstOutputMs = Date.now() - startedAt;
    pidAtFirstOutput = terminal.pid;
    listener.dispose();
  });
  const exit = await withTimeout(new Promise((resolve) => terminal.onExit(resolve)), 'the exit');
  terminal.kill();
  const result = {
    pidAtSpawnReturn: atReturn,
    firstNonZeroPidMs: await Promise.race([firstNonZero, Promise.resolve(null)]),
    firstOutputMs,
    pidAtFirstOutput,
    pidAtExit: terminal.pid,
    exitCode: exit.exitCode,
  };
  console.log(JSON.stringify(result));
}

async function runWorker() {
  const pty = loadNodePty();
  if (mode === 'pid') {
    await pidProbe(pty);
    return;
  }
  const rssBeforeMb = Math.round(process.memoryUsage().rss / 1048576);
  for (let round = 1; round <= rounds; round += 1) {
    if (mode === 'kill') await killRound(pty);
    else if (mode === 'churn') await churnRound(pty);
    else await naturalRound(pty);
    console.log(`round ${round} ok`);
  }
  // A released conout worker ends a second after its kill; give it two.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log(`memory: rss ${rssBeforeMb} MB before the first round, ${Math.round(process.memoryUsage().rss / 1048576)} MB after the last${releaseAfterExit ? '' : ' (no kill after a natural exit)'}`);
}

function runAttempt(attempt) {
  return new Promise((resolve) => {
    const workerArguments = [__filename, '--worker', '--node-pty', nodePtyDir, '--mode', mode,
      '--children', String(children), '--rounds', String(rounds), '--settle-ms', String(settleMs)];
    if (!releaseAfterExit) workerArguments.push('--no-release');
    const worker = spawn(process.execPath, workerArguments, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    let roundsSurvived = 0;
    readline.createInterface({ input: worker.stdout }).on('line', (line) => {
      if (/^round \d+ ok$/.test(line)) {
        roundsSurvived += 1;
        if (roundsSurvived % 100 === 0) console.log(`[attempt ${attempt}] ${roundsSurvived} rounds so far`);
      } else {
        console.log(line);
      }
    });
    worker.on('exit', (code, signal) => {
      const hex = code === null ? 'none' : `0x${(code >>> 0).toString(16).toUpperCase()}`;
      const verdict = code === 0
        ? `survived all ${roundsSurvived} rounds`
        : `died after ${roundsSurvived} completed round(s), exit ${code} (${hex})${code === ACCESS_VIOLATION ? ' ACCESS VIOLATION' : ''}${signal ? ` signal ${signal}` : ''}`;
      console.log(`[attempt ${attempt}] ${mode} x${children}: ${verdict}`);
      resolve({ code, roundsSurvived });
    });
  });
}

async function runParent() {
  const version = JSON.parse(fs.readFileSync(path.join(nodePtyDir, 'package.json'), 'utf8')).version;
  console.log(`node-pty ${version}, mode ${mode}, ${children} children, ${rounds} rounds, ${attempts} attempt(s), runtime ${process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.version}`}`);
  const results = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) results.push(await runAttempt(attempt));
  const crashed = results.filter((result) => result.code !== 0);
  console.log(`summary: ${crashed.length} of ${results.length} attempt(s) died; rounds completed before each death: ${crashed.map((result) => result.roundsSurvived).join(', ') || 'none'}`);
  // Non-zero when any worker died, so a wrapper can tell a crash from a pass.
  return crashed.length > 0 ? 1 : 0;
}

const entry = process.argv.includes('--worker') ? runWorker : runParent;
// Exit explicitly. A PTY's conout worker thread can outlive its last kill by a
// second, and the verdict is already printed.
entry().then((exitCode = 0) => process.exit(exitCode), (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
