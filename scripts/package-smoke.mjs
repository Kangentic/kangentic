#!/usr/bin/env node
/**
 * Package smoke: launch the app `npm run package` left in `out/`, isolated in a
 * scratch directory, and prove the processes a packaged build forks still run.
 *
 * Every test tier starts the app from the repo (`_electron.launch()` against
 * `.vite/build`), so none of them runs what users install: the asar, the
 * unpacked tree the pty host and the retrieval worker fork from, the flipped
 * fuses, and on macOS the host forked from inside the asar. The afterPack gates
 * load each native module once under the packaged binary, before the fuses
 * flip; this runs the finished app. `.github/workflows/package-smoke.yml` runs
 * it on Windows, macOS and Linux.
 *
 * Over the Chrome DevTools protocol (`--remote-debugging-port`, a Chromium
 * switch the fuses leave alone) it:
 *   1. opens a one-commit git repository as a project;
 *   2. spawns a terminal that runs `echo`, and reads the echoed marker back
 *      from its scrollback (the PTY lives in the pty host);
 *   3. reads the Knowledge Graph snapshot, which only the retrieval worker can
 *      answer (the call rejects, with no fallback to main, when it cannot);
 *   4. creates a To Do task, runs a terminal for it that leaves a detached node
 *      process in the project (as an agent's dev server would), deletes the
 *      task, and requires that process to be stopped: the pty host's task reap
 *      (src/main/pty/process-tag/), which loads koffi on Windows and macOS. The
 *      afterPack probe loads koffi the same way and calls into it once; this
 *      step proves the readers built on it find and stop a real process;
 *   5. quits with the first terminal still running, and requires exit code 0 inside
 *      the bound. On Windows and Linux that is a user's quit (the window
 *      closes), which runs the PTY exit drain; on macOS it is SIGTERM, which
 *      runs the synchronous shutdown but not the drain (see `quitRouteFor`).
 * Then it reads the app's persisted logs and fails on any line that says a
 * forked process crashed or fell back: the pty host falls back to running
 * terminals in main after repeated crashes, which would pass step 2 with a
 * dead host.
 *
 * Usage: node scripts/package-smoke.mjs [--out <dir>] [--scratch-root <dir>]
 * The scratch directory is deleted on success and kept (its path printed) on
 * failure, for the workflow to upload.
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the terminal prints. */
export const SMOKE_MARKER = 'KANGENTIC_SMOKE_OK';
/**
 * What is typed. The quotes split the marker and the shell joins it again
 * (bash, zsh, fish and PowerShell alike), so the marker in the scrollback is
 * the command's output, never the terminal echoing what was typed.
 */
export const SMOKE_COMMAND = 'echo KANGENTIC_SMOKE"_"OK';

/**
 * What the task's terminal runs for step 4: a script that starts a detached
 * node process and exits at once, a fast detach like `nohup npm run dev &`.
 * The process inherits the terminal's `KANGENTIC_TASK_ID` and works in the
 * project, so the reap must stop it when the task is deleted. `node` is the
 * runner's own, which every shell finds on PATH.
 */
export const LEFTOVER_SCRIPT_NAME = 'leftover.js';
export const LEFTOVER_PID_FILE = 'leftover.pid';
export const LEFTOVER_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  "const leftover = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });",
  'leftover.unref();',
  `fs.writeFileSync(${JSON.stringify(LEFTOVER_PID_FILE)}, String(leftover.pid));`,
].join('\n');
export const LEFTOVER_COMMAND = `node ${LEFTOVER_SCRIPT_NAME}`;

/**
 * Log lines that mean a forked process failed. Each names the source text it
 * matches, and `tests/unit/package-smoke.test.ts` fails when that text leaves
 * `src/main`, so a reworded log line cannot quietly switch a check off.
 */
