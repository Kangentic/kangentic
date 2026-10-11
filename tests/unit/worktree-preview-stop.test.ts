/**
 * The dev-build stop of a task worktree's `/preview` before the task's leftover
 * reap (src/devtools/main/worktree-preview-stop.ts). A Done move once left a
 * preview running: the Windows reap read its terminal tab's shell as a visible
 * app, and a hard terminate of `dev.js` would have orphaned its Electron on a
 * dead Vite. The stop goes through the launcher's own stop file instead.
 *
 * The behavior cases run against a real node child that speaks `dev.js`'s side
 * of the protocol, so liveness and the files are real. The parity cases pin the
 * file names and the two bounds against the scripts themselves, which main
 * cannot import. The wiring case is a source check: `vitest.config.ts` defines
 * `__KANGENTIC_DEV__` as false, so no unit test can run the gated call.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  PREVIEW_ACKNOWLEDGE_MS,
  PREVIEW_STOP_BOUND_MS,
  previewPidFilePath,
  previewStopFilePath,
  previewStoppingMarkerPath,
  stopWorktreePreviews,
} from '../../src/devtools/main/worktree-preview-stop';
import { isProcessAlive } from '../../src/main/shared/process-liveness';

// CJS scripts (run by node directly, not bundled), loaded the way the other script tests do.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pidFilePathFor, stopFilePathFor } = require('../../scripts/worktree-preview.js') as {
  pidFilePathFor: (worktreeDir: string, port: number) => string;
  stopFilePathFor: (worktreeDir: string, port: number) => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stoppingMarkerPathFor } = require('../../scripts/preview-isolation.js') as {
  stoppingMarkerPathFor: (worktreeDir: string, port: number) => string;
};

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * `dev.js`'s side of the protocol, reduced to what the stop reads: it writes
 * its pid file, polls for the stop file, writes the stopping marker, and exits
 * after a delay, removing both. `deaf` never answers (a stale pid file whose
 * pid another process reused), `hang` answers and never exits, and
 * `self-exit` exits after the delay with no stop asked.
 */
const FAKE_DEV_SERVER = `
const fs = require('fs');
const path = require('path');
const [worktree, port, mode, delay] = process.argv.slice(1);
const kangentic = path.join(worktree, '.kangentic');
fs.mkdirSync(kangentic, { recursive: true });
const pidFile = path.join(kangentic, 'preview-' + port + '.pid');
const stopFile = path.join(kangentic, 'preview-' + port + '.stop');
const marker = path.join(kangentic, 'preview-' + port + '.stopping');
fs.writeFileSync(pidFile, String(process.pid));
const finish = () => { fs.rmSync(marker, { force: true }); fs.rmSync(pidFile, { force: true }); process.exit(0); };
if (mode === 'self-exit') setTimeout(finish, Number(delay));
let stopping = false;
setInterval(() => {
  if (stopping || mode === 'deaf' || !fs.existsSync(stopFile)) return;
  stopping = true;
  fs.writeFileSync(marker, String(process.pid));
  if (mode === 'dev') setTimeout(finish, Number(delay));
}, 50);
process.stdout.write('ready\\n');
`;

type FakeMode = 'dev' | 'deaf' | 'hang' | 'self-exit';

const children: ChildProcess[] = [];
const temporaryRoots: string[] = [];

function makeWorktree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-stop-'));
  temporaryRoots.push(root);
  return root;
}

