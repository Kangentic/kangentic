/**
 * What a .NET Aspire stack does once the task reap has killed its AppHost.
 *
 * The reap's plan for an Aspire stack targets the CLI and the AppHost and keeps
 * the DCP root, because the dashboard under it carries the task's tag and works
 * in the package cache (see "What the reap kills" in
 * docs/architecture/worktrees/process-reaping.md). Whether that strands the
 * stack depends on DCP: it starts with `--monitor <AppHost pid>` and should clean
 * up after its host. This is the measurement of that, and it prints what it saw
 * rather than deciding it. It runs a real `aspire run`, reaps through the real
 * reader and `reapTaggedOnce`, then follows the pre-kill scan by identity.
 *
 * It asserts only that the run proved something: the plan has to reproduce the
 * measured shape, or the survivors it reports mean nothing.
 *
 * The second case opens the dashboard in a browser. The dashboard dials the
 * AppHost's resource service only once a page subscribes (`EnsureInitialized`),
 * and a process the plan spared counts as connection evidence, so that pair
 * could spare the AppHost itself.
 *
 * NEVER RUN THIS ON A DEVELOPER'S MACHINE. DCP 0.26.5's `stop-process-tree`
 * follows recorded parent pids without comparing start times, so a teardown can
 * end a stranger's tree (see "Parent pids Windows reuses" in the same doc).
 * That is why it needs both `CI` and `KANGENTIC_ASPIRE_PROBE=1`. The
 * `task-reap-real-processes.yml` workflow runs it on `workflow_dispatch` alone.
 * A job that dies mid-run is an inconclusive run, not a result.
 */

import { describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createTaggedProcessReader } from '../../src/main/pty/process-tag/reader-factory';
import {
  connectionQueryOf,
  planReapDetailed,
  processIdentity,
  type ReapPlan,
  type ReapPlanInput,
} from '../../src/main/pty/process-tag/reap-plan';
import { reapTaggedOnce } from '../../src/main/pty/process-tag/tagged-reap';
import { resolveTaskDirectories } from '../../src/main/pty/process-tag/task-directories';
import { TASK_PROCESS_TAG_ENV } from '../../src/main/pty/process-tag/task-process-tag';
import { listWin32Processes } from '../../src/main/pty/process-tag/win32-reader';
import type { LocalConnectionRead, ProcessScan, ScannedProcess, TaggedProcessReader } from '../../src/main/pty/process-tag/process-scan';

const execFileAsync = promisify(execFile);

const FIXTURE_DIRECTORY = path.resolve(__dirname, '..', 'fixtures', 'aspire-minimal');
const PROJECT_FILE = 'MinimalStack.AppHost.csproj';
const BUILD_TIMEOUT_MS = 300_000;
const START_TIMEOUT_MS = 180_000;
const DASHBOARD_DIAL_TIMEOUT_MS = 45_000;
/** Past DCP's 120 s cleanup budget (`DCP_SHUTDOWN_TIMEOUT_SECONDS`), so a slow cleanup is not read as a failed one. */
const WATCH_MS = 130_000;
const CHECKPOINTS_MS = [5_000, 60_000, WATCH_MS];
const SAMPLE_INTERVAL_MS = 500;
/** How long nothing of the stack may run before the watch ends early. */
const QUIET_MS = 10_000;
const CASE_TIMEOUT_MS = BUILD_TIMEOUT_MS + START_TIMEOUT_MS + DASHBOARD_DIAL_TIMEOUT_MS + WATCH_MS + 60_000;
/** DCP's own account of a shutdown, from `DCP_DIAGNOSTICS_LOG_FOLDER`. */
const DCP_LOG_PATTERN = /Monitor process exited|Shutting down|Cleaning up a resource|cleaned up|Could not clean up|Shutdown complete|Stopping process tree/;
const DCP_LOG_LINE_LIMIT = 80;

const CI_RUNNER = process.env.CI === 'true' && process.env.KANGENTIC_ASPIRE_PROBE === '1';