export const FAILURE_MARKERS = [
  {
    // Every cause (an exit, a fork that threw, a worker that hung) ends in the same suffix.
    pattern: /\[utility-process\] .+ \(crash \d+ of \d+\)/,
    sourceText: '(crash ${crashNumber} of ${this.maxCrashes})',
    reason: 'a utility process (pty host, retrieval worker, or another) crashed',
  },
  { pattern: /\[pty-host\] exited unexpectedly/, sourceText: '[pty-host] exited unexpectedly', reason: 'the pty host crashed' },
  { pattern: /\[pty-host\] fork failed/, sourceText: '[pty-host] fork failed', reason: 'the pty host did not fork' },
  {
    pattern: /\[pty-host\] gave up restarting/,
    sourceText: '[pty-host] gave up restarting',
    reason: 'the pty host gave up and terminals ran in main',
  },
  { pattern: /retrieval worker fork failed/, sourceText: 'retrieval worker fork failed', reason: 'the retrieval worker did not fork' },
  { pattern: /sqlite-vec unavailable/, sourceText: 'sqlite-vec unavailable', reason: 'the retrieval worker could not load sqlite-vec' },
  { pattern: /\[SHUTDOWN\] hard-failsafe:fired/, sourceText: '[SHUTDOWN] hard-failsafe:fired', reason: 'the quit hung until the hard failsafe killed it' },
  {
    pattern: /\[TASK-REAP\] reap failed/,
    sourceText: '[TASK-REAP] reap failed (non-fatal): ',
    reason: 'the task reap failed (a reader that would not load, or a scan that listed nothing)',
  },
  { pattern: /\[TASK-REAP\] host reap failed/, sourceText: '[TASK-REAP] host reap failed (non-fatal):', reason: 'the pty host did not answer the task reap' },
  {
    pattern: /\[PTY-HOST\] Toolhelp process listing failed/,
    sourceText: '[PTY-HOST] Toolhelp process listing failed',
    reason: "the background-shell watcher's Toolhelp listing failed and fell back to PowerShell",
  },
];

const PHASE_TIMEOUTS_MS = {
  bridge: 120_000,
  project: 30_000,
  terminal: 45_000,
  graph: 60_000,
  reap: 45_000,
  quit: 30_000,
};
const OVERALL_TIMEOUT_MS = 6 * 60_000;
const POLL_MS = 500;

/**
 * The packaged executable under `outDir` for this platform, from package.json's
 * `name` (the Linux executable) and `productName` (Windows and macOS). Throws
 * when there is none, or more than one, rather than guessing.
 */
export function resolveAppExecutable(outDir, platform, packageJson, fileSystem = fs) {
  const { name, productName } = packageJson;
  let entries;
  try {
    entries = fileSystem.readdirSync(outDir);
  } catch {
    throw new Error(`No ${outDir} directory. Run \`npm run package\` first.`);
  }
  const candidates = [];
  for (const entry of entries) {
    let candidate = null;
    if (platform === 'win32' && /^win(-[a-z0-9]+)?-unpacked$/.test(entry)) {
      candidate = path.join(outDir, entry, `${productName}.exe`);
    } else if (platform === 'linux' && /^linux(-[a-z0-9]+)?-unpacked$/.test(entry)) {
      candidate = path.join(outDir, entry, name);
    } else if (platform === 'darwin' && /^mac(-[a-z0-9]+)?$/.test(entry)) {
      candidate = path.join(outDir, entry, `${productName}.app`, 'Contents', 'MacOS', productName);
    }
    if (candidate && fileSystem.existsSync(candidate)) candidates.push(candidate);
  }
  if (candidates.length === 0) {
    throw new Error(`No packaged ${platform} app in ${outDir} (found: ${entries.join(', ') || 'nothing'}). Run \`npm run package\` first.`);
  }
  if (candidates.length > 1) {
    throw new Error(`More than one packaged ${platform} app in ${outDir}: ${candidates.join(', ')}. Remove the stale one.`);
  }
  return candidates[0];
}

/** How the app is quit: closing its window on Windows and Linux, which is
 *  what a user does and what runs the PTY exit drain. macOS keeps an app
 *  running with no window, so there it gets SIGTERM. Its signal handler runs
 *  the synchronous shutdown and exits 0 itself, without the drain or a wait
 *  for the pty host, so the macOS leg does not cover those. */