function startFakeDevServer(worktree: string, port: number, mode: FakeMode, delayMs = 0): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', FAKE_DEV_SERVER, worktree, String(port), mode, String(delayMs)], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', () => resolve(child));
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForExit(child);
    }
  }
  for (const root of temporaryRoots.splice(0)) {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe('stopWorktreePreviews', () => {
  it('asks a running preview to stop through its stop file and resolves once it has exited', async () => {
    const worktree = makeWorktree();
    const child = await startFakeDevServer(worktree, 5174, 'dev', 300);

    const results = await stopWorktreePreviews([worktree]);

    expect(results).toEqual([expect.objectContaining({ worktreePath: worktree, port: 5174, pid: child.pid, outcome: 'stopped' })]);
    expect(results[0].elapsedMs).toBeGreaterThanOrEqual(250);
    expect(fs.existsSync(previewStopFilePath(worktree, 5174))).toBe(true);
    expect(isProcessAlive(child.pid!)).toBe(false);
  });

  it('writes nothing for a pid file whose process is gone', async () => {
    const worktree = makeWorktree();
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    await waitForExit(exited);
    fs.mkdirSync(path.join(worktree, '.kangentic'), { recursive: true });
    fs.writeFileSync(previewPidFilePath(worktree, 5174), String(exited.pid));

    expect(await stopWorktreePreviews([worktree])).toEqual([]);
    expect(fs.existsSync(previewStopFilePath(worktree, 5174))).toBe(false);
  });

  it('stops waiting on a live pid that never acknowledges, well before the bound', async () => {
    const worktree = makeWorktree();
    const child = await startFakeDevServer(worktree, 5174, 'deaf');

    const results = await stopWorktreePreviews([worktree], { acknowledgeMs: 300, boundMs: 5000 });

    expect(results).toEqual([expect.objectContaining({ pid: child.pid, outcome: 'unacknowledged' })]);
    expect(results[0].elapsedMs).toBeGreaterThanOrEqual(300);
    expect(results[0].elapsedMs).toBeLessThan(2500);
    // Positive control: the stop was asked, and the process is still the reap's to judge.
    expect(fs.existsSync(previewStopFilePath(worktree, 5174))).toBe(true);
    expect(isProcessAlive(child.pid!)).toBe(true);
  });

  it('returns at the bound for a preview that acknowledged and never exited', async () => {
    const worktree = makeWorktree();
    const child = await startFakeDevServer(worktree, 5174, 'hang');

    const results = await stopWorktreePreviews([worktree], { acknowledgeMs: 300, boundMs: 900 });

    expect(results).toEqual([expect.objectContaining({ pid: child.pid, outcome: 'timed-out' })]);
    expect(results[0].elapsedMs).toBeGreaterThanOrEqual(900);
    // It acknowledged, so it was waited for past the acknowledgement window.
    expect(fs.existsSync(previewStoppingMarkerPath(worktree, 5174))).toBe(true);
  });

  it('only waits, writing no stop file, for a preview already stopping', async () => {
    const worktree = makeWorktree();
    const child = await startFakeDevServer(worktree, 5174, 'self-exit', 900);
    fs.writeFileSync(previewStoppingMarkerPath(worktree, 5174), String(child.pid));

    const results = await stopWorktreePreviews([worktree], { acknowledgeMs: 300, boundMs: 5000 });

    // Past the acknowledgement window: the marker was its acknowledgement.
    expect(results).toEqual([expect.objectContaining({ pid: child.pid, outcome: 'stopped' })]);
    expect(results[0].elapsedMs).toBeGreaterThanOrEqual(600);
    expect(fs.existsSync(previewStopFilePath(worktree, 5174))).toBe(false);
  });

  it('never stops this process or its parent, and skips a worktree with no .kangentic folder', async () => {
    const worktree = makeWorktree();
    fs.mkdirSync(path.join(worktree, '.kangentic'), { recursive: true });
    fs.writeFileSync(previewPidFilePath(worktree, 5174), String(process.pid));
    fs.writeFileSync(previewPidFilePath(worktree, 5175), String(process.ppid));
    const bare = makeWorktree();

    // Positive control: both pids are alive, so only the identity check skips them.
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(process.ppid)).toBe(true);
    expect(await stopWorktreePreviews([worktree, bare])).toEqual([]);
    expect(fs.existsSync(previewStopFilePath(worktree, 5174))).toBe(false);
    expect(fs.existsSync(previewStopFilePath(worktree, 5175))).toBe(false);
  });

  it('stops the previews of several worktrees at once, so they cost one wait', async () => {
    const first = makeWorktree();
    const second = makeWorktree();
    await startFakeDevServer(first, 5174, 'dev', 1000);
    await startFakeDevServer(second, 5180, 'dev', 1000);

    const startedAt = Date.now();
    const results = await stopWorktreePreviews([first, second]);
    const elapsedMs = Date.now() - startedAt;

    expect(results.map((stopResult) => stopResult.outcome)).toEqual(['stopped', 'stopped']);
    // One after the other would take at least 2000 ms.
    expect(elapsedMs).toBeLessThan(1800);
  });

  it('returns unacknowledged at once, without polling, when the stop file cannot be written', async () => {
    const worktree = makeWorktree();
    // A deaf child: the fake also reads a directory at the stop path as "stop asked", which would
    // acknowledge it. Deaf never answers, so only the early return can end this call before the window.
    const child = await startFakeDevServer(worktree, 5174, 'deaf');
    // A directory where the stop file belongs makes the write fail (EISDIR, or EPERM on Windows).
    fs.mkdirSync(previewStopFilePath(worktree, 5174));

    const results = await stopWorktreePreviews([worktree], { acknowledgeMs: 2000, boundMs: 5000 });

    expect(results).toEqual([expect.objectContaining({ pid: child.pid, outcome: 'unacknowledged' })]);
    // Polling on would run to the 2000 ms acknowledgement window.
    expect(results[0].elapsedMs).toBeLessThan(1000);
    expect(fs.statSync(previewStopFilePath(worktree, 5174)).isDirectory()).toBe(true);
    expect(isProcessAlive(child.pid!)).toBe(true);
  });

  it('resolves to an empty list instead of throwing when probing a pid fails', async () => {
    const worktree = makeWorktree();
    fs.mkdirSync(path.join(worktree, '.kangentic'), { recursive: true });
    // A positive pid that is neither this process nor its parent, so the probe is reached.
    const unrelatedPid = process.pid + process.ppid + 1;
    fs.writeFileSync(previewPidFilePath(worktree, 5174), String(unrelatedPid));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failingProbe = (): boolean => {
      throw new Error('probe failed');
    };

    try {
      await expect(stopWorktreePreviews([worktree], { isProcessAlive: failingProbe })).resolves.toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(previewStopFilePath(worktree, 5174))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('asks for the stop when the stopping marker is stale, and does not count it as an acknowledgement', async () => {
    const worktree = makeWorktree();
    // A live pid that never answers, with a marker a hard-killed dev.js left behind a minute ago.
    const child = await startFakeDevServer(worktree, 5174, 'deaf');
    const markerPath = previewStoppingMarkerPath(worktree, 5174);
    fs.writeFileSync(markerPath, String(child.pid));
    const minuteAgoSeconds = Date.now() / 1000 - 60;
    fs.utimesSync(markerPath, minuteAgoSeconds, minuteAgoSeconds);

    // The bound stays under vitest's 5000 ms test timeout, so a regression fails the outcome
    // assertion below instead of timing out. The marker is 60 s old, far past any bound used here.
    const results = await stopWorktreePreviews([worktree], { acknowledgeMs: 300, boundMs: 2000 });

    // Counted as an acknowledgement, it would run to the bound as timed-out with no stop file.
    expect(results).toEqual([expect.objectContaining({ pid: child.pid, outcome: 'unacknowledged' })]);
    expect(results[0].elapsedMs).toBeGreaterThanOrEqual(300);
    expect(results[0].elapsedMs).toBeLessThan(2500);
    expect(fs.existsSync(previewStopFilePath(worktree, 5174))).toBe(true);
    expect(isProcessAlive(child.pid!)).toBe(true);
  });
});

describe('the preview stop protocol matches the scripts that speak it', () => {
  const sampleWorktree = path.join(os.tmpdir(), 'kangentic', '.kangentic', 'worktrees', '779');
  const devScript = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'dev.js'), 'utf-8');

  it('names the pid, stop and stopping files as the launcher and preview-isolation.js do', () => {
    expect(previewPidFilePath(sampleWorktree, 5174)).toBe(pidFilePathFor(sampleWorktree, 5174));
    expect(previewStopFilePath(sampleWorktree, 5174)).toBe(stopFilePathFor(sampleWorktree, 5174));
    expect(previewStoppingMarkerPath(sampleWorktree, 5174)).toBe(stoppingMarkerPathFor(sampleWorktree, 5174));
  });

  it('names them as dev.js does', () => {
    expect(devScript).toContain("path.join(projectDir, '.kangentic', `preview-${port}.pid`)");
    expect(devScript).toContain("path.join(projectDir, '.kangentic', `preview-${port}.stop`)");
    expect(devScript).toContain('stoppingMarkerPathFor(projectDir, port)');
  });

  it('gives dev.js at least two stop-file polls to acknowledge, and outlasts its graceful quit', () => {
    const pollMatch = /const stopWatcher = setInterval\([\s\S]*?\}, (\d+)\);/.exec(devScript);
    const quitMatch = /const GRACEFUL_QUIT_DEADLINE_MS = (\d+);/.exec(devScript);
    expect(pollMatch, 'dev.js no longer polls for the stop file with a stopWatcher interval').not.toBeNull();
    expect(quitMatch, 'dev.js no longer declares GRACEFUL_QUIT_DEADLINE_MS').not.toBeNull();
    expect(PREVIEW_ACKNOWLEDGE_MS).toBeGreaterThanOrEqual(2 * Number(pollMatch![1]));
    expect(PREVIEW_STOP_BOUND_MS).toBeGreaterThan(Number(quitMatch![1]));
  });
});

describe('reapTaskLeftovers wiring', () => {
  it('stops the previews in a dev build, with stopping on, before the host reap', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main', 'ipc', 'helpers', 'task-cleanup.ts'), 'utf-8');
    const start = source.indexOf('export async function reapTaskLeftovers(');
    expect(start, 'reapTaskLeftovers is gone from task-cleanup.ts').toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\nexport ', start + 1);
    const body = source.slice(start, end === -1 ? undefined : end);

    expect(body).toMatch(/if \(__KANGENTIC_DEV__ && stoppingEnabled\) \{\s*await stopWorktreePreviews\(/);
    expect(body.indexOf('stopWorktreePreviews(')).toBeLessThan(body.indexOf('reapTaskProcesses('));
  });
});