function log(line: string): void {
  console.log(`[aspire-probe] ${line}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

interface Stack {
  root: string;
  project: string;
  worktree: string;
  appHostDirectory: string;
  taskId: string;
  directories: string[];
  environment: NodeJS.ProcessEnv;
}

async function makeStack(): Promise<Stack> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kng-aspire-')));
  const project = path.join(root, 'project');
  const worktree = path.join(project, '.kangentic', 'worktrees', 'task-8');
  const appHostDirectory = path.join(worktree, 'apphost');
  fs.mkdirSync(worktree, { recursive: true });
  fs.cpSync(FIXTURE_DIRECTORY, appHostDirectory, { recursive: true });
  const taskId = randomUUID();
  return {
    root,
    project,
    worktree,
    appHostDirectory,
    taskId,
    directories: await resolveTaskDirectories(project, worktree),
    environment: {
      ...process.env,
      DCP_DIAGNOSTICS_LOG_LEVEL: 'debug',
      DCP_DIAGNOSTICS_LOG_FOLDER: path.join(root, 'dcp-logs'),
    },
  };
}

/** Built with no tag: a tagged build leaves tagged compiler and MSBuild servers no measured stack had. */
async function buildAppHost(stack: Stack): Promise<void> {
  const environment = { ...stack.environment };
  delete environment[TASK_PROCESS_TAG_ENV];
  await execFileAsync('dotnet', ['build', PROJECT_FILE], { cwd: stack.appHostDirectory, env: environment, windowsHide: true, timeout: BUILD_TIMEOUT_MS });
}

interface DetachOutput {
  appHostPid: number;
  cliPid: number;
  dashboardUrl?: string | null;
}

/**
 * `aspire run --detach`: its launcher exits, so nothing links the stack to this
 * test by parent. Through `cmd`, because the installed tool is not a plain `.exe`
 * on PATH and Node's spawn tries no other extension (ENOENT on windows-latest).
 */
async function startStack(stack: Stack): Promise<DetachOutput> {
  const { stdout } = await execFileAsync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/c', 'aspire', 'run', '--detach', '--isolated', '--no-build', '--format', 'Json', '--non-interactive', '--apphost', PROJECT_FILE],
    { cwd: stack.appHostDirectory, env: { ...stack.environment, [TASK_PROCESS_TAG_ENV]: stack.taskId }, windowsHide: true, timeout: START_TIMEOUT_MS },
  );
  log(`detach output: ${stdout.trim()}`);
  const output = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)) as DetachOutput;
  expect(output.appHostPid).toBeGreaterThan(0);
  return output;
}

function planInput(stack: Stack, scan: ProcessScan): ReapPlanInput {
  return {
    processes: scan.processes,
    tasks: new Map([[stack.taskId, { directories: stack.directories, worktreePath: stack.worktree }]]),
    mainPid: process.pid,
    liveRootPids: [],
    caseInsensitivePaths: true,
  };
}

interface Reading {
  scan: ProcessScan;
  images: Map<number, string>;
  connections: LocalConnectionRead;
  plan: ReapPlan;
}

/** One scan, its connections and its plan, exactly as a reap reads them. Signals nothing. */
async function read(reader: TaggedProcessReader, stack: Stack): Promise<Reading> {
  const scan = await reader.scan();
  const rows = await listWin32Processes();
  const input = planInput(stack, scan);
  const query = connectionQueryOf(input);
  const connections = query.listeners.length > 0 && reader.connections
    ? await reader.connections(query.listeners, query.clients)
    : { pairs: [], listeningPids: [] };
  return {
    scan,
    images: new Map(rows.map((row) => [row.pid, row.image])),
    connections,
    plan: planReapDetailed({ ...input, connections }),
  };
}

const isStackProcess = (stack: Stack) => (scanned: ScannedProcess): boolean => scanned.tagValue === stack.taskId;

function imageOf(reading: Pick<Reading, 'images'>, pid: number): string {
  return (reading.images.get(pid) ?? '?').toLowerCase();
}

async function waitForStack(reader: TaggedProcessReader, stack: Stack): Promise<Reading> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const reading = await read(reader, stack);
    const stackImages = reading.scan.processes.filter(isStackProcess(stack)).map((scanned) => imageOf(reading, scanned.pid));
    if (stackImages.some((image) => image === 'ping.exe') && stackImages.some((image) => image.includes('dashboard'))) {
      // The resources are up. Let the monitors and the connections settle, so
      // the scan reads a running stack and not one still starting.
      await delay(5_000);
      return read(reader, stack);
    }
    await delay(1_000);
  }
  throw new Error('the worker and the dashboard never appeared in the scan');
}

function describeTag(stack: Stack, scanned: ScannedProcess): string {
  if (scanned.tagValue === stack.taskId) return 'own';
  if (scanned.tagValue === '') return 'cleared';
  if (scanned.tagValue !== null) return 'other';
  return scanned.environmentUnreadable ? 'unreadable' : 'none';
}

function placeOf(stack: Stack, directory: string | null | undefined): string {
  if (!directory) return '(unknown)';
  const home = os.homedir();
  const lowered = directory.toLowerCase();
  if (lowered.startsWith(stack.project.toLowerCase())) return `<project>${directory.slice(stack.project.length)}`;
  if (lowered.startsWith(home.toLowerCase())) return `<home>${directory.slice(home.length)}`;
  return directory;
}

function verdictOf(plan: ReapPlan, scanned: ScannedProcess): string {
  if (plan.targets.some((target) => target.pid === scanned.pid)) return 'KILL';
  const kept = plan.kept.find((entry) => entry.process.pid === scanned.pid);
  if (kept) return `KEPT(${kept.reason}/${kept.because.basis}/${kept.because.evidencePid})`;
  return plan.keptIdentities.has(processIdentity(scanned)) ? 'SPARED' : '-';
}

/** Every process of the stack, in start order, with what the fixture needs: the parent links the attachment lacks. */
function printStack(stack: Stack, reading: Reading): void {
  const stackProcesses = reading.scan.processes
    .filter(isStackProcess(stack))
    .sort((left, right) => (left.startedAtMs ?? 0) - (right.startedAtMs ?? 0));
  stackProcesses.forEach((scanned, order) => {
    log(`row ${JSON.stringify({
      order,
      pid: scanned.pid,
      ppid: scanned.ppid,
      parentListed: reading.scan.processes.some((candidate) => candidate.pid === scanned.ppid),
      image: reading.images.get(scanned.pid) ?? '?',
      role: scanned.role ?? null,
      tag: describeTag(stack, scanned),
      directory: placeOf(stack, scanned.workingDirectory),
      verdict: verdictOf(reading.plan, scanned),
    })}`);
  });
  for (const pair of reading.connections.pairs) {
    log(`pair client ${pair.clientPid} ${imageOf(reading, pair.clientPid)} -> listener ${pair.listenerPid} ${imageOf(reading, pair.listenerPid)}`);
  }
  log(`listeners ${reading.connections.listeningPids.map((pid) => `${pid}:${imageOf(reading, pid)}`).join(', ')}`);
  log(`plan targets=${reading.plan.targets.length} roots=${reading.plan.roots.length} kept=${reading.plan.kept.length} keptIdentities=${reading.plan.keptIdentities.size} stack=${stackProcesses.length}`);
  for (const kept of reading.plan.kept) {
    const evidence = kept.because.evidencePid === null ? 'none' : imageOf(reading, kept.because.evidencePid);
    log(`kept ${kept.process.pid} ${imageOf(reading, kept.process.pid)} reason=${kept.reason} basis=${kept.because.basis} evidence=${evidence}`);
  }
}

/** Open the dashboard in a real browser, and wait for it to dial the AppHost. The browser carries no tag. */
async function openDashboard(reader: TaggedProcessReader, stack: Stack, dashboardUrl: string, appHostPid: number): Promise<{ browser: ChildProcess; dialed: boolean }> {
  const candidates = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]
    .filter((directory): directory is string => Boolean(directory))
    .map((directory) => path.join(directory, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  const chrome = candidates.find((candidate) => fs.existsSync(candidate));
  if (!chrome) throw new Error(`no Chrome at ${candidates.join(' or ')}`);
  const environment = { ...stack.environment };
  delete environment[TASK_PROCESS_TAG_ENV];
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(stack.root, 'chrome')}`, dashboardUrl], { stdio: 'ignore', env: environment });
  const deadline = Date.now() + DASHBOARD_DIAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const reading = await read(reader, stack);
    if (reading.connections.pairs.some((pair) => pair.listenerPid === appHostPid)) return { browser, dialed: true };
    await delay(1_000);
  }
  return { browser, dialed: false };
}