export function quitRouteFor(platform) {
  return platform === 'darwin' ? 'sigterm' : 'close-window';
}

/** The app's command line: isolated data and user data, a debugging port,
 *  and on Linux no Chromium sandbox (a CI runner has none to give it). */
export function launchArguments(platform, dataDir, userDataDir, port) {
  const args = [`--data-dir=${dataDir}`, `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`];
  if (platform === 'linux') args.push('--no-sandbox');
  return args;
}

/** The app's environment. `KANGENTIC_DATA_DIR` would win over `--data-dir`,
 *  `NODE_ENV=test` bypasses the single-instance lock the real app takes, and
 *  `ELECTRON_RUN_AS_NODE` would start Node instead of the app. */
export function appEnvironment(source) {
  const environment = { ...source };
  delete environment.KANGENTIC_DATA_DIR;
  delete environment.NODE_ENV;
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.KANGENTIC_TELEMETRY = '0';
  return environment;
}

/** Terminal output as text: control sequences and OSC strings removed. */
export function stripTerminalControls(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

/** The lines that carry a failure marker, each with its reason. */
export function findFailureMarkers(lines) {
  const found = [];
  for (const line of lines) {
    for (const marker of FAILURE_MARKERS) {
      if (marker.pattern.test(line)) found.push({ line, reason: marker.reason });
    }
  }
  return found;
}

/** Every line of every `*.log` file in the directories that exist. */
function readLogLines(directories) {
  const lines = [];
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    for (const file of fs.readdirSync(directory).filter((entry) => entry.endsWith('.log')).sort()) {
      for (const line of fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/)) {
        if (line.trim()) lines.push(line);
      }
    }
  }
  return lines;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Poll `probe` until it returns a value other than undefined, or throw with
 *  the phase's name and the last error once the bound passes. */
async function pollUntil(phase, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const detail = lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : '';
      throw new Error(`${phase} did not finish within ${timeoutMs / 1000} s${detail}`);
    }
    await sleep(POLL_MS);
  }
}

/** One page's Runtime.evaluate over the DevTools websocket. */
class PageSession {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else if (message.result?.exceptionDetails) {
        const details = message.result.exceptionDetails;
        waiter.reject(new Error(details.exception?.description ?? details.text ?? 'evaluation threw'));
      } else waiter.resolve(message.result?.result?.value);
    });
    this.socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('the page closed'));
      this.pending.clear();
    });
  }

  opened() {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error('could not connect to the page')), { once: true });
    });
  }

  evaluate(expression) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  }

  /** Send without waiting for a reply: for a call that closes the page. */
  fire(expression) {
    this.socket.send(JSON.stringify({ id: this.nextId++, method: 'Runtime.evaluate', params: { expression } }));
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

async function pageWebSocketUrl(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl && !String(target.url).startsWith('devtools://'));
  return page?.webSocketDebuggerUrl;
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

/** Whether a pid is running: signal 0, with EPERM (running, not ours to signal) counted as running. */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function makeRepository(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(directory, 'README.md'), 'Package smoke project.\n');
  git('add', '.');
  git('-c', 'user.name=Kangentic Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-q', '-m', 'Initial commit');
}

