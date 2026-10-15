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
 * cannot import. The wiring case is a source check: `vitest.config.mts` defines
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
  PREVIEW_STOP_FOR_WORKTREE_REMOVAL,
  previewPidFilePath,
  previewStopFilePath,
  previewStoppingMarkerPath,
  stopWorktreePreviews,
  type PreviewProcessRow,
} from '../../src/devtools/main/worktree-preview-stop';
import { isProcessAlive } from '../../src/main/shared/process-liveness';

// CJS scripts (run by node directly, not bundled), loaded the way the other script tests do.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pidFilePathFor, stopFilePathFor } = require('../../scripts/worktree-preview.js') as {
  pidFilePathFor: (worktreeDir: string, port: number) => string;
  stopFilePathFor: (worktreeDir: string, port: number) => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stoppingMarkerPathFor, WORKTREE_REMOVAL_STOP_REASON } = require('../../scripts/preview-isolation.js') as {
  stoppingMarkerPathFor: (worktreeDir: string, port: number) => string;
  WORKTREE_REMOVAL_STOP_REASON: string;
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

    expect(results).toEqual([expect.objectContaining({ worktreePath: worktree, port: 5174, pid: child.pid, outcome: 'stopped', tree: null })]);
    expect(results[0].elapsedMs).toBeGreaterThanOrEqual(250);
    // The stop says the worktree goes next, so dev.js deletes nothing on its way out.
    expect(fs.readFileSync(previewStopFilePath(worktree, 5174), 'utf-8')).toBe(PREVIEW_STOP_FOR_WORKTREE_REMOVAL);
    expect(fs.readdirSync(path.join(worktree, '.kangentic')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
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

  it('leaves no temporary file behind when the stop file cannot be written', async () => {
    const worktree = makeWorktree();
    await startFakeDevServer(worktree, 5174, 'deaf');
    fs.mkdirSync(previewStopFilePath(worktree, 5174));

    await stopWorktreePreviews([worktree], { acknowledgeMs: 2000, boundMs: 5000 });

    expect(fs.readdirSync(path.join(worktree, '.kangentic')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
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

/**
 * The rest of a preview's tree, as the pty host's listing shows it. Measured on
 * Windows: 40 ms after `dev.js` stopped answering, the tab's `cmd` was still
 * running with the exited `dev.js` listed under it, and the reap read that
 * `cmd` as shared. These cases feed a fake listing around a real `dev.js`
 * stand-in, so liveness stays real and only the table is scripted.
 */
describe('stopWorktreePreviews waits for the rest of the preview tree', () => {
  /** A pid no real process here holds for the test's length: well above this run's own. */
  const LAUNCHER_PID = 4_000_001;
  const LATE_CHILD_PID = 4_000_002;
  const STRANGER_PID = 4_000_003;

  interface ListingScript {
    /** The launcher shell's name; anything but `cmd` is not the launcher. */
    launcherName?: string;
    /** How long the launcher stays listed after `dev.js` exits; Infinity never leaves. */
    launcherOutlivesDevMs: number;
    /** A child of `dev.js` that appears once it has exited, listed for this long. */
    lateChildForMs?: number;
    /** The pid this process is listed under. Its own parent's by default, which is outside the tree. */
    ownProcessParentPid?: (devPid: number) => number;
    /** Rows listed throughout. Keep one row per pid across all of a script's rows. */
    alwaysListed?: PreviewProcessRow[];
    /** Rows listed from the first listing taken after `dev.js` has exited, and not before. */
    listedAfterDevExit?: PreviewProcessRow[];
  }

  function scriptedListing(devPid: number, script: ListingScript): { list: () => Promise<PreviewProcessRow[]>; calls: () => number } {
    let devExitedAt: number | null = null;
    let calls = 0;
    const list = async (): Promise<PreviewProcessRow[]> => {
      calls += 1;
      const devAlive = isProcessAlive(devPid);
      if (!devAlive && devExitedAt === null) devExitedAt = Date.now();
      const sinceDevExit = devExitedAt === null ? 0 : Date.now() - devExitedAt;
      const rows: PreviewProcessRow[] = [{ pid: process.pid, ppid: script.ownProcessParentPid?.(devPid) ?? process.ppid, comm: 'node' }];
      if (devExitedAt === null || sinceDevExit < script.launcherOutlivesDevMs) {
        rows.push({ pid: LAUNCHER_PID, ppid: 1, comm: script.launcherName ?? 'cmd' });
      }
      if (devAlive) rows.push({ pid: devPid, ppid: LAUNCHER_PID, comm: 'node' });
      if (devExitedAt !== null && script.lateChildForMs !== undefined && sinceDevExit < script.lateChildForMs) {
        rows.push({ pid: LATE_CHILD_PID, ppid: devPid, comm: 'node' });
      }
      rows.push(...(script.alwaysListed ?? []));
      if (devExitedAt !== null) rows.push(...(script.listedAfterDevExit ?? []));
      return rows;
    };
    return { list, calls: () => calls };
  }

  it('waits for the launcher shell that outlives dev.js', async () => {
    const worktree = makeWorktree();
    const child = await startFakeDevServer(worktree, 5174, 'dev', 100);
    const listing = scriptedListing(child.pid!, { launcherOutlivesDevMs: 400 });

    const results = await stopWorktreePreviews([worktree], { listProcesses: listing.list });

    expect(results).toEqual([expect.objectContaining({ outcome: 'stopped', tree: expect.objectContaining({ outcome: 'gone' }) })]);
    const tree = results[0].tree!;
    expect(tree.elapsedMs).toBeGreaterThanOrEqual(300);
    expect(tree.elapsedMs).toBeLessThan(1900);
  });

  it('adopts a child dev.js started on its way out and waits for it too', async () => {
    const worktree = makeWorktree();
    const child = await startFakeDevServer(worktree, 5174, 'dev', 100);
    // The launcher goes at once; only the late child holds the wait.
    const listing = scriptedListing(child.pid!, { launcherOutlivesDevMs: 0, lateChildForMs: 400 });

    const results = await stopWorktreePreviews([worktree], { listProcesses: listing.list });

    expect(results[0].tree).toEqual(expect.objectContaining({ outcome: 'gone' }));
    expect(results[0].tree!.elapsedMs).toBeGreaterThanOrEqual(300);
  });

  it('gives up at the tree bound and names what is still listed', async () => {
    const worktree = makeWorktree();
    const child = await startFakeDevServer(worktree, 5174, 'dev', 100);
    const listing = scriptedListing(child.pid!, { launcherOutlivesDevMs: Number.POSITIVE_INFINITY });

    const results = await stopWorktreePreviews([worktree], { listProcesses: listing.list, treeBoundMs: 400 });

    expect(results[0].outcome).toBe('stopped');
    expect(results[0].tree).toEqual({ outcome: 'listed', elapsedMs: expect.any(Number), leftovers: [`cmd ${LAUNCHER_PID}`] });
    expect(results[0].tree!.elapsedMs).toBeGreaterThanOrEqual(400);
  });

  it('never waits on a parent that is not the launcher shell', async () => {
    const worktree = makeWorktree();
    const child = await startFakeDevServer(worktree, 5174, 'dev', 100);
    // Windows Terminal itself, or a pid reused by something else: never part of the preview.
    const listing = scriptedListing(child.pid!, { launcherName: 'windowsterminal', launcherOutlivesDevMs: Number.POSITIVE_INFINITY });

    const results = await stopWorktreePreviews([worktree], { listProcesses: listing.list, treeBoundMs: 1500 });

    expect(results[0].tree).toEqual(expect.objectContaining({ outcome: 'gone' }));
    expect(results[0].tree!.elapsedMs).toBeLessThan(500);
  });

  it('adopts a child of a tracked process that is still listed under the name it was tracked with', async () => {
    const worktree = makeWorktree();
    const child = await startFakeDevServer(worktree, 5174, 'dev', 100);
    // Control for the pid-reuse case below: the launcher pid is listed again after dev.js exits,
    // under its tracked name, with a child. Only the name differs from the reuse case.
    const listing = scriptedListing(child.pid!, {
      launcherOutlivesDevMs: 0,
      listedAfterDevExit: [
        { pid: LAUNCHER_PID, ppid: 1, comm: 'cmd' },
        { pid: STRANGER_PID, ppid: LAUNCHER_PID, comm: 'notepad' },
      ],
    });

    const results = await stopWorktreePreviews([worktree], { listProcesses: listing.list, treeBoundMs: 600 });

    expect(results[0].tree).toEqual({
      outcome: 'listed',
      elapsedMs: expect.any(Number),
      leftovers: expect.arrayContaining([`cmd ${LAUNCHER_PID}`, `notepad ${STRANGER_PID}`]),
    });
  });

  it('does not adopt a child of a tracked pid that the listing now gives another name (a reused pid)', async () => {
    const worktree = makeWorktree();
    const child = await startFakeDevServer(worktree, 5174, 'dev', 100);
    // The launcher shell exited and Windows handed its pid to an unrelated program, which has a
    // child of its own. Neither is part of the preview, and neither may hold the stop.
    const listing = scriptedListing(child.pid!, {
      launcherOutlivesDevMs: 0,
      listedAfterDevExit: [
        { pid: LAUNCHER_PID, ppid: 1, comm: 'chrome' },
        { pid: STRANGER_PID, ppid: LAUNCHER_PID, comm: 'notepad' },
      ],
    });

    const results = await stopWorktreePreviews([worktree], { listProcesses: listing.list, treeBoundMs: 600 });

    expect(results[0].outcome).toBe('stopped');
    expect(results[0].tree).toEqual({ outcome: 'gone', elapsedMs: expect.any(Number) });
    // Positive control: the listing was read after dev.js exited, so the reused rows were in view.
    expect(listing.calls()).toBeGreaterThan(1);
  });

  describe('never waits on this process or its parent', () => {
    /**
     * Each is listed as a descendant of the preview with the tracked process's own name, and stays
     * listed for the whole run. Only the forgetting keeps the stop from waiting the full bound on
     * the test runner itself. The default row for this process hangs off its own parent, so the
     * `process.ppid` case leaves it in place and the `process.pid` case moves it under `dev.js`.
     */
    it.each([
      {
        subject: 'this process',
        script: (): Partial<ListingScript> => ({ ownProcessParentPid: (devPid) => devPid }),
      },
      {
        subject: 'its parent',
        script: (): Partial<ListingScript> => ({ alwaysListed: [{ pid: process.ppid, ppid: LAUNCHER_PID, comm: 'node' }] }),
      },
    ])('leaves $subject out of the tree even when the listing links it under the preview', async ({ script }) => {
      const worktree = makeWorktree();
      const child = await startFakeDevServer(worktree, 5174, 'dev', 100);
      const listing = scriptedListing(child.pid!, { launcherOutlivesDevMs: 0, ...script() });

      const results = await stopWorktreePreviews([worktree], { listProcesses: listing.list, treeBoundMs: 1500 });

      expect(results[0].outcome).toBe('stopped');
      expect(results[0].tree).toEqual({ outcome: 'gone', elapsedMs: expect.any(Number) });
      // Well under the bound: the first listing after dev.js exited already had nothing to wait for.
      expect(results[0].tree!.elapsedMs).toBeLessThan(500);
      expect(listing.calls()).toBeGreaterThan(1);
    });
  });

  it('ends with dev.js when the host has no table to give', async () => {
    const worktree = makeWorktree();
    await startFakeDevServer(worktree, 5174, 'dev', 100);
    let calls = 0;
    const emptyListing = async (): Promise<PreviewProcessRow[]> => {
      calls += 1;
      return [];
    };

    const results = await stopWorktreePreviews([worktree], { listProcesses: emptyListing });

    expect(results).toEqual([expect.objectContaining({ outcome: 'stopped', tree: null })]);
    // Positive control: the listing was asked, and its empty answer read as "no table".
    expect(calls).toBeGreaterThan(0);
  });

  it('does not wait on the tree of a preview that never acknowledged', async () => {
    const worktree = makeWorktree();
    const child = await startFakeDevServer(worktree, 5174, 'deaf');
    const listing = scriptedListing(child.pid!, { launcherOutlivesDevMs: Number.POSITIVE_INFINITY });

    const results = await stopWorktreePreviews([worktree], { acknowledgeMs: 300, boundMs: 5000, listProcesses: listing.list, treeBoundMs: 3000 });

    expect(results).toEqual([expect.objectContaining({ outcome: 'unacknowledged', tree: null })]);
    expect(results[0].elapsedMs).toBeLessThan(2500);
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

  it('makes dev.js skip its ephemeral cleanup when the stop says the worktree is being removed', () => {
    expect(WORKTREE_REMOVAL_STOP_REASON).toBe(PREVIEW_STOP_FOR_WORKTREE_REMOVAL);
    expect(devScript).toContain('worktreeRemovalFollows = isWorktreeRemovalStop(stopFilePath);');
    // The skip comes before the trash move, so no detached deleter starts.
    const cleanupStart = devScript.indexOf('function cleanup(exitCode)');
    const skip = devScript.indexOf('if (ephemeral && isWorktreeCheckout && worktreeRemovalFollows)', cleanupStart);
    const trashMove = devScript.indexOf('moveIntoTrash(', cleanupStart);
    expect(skip).toBeGreaterThan(cleanupStart);
    expect(skip).toBeLessThan(trashMove);
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
    // Without the listing, the stop ends when dev.js does and the tab's shell is still there.
    expect(body).toContain('listProcesses: () => context.sessionManager.listProcesses()');
  });
});