interface Watched {
  scanned: ScannedProcess;
  image: string;
  /** Ms after the reap ended that it was first gone, or null while it runs. */
  goneAfterMs: number | null;
}

/** Follow the pre-kill scan by identity, and anything tagged that starts afterwards. */
async function watchStack(reader: TaggedProcessReader, stack: Stack, baseline: Reading): Promise<Map<string, Watched>> {
  const watched = new Map<string, Watched>(baseline.scan.processes.filter(isStackProcess(stack)).map((scanned) => [
    processIdentity(scanned),
    { scanned, image: baseline.images.get(scanned.pid) ?? '?', goneAfterMs: null },
  ]));
  const startedAt = Date.now();
  const checkpoints = [...CHECKPOINTS_MS];
  let quietSince: number | null = null;
  const report = (atMs: number): void => {
    const survivors = [...watched.values()].filter((entry) => entry.goneAfterMs === null);
    log(`at ${Math.round(atMs / 1000)} s: ${survivors.length} of ${watched.size} still running${survivors.length > 0 ? `: ${survivors.map((entry) => `${entry.scanned.pid}:${entry.image}`).join(', ')}` : ''}`);
  };
  while (Date.now() - startedAt < WATCH_MS) {
    const elapsedMs = Date.now() - startedAt;
    const scan = await reader.scan();
    const rows = await listWin32Processes();
    const running = new Map(scan.processes.filter((scanned) => !scanned.exited).map((scanned) => [processIdentity(scanned), scanned]));
    for (const [identity, entry] of watched) {
      if (entry.goneAfterMs === null && !running.has(identity)) {
        entry.goneAfterMs = elapsedMs;
        log(`gone at ${elapsedMs} ms: ${entry.scanned.pid} ${entry.image} (${placeOf(stack, entry.scanned.workingDirectory)})`);
      }
    }
    for (const [identity, scanned] of running) {
      if (scanned.tagValue !== stack.taskId || watched.has(identity)) continue;
      const image = rows.find((row) => row.pid === scanned.pid)?.image ?? '?';
      watched.set(identity, { scanned, image, goneAfterMs: null });
      log(`appeared at ${elapsedMs} ms: ${scanned.pid} ${image} ppid ${scanned.ppid} (${placeOf(stack, scanned.workingDirectory)})`);
    }
    while (checkpoints.length > 0 && elapsedMs >= checkpoints[0]) report(checkpoints.shift() as number);
    const anyRunning = [...watched.values()].some((entry) => entry.goneAfterMs === null);
    if (anyRunning) {
      quietSince = null;
    } else {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= QUIET_MS) {
        log(`nothing of the stack ran for ${QUIET_MS} ms, so the later checkpoints read 0`);
        return watched;
      }
    }
    await delay(SAMPLE_INTERVAL_MS);
  }
  for (const atMs of checkpoints) report(atMs);
  return watched;
}