function parseArguments(argv) {
  const options = { outDir: path.join(REPO_ROOT, 'out'), scratchRoot: os.tmpdir() };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--out') options.outDir = path.resolve(argv[++index]);
    else if (argv[index] === '--scratch-root') options.scratchRoot = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (typeof WebSocket !== 'function') throw new Error(`Node ${process.version} has no global WebSocket; run this on Node 22 or later.`);
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const appPath = resolveAppExecutable(options.outDir, process.platform, packageJson);

  fs.mkdirSync(options.scratchRoot, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(options.scratchRoot, 'kangentic-smoke-'));
  const dataDir = path.join(scratch, 'data');
  const userDataDir = path.join(scratch, 'user-data');
  const repository = path.join(scratch, 'repo');
  const outputPath = path.join(scratch, 'app-output.log');
  fs.mkdirSync(dataDir, { recursive: true });
  // Every console line persisted, not only warnings and errors, so the log
  // check below reads the whole run.
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ developer: { persistConsoleLogs: true } }, null, 2));
  makeRepository(repository);
  // Untracked, like any file an agent writes; the task's terminal runs it.
  fs.writeFileSync(path.join(repository, LEFTOVER_SCRIPT_NAME), `${LEFTOVER_SCRIPT}\n`);

  const startedAt = Date.now();
  const say = (text) => console.log(`[package-smoke] ${((Date.now() - startedAt) / 1000).toFixed(1)}s ${text}`);
  say(`app ${appPath}`);
  say(`scratch ${scratch}`);

  const port = await freePort();
  const output = fs.openSync(outputPath, 'a');
  // Its own process group on POSIX, so the app's failsafe and this script's
  // tree kill reach the app and nothing above it.
  const child = spawn(appPath, launchArguments(process.platform, dataDir, userDataDir, port), {
    env: appEnvironment(process.env),
    stdio: ['ignore', output, output],
    detached: process.platform !== 'win32',
  });
  let exit = null;
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    });
  });
  child.on('error', (error) => say(`launch failed: ${error.message}`));

  const watchdog = setTimeout(() => {
    say(`overall bound of ${OVERALL_TIMEOUT_MS / 1000} s passed; killing the app`);
    killTree(child.pid);
    console.error(`[package-smoke] FAILED. Kept ${scratch}`);
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

  let page = null;
  let leftoverPid = null;
  let leftoverStopped = false;
  const failures = [];
  try {
    const url = await pollUntil('Finding the app window', PHASE_TIMEOUTS_MS.bridge, async () => {
      if (exit) throw new Error(`the app exited (code ${exit.code}, signal ${exit.signal})`);
      return pageWebSocketUrl(port);
    });
    page = new PageSession(url);
    await page.opened();
    await pollUntil('Waiting for the preload bridge', PHASE_TIMEOUTS_MS.bridge, async () => (
      (await page.evaluate('typeof window.electronAPI === "object"')) ? true : undefined
    ));
    say('bridge ready');

    const project = await pollUntil('Opening the project', PHASE_TIMEOUTS_MS.project, () => page.evaluate(
      `window.electronAPI.projects.openByPath(${JSON.stringify(repository)}).then((opened) => ({ id: opened.id }))`,
    ));
    say(`project opened (${project.id})`);

    const session = await page.evaluate(`window.electronAPI.sessions.spawn(${JSON.stringify({
      taskId: randomUUID(),
      projectId: project.id,
      command: SMOKE_COMMAND,
      cwd: repository,
      cols: 120,
      rows: 30,
      transient: true,
    })}, ${JSON.stringify(project.id)}).then((spawned) => ({ id: spawned.id }))`);
    await pollUntil('Reading the terminal output', PHASE_TIMEOUTS_MS.terminal, async () => {
      const scrollback = (await page.evaluate(`window.electronAPI.sessions.getScrollback(${JSON.stringify(session.id)})`)) ?? '';
      return stripTerminalControls(scrollback).includes(SMOKE_MARKER) ? true : undefined;
    });
    say('terminal ran in the pty host and printed the marker');

    const snapshot = await pollUntil('Reading the Knowledge Graph snapshot', PHASE_TIMEOUTS_MS.graph, async () => {
      const read = await page.evaluate(
        `window.electronAPI.knowledgeGraph.graphSnapshot(${JSON.stringify(project.id)}).then((wire) => wire && { projectId: wire.projectId })`,
      );
      return read && read.projectId === project.id ? read : undefined;
    });
    say(`retrieval worker answered the snapshot for ${snapshot.projectId}`);

    const todoLaneId = await page.evaluate("window.electronAPI.swimlanes.list().then((lanes) => lanes.find((lane) => lane.role === 'todo')?.id ?? null)");
    if (!todoLaneId) throw new Error('the board has no To Do column to create the reap task in');
    const task = await page.evaluate(`window.electronAPI.tasks.create(${JSON.stringify({
      title: 'Package smoke reap',
      description: '',
      swimlane_id: todoLaneId,
    })}, ${JSON.stringify(project.id)}).then((created) => ({ id: created.id }))`);
    await page.evaluate(`window.electronAPI.sessions.spawn(${JSON.stringify({
      taskId: task.id,
      projectId: project.id,
      command: LEFTOVER_COMMAND,
      cwd: repository,
      cols: 120,
      rows: 30,
    })}, ${JSON.stringify(project.id)}).then((spawned) => ({ id: spawned.id }))`);
    leftoverPid = await pollUntil("Starting the task's leftover process", PHASE_TIMEOUTS_MS.reap, async () => {
      const pidFile = path.join(repository, LEFTOVER_PID_FILE);
      if (!fs.existsSync(pidFile)) return undefined;
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 && isRunning(pid) ? pid : undefined;
    });
    say(`the task's terminal left process ${leftoverPid} running`);
    await page.evaluate(`window.electronAPI.tasks.delete(${JSON.stringify(task.id)}, ${JSON.stringify(project.id)})`);
    await pollUntil('Stopping the leftover after its task was deleted', PHASE_TIMEOUTS_MS.reap, async () => (
      isRunning(leftoverPid) ? undefined : true
    ));
    leftoverStopped = true;
    say(`deleting the task stopped process ${leftoverPid} (the task reap in the pty host)`);

    const route = quitRouteFor(process.platform);
    if (route === 'close-window') page.fire('window.electronAPI.window.close()');
    else process.kill(child.pid, 'SIGTERM');
    say(`quitting (${route}) with the terminal still running`);
    const result = await Promise.race([exited, sleep(PHASE_TIMEOUTS_MS.quit).then(() => null)]);
    if (!result) failures.push(`the app did not exit within ${PHASE_TIMEOUTS_MS.quit / 1000} s of the quit`);
    else if (result.code !== 0 || result.signal !== null) failures.push(`the app exited with code ${result.code}, signal ${result.signal}`);
    else say('app exited with code 0');
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    page?.close();
    clearTimeout(watchdog);
    if (!exit) killTree(child.pid);
    // A reap that failed leaves the process behind; the runner is not the place for it.
    // Once it was seen gone its pid may name an unrelated process, so leave it alone.
    if (leftoverPid && !leftoverStopped && isRunning(leftoverPid)) {
      try { process.kill(leftoverPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    fs.closeSync(output);
  }

  // Before a project opens the app logs under the data dir, after it under the
  // project's own .kangentic directory.
  const logLines = readLogLines([path.join(dataDir, 'logs'), path.join(repository, '.kangentic', 'logs')]);
  if (logLines.length === 0) failures.push('the app wrote no log lines, so nothing below could be checked');
  for (const marker of findFailureMarkers(logLines)) failures.push(`${marker.reason}: ${marker.line.slice(0, 300)}`);
  say(`read ${logLines.length} log lines`);

  if (failures.length > 0) {
    console.error('[package-smoke] FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    const appOutput = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').split(/\r?\n/) : [];
    console.error(`--- last app output lines (${outputPath}) ---`);
    for (const line of appOutput.slice(-60)) console.error(line);
    console.error('--- last log lines ---');
    for (const line of logLines.slice(-60)) console.error(line.slice(0, 400));
    console.error(`[package-smoke] Kept ${scratch}`);
    process.exitCode = 1;
    return;
  }
  say('PASSED');
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    say(`could not remove ${scratch}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const __testing = {
  SMOKE_MARKER,
  SMOKE_COMMAND,
  LEFTOVER_SCRIPT,
  LEFTOVER_COMMAND,
  FAILURE_MARKERS,
  resolveAppExecutable,
  quitRouteFor,
  launchArguments,
  appEnvironment,
  stripTerminalControls,
  findFailureMarkers,
};

/** Whether this module is the script node was asked to run. Compared by real
 *  path: node resolves the entry module through symlinks, so a checkout under a
 *  link (or a junction or `subst` drive on Windows) never matched by URL, and
 *  the gate imported cleanly, ran nothing, and exited 0. */
function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error(`[package-smoke] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