function summarize(stack: Stack, watched: Map<string, Watched>): void {
  const entries = [...watched.values()];
  const insideProject = entries.filter((entry) => entry.scanned.workingDirectory?.toLowerCase().startsWith(stack.project.toLowerCase()));
  const lastGone = (list: Watched[]): number | null => (list.some((entry) => entry.goneAfterMs === null) ? null : Math.max(0, ...list.map((entry) => entry.goneAfterMs ?? 0)));
  const dcpRoots = entries.filter((entry) => entry.image.toLowerCase() === 'dcp.exe');
  log(`summary ${JSON.stringify({
    processes: entries.length,
    survivors: entries.filter((entry) => entry.goneAfterMs === null).length,
    lastGoneMs: lastGone(entries),
    lastInsideProjectGoneMs: lastGone(insideProject),
    lastDcpGoneMs: lastGone(dcpRoots),
  })}`);
}

function logFilesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? logFilesUnder(entryPath) : [entryPath];
  });
}

function printDcpLog(stack: Stack): void {
  const logFiles = logFilesUnder(path.join(stack.root, 'dcp-logs'));
  log(`dcp log files: ${logFiles.length}`);
  let printed = 0;
  for (const logFile of logFiles) {
    for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
      if (printed >= DCP_LOG_LINE_LIMIT || !DCP_LOG_PATTERN.test(line)) continue;
      log(`dcp ${path.basename(logFile)}: ${line.slice(0, 240)}`);
      printed += 1;
    }
  }
}

/** Ends what is left, for the next case on this runner. Only processes this run started, by identity. */
async function endSurvivors(reader: TaggedProcessReader, watched: Map<string, Watched>): Promise<void> {
  for (const entry of watched.values()) {
    if (entry.goneAfterMs !== null) continue;
    try { await reader.kill(entry.scanned, 'force'); } catch { /* it ended on its own */ }
  }
}

async function measure(reader: TaggedProcessReader, withBrowser: boolean): Promise<{ baseline: Reading; appHostPid: number; dialed: boolean | null }> {
  const stack = await makeStack();
  let browser: ChildProcess | null = null;
  try {
    await buildAppHost(stack);
    const started = await startStack(stack);
    let baseline = await waitForStack(reader, stack);
    let dialed: boolean | null = null;
    if (withBrowser) {
      if (!started.dashboardUrl) throw new Error('aspire run reported no dashboard URL');
      const opened = await openDashboard(reader, stack, started.dashboardUrl, started.appHostPid);
      browser = opened.browser;
      dialed = opened.dialed;
      log(`the dashboard ${dialed ? 'dialed' : 'never dialed'} the AppHost within ${DASHBOARD_DIAL_TIMEOUT_MS} ms`);
      baseline = await read(reader, stack);
    }
    printStack(stack, baseline);
    const reaped = await reapTaggedOnce(
      { tasks: [{ taskId: stack.taskId, directories: stack.directories, worktreePath: stack.worktree }], mainPid: process.pid, stop: true },
      { reader, liveRootPids: () => [] },
    );
    log(`reap killed=${reaped.killedPids.length} failure=${reaped.failureCode} entries=${JSON.stringify(reaped.entries.map((entry) => ({ pid: entry.pid, label: entry.label, outcome: entry.outcome, reason: entry.reason, basis: entry.because?.basis ?? null })))}`);
    const watched = await watchStack(reader, stack, baseline);
    summarize(stack, watched);
    printDcpLog(stack);
    await endSurvivors(reader, watched);
    return { baseline, appHostPid: started.appHostPid, dialed };
  } finally {
    browser?.kill();
    try { fs.rmSync(stack.root, { recursive: true, force: true }); } catch { /* a survivor may hold it */ }
  }
}

describe.runIf(process.platform === 'win32' && CI_RUNNER)('what a killed AppHost leaves running (real Aspire stack)', () => {
  const reader = createTaggedProcessReader();

  it('dashboard idle: the plan reproduces the measured shape, and the watch prints what is left', async () => {
    const { baseline, appHostPid } = await measure(reader as TaggedProcessReader, false);
    const targetImages = baseline.plan.targets.map((target) => imageOf(baseline, target.pid));
    expect(targetImages).toContain('aspire.exe');
    expect(baseline.plan.targets.map((target) => target.pid)).toContain(appHostPid);
    expect(baseline.plan.targets).toHaveLength(2);
    const [keptRoot] = baseline.plan.kept;
    expect(imageOf(baseline, keptRoot.process.pid)).toBe('dcp.exe');
    expect(keptRoot.because.basis).toBe('descendant');
    expect(imageOf(baseline, keptRoot.because.evidencePid as number)).toContain('dashboard');
  }, CASE_TIMEOUT_MS);

  it('dashboard open in a browser: whether the plan still reaches the AppHost', async () => {
    const { baseline, appHostPid, dialed } = await measure(reader as TaggedProcessReader, true);
    const appHostTargeted = baseline.plan.targets.some((target) => target.pid === appHostPid);
    log(`RESULT dialed=${dialed} appHostTargeted=${appHostTargeted}`);
    // A measurement, not a pin: the answer is read from the log. Only a run
    // that never reached the question fails.
    expect(dialed).not.toBeNull();
  }, CASE_TIMEOUT_MS);
});
