/**
 * The task reap against REAL processes, on whatever OS runs the suite: Linux in
 * CI's unit tier, macOS (Apple silicon and Intel) and Windows in
 * .github/workflows/task-reap-real-processes.yml, and a developer machine.
 *
 * Fixtures cannot prove the parts that matter here:
 *
 * - the leaked process from the incident references its worktree ONLY through
 *   its cwd (not its argv, not its image path), so no command-line scan can see
 *   it, and it is a grandchild whose launcher is already gone;
 * - a fast-detached process (its launcher exits at once) is in no parent tree
 *   at all, and only the inherited `KANGENTIC_TASK_ID` finds it;
 * - the reap leaves alone what it must: a tagged process still under the
 *   reaping process (a live session), another task, a cleared tag, a tagged
 *   process working outside the task's directories, a process shielded by a
 *   cleared-tag child, a tmux server, and (on CI) a window the agent opened.
 *
 * Every process is started from inside a fake project, as an agent's are.
 * Nothing here touches the developer's own processes: tmux runs on a private
 * socket, and windows are opened only under CI.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { scanAllProcesses, findWorktreePathProcesses } from '../../src/main/git/zombie-reaper';
import { isProcessAlive } from '../../src/main/shared/process-liveness';
import { createTaggedProcessReader } from '../../src/main/pty/process-tag/reader-factory';
import { reapTaggedOnce, stopProcessTree } from '../../src/main/pty/process-tag/tagged-reap';
import { TASK_PROCESS_TAG_ENV } from '../../src/main/pty/process-tag/task-process-tag';
import { resolveTaskDirectories } from '../../src/main/pty/process-tag/task-directories';
import { buildWslReapInvocation } from '../../src/main/pty/process-tag/wsl-reap';

const execFileAsync = promisify(execFile);
const APPEAR_TIMEOUT_MS = 20_000;
/**
 * The removal-time path scan the first case contrasts against. On Windows it is
 * a cold PowerShell `Get-CimInstance`, which passed 10 s on a freshly provisioned
 * runner right after `npm ci` (measured on windows-latest). Each case allows 60 s.
 */
const SCAN_TIMEOUT_MS = 30_000;
const TASK_ID = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const OTHER_TASK_ID = '0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f';

const reader = createTaggedProcessReader();
const cleanups: Array<() => void | Promise<void>> = [];
const startedPids: number[] = [];

afterEach(async () => {
  for (const pid of startedPids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Scratch {
  root: string;
  project: string;
  worktree: string;
  elsewhere: string;
}

/** A temp root holding a project with a worktree, and a directory outside it. */
function makeScratch(): Scratch {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kng-tag-reap-')));
  // Best-effort: a survivor of a failed assertion may still hold it.
  cleanups.push(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* held */ }
  });
  const project = path.join(root, 'project');
  const worktree = path.join(project, '.kangentic', 'worktrees', 'task-8');
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  return { root, project, worktree, elsewhere };
}

/** A script that records its own pid, optionally moves to argv[3], then sleeps. */
function writeSleeper(directory: string): string {
  const sleeperPath = path.join(directory, 'sleeper.js');
  fs.writeFileSync(sleeperPath, [
    "const fs = require('fs');",
    'if (process.argv[3]) process.chdir(process.argv[3]);',
    'fs.writeFileSync(process.argv[2], String(process.pid));',
    'setTimeout(() => {}, 60000);',
  ].join('\n'));
  return sleeperPath;
}

/** A script that starts the sleeper detached (setsid on POSIX) and exits at once. */
function writeDetachingLauncher(directory: string): string {
  const launcherPath = path.join(directory, 'launcher.js');
  fs.writeFileSync(launcherPath, [
    "const { spawn } = require('child_process');",
    "const child = spawn(process.execPath, process.argv.slice(2), { detached: true, stdio: 'ignore' });",
    'child.unref();',
  ].join('\n'));
  return launcherPath;
}

/**
 * A detached parent that starts a cleared-tag child (the opt-out) and stays
 * alive beside it. Writes `<parentPid> <childPid>` to argv[2].
 */
function writeOptOutParent(directory: string, sleeperPath: string): string {
  const parentPath = path.join(directory, 'opt-out-parent.js');
  fs.writeFileSync(parentPath, [
    "const fs = require('fs');",
    "const { spawn } = require('child_process');",
    `const childPidFile = process.argv[2] + '.child';`,
    // windowsHide: a console child of a console-less parent otherwise opens a
    // visible console window, and a visible window is protected on its own.
    `const child = spawn(process.execPath, [${JSON.stringify(sleeperPath)}, childPidFile], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ${TASK_PROCESS_TAG_ENV}: '' } });`,
    'const wait = setInterval(() => {',
    '  try { const childPid = fs.readFileSync(childPidFile, "utf8"); if (childPid) { fs.writeFileSync(process.argv[2], process.pid + " " + childPid); clearInterval(wait); } } catch {}',
    '}, 50);',
    'setTimeout(() => {}, 60000);',
  ].join('\n'));
  return parentPath;
}

function envWithTag(tagValue: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[TASK_PROCESS_TAG_ENV];
  if (tagValue !== null) env[TASK_PROCESS_TAG_ENV] = tagValue;
  return env;
}

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + APPEAR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(filePath, 'utf8').trim();
      if (text.length > 0) return text;
    } catch { /* not yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error(`nothing written to ${filePath}`);
}

async function waitForPidFile(pidFile: string): Promise<number> {
  const pid = Number(await waitForFile(pidFile));
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no pid in ${pidFile}`);
  startedPids.push(pid);
  return pid;
}

async function waitUntilDead(pids: number[]): Promise<number[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && pids.some((pid) => isProcessAlive(pid))) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return pids.filter((pid) => isProcessAlive(pid));
}

async function reap(scratch: Scratch, taskIds: string[] = [TASK_ID]) {
  const directories = await resolveTaskDirectories(scratch.project, scratch.worktree);
  return reapTaggedOnce(
    { tasks: taskIds.map((taskId) => ({ taskId, directories, worktreePath: scratch.worktree })), mainPid: process.pid, stop: true },
    { reader: reader!, liveRootPids: () => [] },
  );
}

function hasCommand(command: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Without a reader the whole suite below skips; on the workflow's runners that
// is a failure, not a pass.
it.runIf(process.env.KANGENTIC_REAP_REQUIRE_ALL_CASES === '1')('has a process reader on this platform', () => {
  expect(reader).not.toBeNull();
});

describe.skipIf(reader === null)('task reap against real processes', () => {
  it('kills a cwd-only grandchild whose launcher is gone, which the path scan cannot see', async () => {
    const scratch = makeScratch();
    const sleeperPath = writeSleeper(scratch.root);
    const pidFile = path.join(scratch.root, 'pinner.pid');

    // The incident's shape: a shell wrapper OUTSIDE the worktree cds into it and
    // starts the server, whose argv and image path never mention the worktree.
    const isWindows = process.platform === 'win32';
    const wrapperPath = path.join(scratch.root, isWindows ? 'run-server.cmd' : 'run-server.sh');
    fs.writeFileSync(wrapperPath, isWindows
      ? `@echo off\r\ncd /d "${scratch.worktree}"\r\n"${process.execPath}" "${sleeperPath}" "${pidFile}"\r\n`
      : `#!/bin/sh\ncd "${scratch.worktree}"\n"${process.execPath}" "${sleeperPath}" "${pidFile}"\n`, { mode: 0o755 });
    const wrapper = isWindows
      ? spawn('cmd.exe', ['/c', wrapperPath], { stdio: 'ignore', windowsHide: true, env: envWithTag(TASK_ID) })
      : spawn('/bin/sh', [wrapperPath], { stdio: 'ignore', env: envWithTag(TASK_ID) });
    const pinnerPid = await waitForPidFile(pidFile);

    const rows = await scanAllProcesses(SCAN_TIMEOUT_MS);
    expect(findWorktreePathProcesses(rows, scratch.worktree, new Set()).map((match) => match.pid)).not.toContain(pinnerPid);

    // The session ends: its shell dies, which orphans the server (a dead ppid on
    // Windows, init on POSIX). From here no parent walk reaches it.
    wrapper.kill('SIGKILL');
    await new Promise((resolve) => { wrapper.once('exit', resolve); });
    expect(isProcessAlive(pinnerPid)).toBe(true);
    if (isWindows) {
      expect(() => fs.rmSync(scratch.worktree, { recursive: true, force: true })).toThrow();
    }

    const result = await reap(scratch);
    expect(result.killedPids).toContain(pinnerPid);
    expect(await waitUntilDead([pinnerPid])).toEqual([]);
    // The report names it by program and script, read from its real command
    // line, and nothing else from that command line (the pid file's path).
    expect(result.entries).toContainEqual(expect.objectContaining({
      pid: pinnerPid, outcome: 'stopped', place: 'worktree', label: 'node (sleeper.js)',
    }));

    // Windows drops the cwd handle a beat after the process exits.
    let removed = false;
    const removeBy = Date.now() + 10_000;
    while (!removed && Date.now() < removeBy) {
      try {
        fs.rmSync(scratch.worktree, { recursive: true, force: true });
        removed = true;
      } catch {
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
    }
    expect(removed).toBe(true);
  }, 60_000);

  it('kills fast-detached processes whose launcher exited at once', async () => {
    const scratch = makeScratch();
    const sleeperPath = writeSleeper(scratch.root);
    const launcherPath = writeDetachingLauncher(scratch.root);
    const expectedPids: number[] = [];
    const options = { stdio: 'ignore' as const, env: envWithTag(TASK_ID), windowsHide: true, cwd: scratch.worktree };

    // Node `detached: true`: setsid on POSIX, a detached process on Windows.
    const detachedPidFile = path.join(scratch.root, 'detached.pid');
    spawn(process.execPath, [launcherPath, sleeperPath, detachedPidFile], options);
    expectedPids.push(await waitForPidFile(detachedPidFile));

    if (process.platform === 'win32') {
      // `cmd /c start /b`: cmd exits, the started process keeps running.
      const startPidFile = path.join(scratch.root, 'start.pid');
      spawn('cmd.exe', ['/d', '/s', '/c', `"start "" /b "${process.execPath}" "${sleeperPath}" "${startPidFile}""`], {
        ...options, windowsVerbatimArguments: true,
      });
      expectedPids.push(await waitForPidFile(startPidFile));
    } else {
      const nohupPidFile = path.join(scratch.root, 'nohup.pid');
      spawn('/bin/sh', ['-c', `nohup "${process.execPath}" "${sleeperPath}" "${nohupPidFile}" >/dev/null 2>&1 &`], options);
      expectedPids.push(await waitForPidFile(nohupPidFile));
      if (process.platform === 'linux') {
        const setsidPidFile = path.join(scratch.root, 'setsid.pid');
        spawn('/bin/sh', ['-c', `setsid "${process.execPath}" "${sleeperPath}" "${setsidPidFile}" >/dev/null 2>&1 &`], options);
        expectedPids.push(await waitForPidFile(setsidPidFile));
      }
    }

    const result = await reap(scratch);
    for (const pid of expectedPids) expect(result.killedPids).toContain(pid);
    expect(await waitUntilDead(expectedPids)).toEqual([]);
  }, 60_000);

  it('with stopping off reports a leftover and kills nothing; the list\'s Stop then stops it by identity', async () => {
    const scratch = makeScratch();
    const sleeperPath = writeSleeper(scratch.root);
    const launcherPath = writeDetachingLauncher(scratch.root);
    const pidFile = path.join(scratch.root, 'reported.pid');
    spawn(process.execPath, [launcherPath, sleeperPath, pidFile], { stdio: 'ignore', env: envWithTag(TASK_ID), windowsHide: true, cwd: scratch.worktree });
    const reportedPid = await waitForPidFile(pidFile);

    const directories = await resolveTaskDirectories(scratch.project, scratch.worktree);
    const report = await reapTaggedOnce(
      { tasks: [{ taskId: TASK_ID, directories, worktreePath: scratch.worktree }], mainPid: process.pid, stop: false },
      { reader: reader!, liveRootPids: () => [] },
    );
    expect(report.killedPids).toEqual([]);
    const entry = report.entries.find((candidate) => candidate.pid === reportedPid);
    expect(entry).toMatchObject({ outcome: 'kept', reason: null, place: 'worktree', label: 'node (sleeper.js)' });
    expect(isProcessAlive(reportedPid)).toBe(true);

    // A stale identity is refused: the pid is the same, the start key is not.
    expect(await stopProcessTree({ pid: reportedPid, startKey: `${entry!.startKey}-stale`, mainPid: process.pid }, { reader: reader!, liveRootPids: () => [] })).toBe('ended');
    expect(isProcessAlive(reportedPid)).toBe(true);

    expect(await stopProcessTree({ pid: reportedPid, startKey: entry!.startKey, mainPid: process.pid }, { reader: reader!, liveRootPids: () => [] })).toBe('stopped');
    expect(await waitUntilDead([reportedPid])).toEqual([]);
  }, 60_000);

  it('spares a live descendant of the reaping process, another task, a cleared tag, and tagged processes working outside the task', async () => {
    const scratch = makeScratch();
    const sleeperPath = writeSleeper(scratch.root);
    const launcherPath = writeDetachingLauncher(scratch.root);
    const inWorktree = { stdio: 'ignore' as const, windowsHide: true, cwd: scratch.worktree };

    // Tagged, but still a child of this process: a live session's process tree.
    const liveChildPidFile = path.join(scratch.root, 'live-child.pid');
    spawn(process.execPath, [sleeperPath, liveChildPidFile], { ...inWorktree, env: envWithTag(TASK_ID) });
    const liveChildPid = await waitForPidFile(liveChildPidFile);

    // Detached, but tagged for another task.
    const otherTaskPidFile = path.join(scratch.root, 'other-task.pid');
    spawn(process.execPath, [launcherPath, sleeperPath, otherTaskPidFile], { ...inWorktree, env: envWithTag(OTHER_TASK_ID) });
    const otherTaskPid = await waitForPidFile(otherTaskPidFile);

    // Detached, with the tag cleared: the documented opt-out.
    const clearedPidFile = path.join(scratch.root, 'cleared.pid');
    spawn(process.execPath, [launcherPath, sleeperPath, clearedPidFile], { ...inWorktree, env: envWithTag('') });
    const clearedPid = await waitForPidFile(clearedPidFile);

    // Detached and tagged, but started outside the project, and one that moved
    // to the filesystem root after starting, as a daemon does.
    const outsidePidFile = path.join(scratch.root, 'outside.pid');
    spawn(process.execPath, [launcherPath, sleeperPath, outsidePidFile], { ...inWorktree, cwd: scratch.elsewhere, env: envWithTag(TASK_ID) });
    const outsidePid = await waitForPidFile(outsidePidFile);
    const daemonPidFile = path.join(scratch.root, 'daemon.pid');
    spawn(process.execPath, [launcherPath, sleeperPath, daemonPidFile, path.parse(scratch.root).root], { ...inWorktree, env: envWithTag(TASK_ID) });
    const daemonPid = await waitForPidFile(daemonPidFile);

    const result = await reap(scratch);
    for (const pid of [liveChildPid, otherTaskPid, clearedPid, outsidePid, daemonPid]) {
      expect(result.killedPids).not.toContain(pid);
      expect(isProcessAlive(pid)).toBe(true);
    }
  }, 60_000);

  it('spares a tagged parent whose child cleared the tag: the opt-out shields its parent', async () => {
    const scratch = makeScratch();
    const sleeperPath = writeSleeper(scratch.root);
    const launcherPath = writeDetachingLauncher(scratch.root);
    const parentPath = writeOptOutParent(scratch.root, sleeperPath);
    const pairFile = path.join(scratch.root, 'opt-out.pids');
    spawn(process.execPath, [launcherPath, parentPath, pairFile], { stdio: 'ignore', windowsHide: true, cwd: scratch.worktree, env: envWithTag(TASK_ID) });
    const [parentPid, childPid] = (await waitForFile(pairFile)).split(' ').map(Number);
    startedPids.push(parentPid, childPid);

    const result = await reap(scratch);
    expect(result.killedPids).not.toContain(parentPid);
    expect(result.killedPids).not.toContain(childPid);
    expect(isProcessAlive(parentPid)).toBe(true);
    expect(isProcessAlive(childPid)).toBe(true);
  }, 60_000);

  it.runIf(process.platform !== 'win32' && hasCommand('tmux'))('never kills a tmux server or anything under it: it copies its environment into every later session', async () => {
    const scratch = makeScratch();
    // A private socket, so the developer's own tmux server is never involved.
    const socket = `kng-reap-${process.pid}-${Date.now()}`;
    cleanups.push(() => {
      try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
    });
    const tmuxEnv = { ...envWithTag(TASK_ID), TERM: 'xterm-256color' };
    const sessionPidFile = path.join(scratch.root, 'tmux-pane.pid');
    execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'task', `"${process.execPath}" "${writeSleeper(scratch.root)}" "${sessionPidFile}"`], { cwd: scratch.worktree, env: tmuxEnv });
    const panePid = await waitForPidFile(sessionPidFile);
    const serverPid = Number(execFileSync('tmux', ['-L', socket, 'display-message', '-p', '#{pid}']).toString().trim());
    startedPids.push(serverPid);

    const result = await reap(scratch);
    expect(result.killedPids).not.toContain(serverPid);
    expect(result.killedPids).not.toContain(panePid);
    expect(isProcessAlive(serverPid)).toBe(true);
    expect(isProcessAlive(panePid)).toBe(true);
  }, 60_000);

  // Windows only on CI: opening one on a developer's desktop is not a test's
  // business. Notepad on Windows, xterm under xvfb on Linux, Chrome on macOS.
  const guiLaunch = ((): { command: string; args: (profile: string) => string[] } | null => {
    if (!process.env.CI) return null;
    if (process.platform === 'win32') return { command: 'notepad.exe', args: () => [] };
    if (process.platform === 'linux' && process.env.DISPLAY && hasCommand('xterm')) return { command: 'xterm', args: () => ['-e', 'sleep 120'] };
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (process.platform === 'darwin' && fs.existsSync(chrome)) {
      return { command: chrome, args: (profile) => [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'] };
    }
    return null;
  })();

  it.runIf(guiLaunch !== null)('never kills a visible app the agent opened, or anything under it', async () => {
    const scratch = makeScratch();
    const app = spawn(guiLaunch!.command, guiLaunch!.args(path.join(scratch.root, 'profile')), {
      cwd: scratch.worktree, env: envWithTag(TASK_ID), stdio: 'ignore', detached: true,
    });
    app.unref();
    const appPid = app.pid!;
    startedPids.push(appPid);
    // Wait until the reader sees its window (on macOS, until LaunchServices has
    // it) instead of a fixed delay a loaded runner can outlast. Past the
    // deadline the reap runs anyway, and the assertions below say what happened.
    const visibleBy = Date.now() + 30_000;
    while (Date.now() < visibleBy) {
      const scan = await reader!.scan();
      if (scan.processes.some((scanned) => scanned.pid === appPid && scanned.role === 'visible-app')) break;
      await new Promise((resolve) => { setTimeout(resolve, 500); });
    }
    expect(isProcessAlive(appPid)).toBe(true);

    const result = await reap(scratch);
    expect(result.killedPids).not.toContain(appPid);
    expect(isProcessAlive(appPid)).toBe(true);
  }, 60_000);

  // task-reap-real-processes.yml provisions tmux and a GUI app on every runner
  // and sets this flag, so a case that would skip there fails the job instead
  // of reading as a pass. CI's unit tier has neither and does not set it.
  it.runIf(process.env.KANGENTIC_REAP_REQUIRE_ALL_CASES === '1')('ran every case this runner was provisioned for', () => {
    if (process.platform !== 'win32') expect(hasCommand('tmux'), 'tmux is not installed, so the tmux case skipped').toBe(true);
    expect(guiLaunch, 'no GUI app could be launched, so the visible-app case skipped').not.toBeNull();
  });

  // On a user's Mac, SIP hides the environment of Apple's own tools from the
  // kernel record, so a tagged `nohup sleep` reads as untagged. GitHub's macOS
  // runners run with SIP off and cannot show that, so this starts the tool
  // under `env -i` instead: an empty environment reads exactly like a withheld
  // one (argv only), which puts a REAL process through the withheld branch,
  // the `lsof` working-directory read, and the kill.
  it.runIf(process.platform === 'darwin')('on macOS, reaps a withheld orphan working in the worktree and spares the rest', async () => {
    const scratch = makeScratch();
    const sleeperPath = writeSleeper(scratch.root);

    // The agent's shape: `cd <dir> && cmd &` from a shell that then exits. The
    // whole chain runs under `env -i`, as every Apple tool in it reads under
    // SIP: Apple's /bin/sh (bash 3.2) keeps the `&` subshell alive as the
    // sleeper's parent, so the orphan launchd adopts is that subshell, and the
    // sleeper goes with it as a descendant (the inner bash exports SHLVL, so
    // the sleeper itself has an environment). The short sleep before the pid
    // is written lets the outer shell exit first. `$$` is the inner shell's
    // pid, which `exec` hands to sleep.
    const startWithheld = async (directory: string, name: string): Promise<number> => {
      const pidFile = path.join(scratch.root, `${name}.pid`);
      spawn('/usr/bin/env', ['-i', '/bin/sh', '-c', `cd "${directory}" && /bin/sh -c '/bin/sleep 0.3; echo $$ > "${pidFile}"; exec /bin/sleep 300' >/dev/null 2>&1 &`], { stdio: 'ignore' });
      return waitForPidFile(pidFile);
    };
    const inWorktreePid = await startWithheld(scratch.worktree, 'withheld-in-worktree');
    const outsidePid = await startWithheld(scratch.elsewhere, 'withheld-outside');
    // In the project but not the worktree: with no tag, only the worktree counts.
    const inProjectPid = await startWithheld(scratch.project, 'withheld-in-project');

    // A readable environment with the tag cleared, in the worktree: the
    // environment wins over the directory, so the opt-out holds.
    const clearedPidFile = path.join(scratch.root, 'cleared-in-worktree.pid');
    spawn('/bin/sh', ['-c', `cd "${scratch.worktree}" && nohup "${process.execPath}" "${sleeperPath}" "${clearedPidFile}" >/dev/null 2>&1 &`], { stdio: 'ignore', env: envWithTag('') });
    const clearedPid = await waitForPidFile(clearedPidFile);

    // What the reader saw for the target and its ancestors, for the failure
    // message: pids, parents, flags and directories only, never environment.
    const before = await reader!.scan();
    const byPid = new Map(before.processes.map((scanned) => [scanned.pid, scanned]));
    const chain: string[] = [];
    for (let cursor = byPid.get(inWorktreePid); cursor && chain.length < 8; cursor = byPid.get(cursor.ppid)) {
      chain.push(`${cursor.pid}<-${cursor.ppid} withheld=${cursor.environmentWithheld ?? false} cwd=${cursor.workingDirectory ?? '-'} tagged=${cursor.tagValue !== null}`);
      if (cursor.ppid === cursor.pid) break;
    }

    const result = await reap(scratch);
    expect(result.killedPids, `worktree ${scratch.worktree}; chain ${chain.join(' | ')}`).toContain(inWorktreePid);
    for (const pid of [outsidePid, inProjectPid, clearedPid]) expect(result.killedPids).not.toContain(pid);
    // The second scan still sees the ones it spared, and counts them.
    expect(result.unreadableCount).toBeGreaterThanOrEqual(1);
    expect(await waitUntilDead([inWorktreePid])).toEqual([]);
    for (const pid of [outsidePid, inProjectPid, clearedPid]) expect(isProcessAlive(pid)).toBe(true);
  }, 60_000);

  // The in-distro WSL script, run for real against Linux's /proc. `wslpath`
  // is absent here, so the script keeps each directory as given.
  it.runIf(process.platform === 'linux')('the WSL reap script kills only tagged processes inside the task\'s directories', async () => {
    const scratch = makeScratch();
    const sleeperPath = writeSleeper(scratch.root);
    const launcherPath = writeDetachingLauncher(scratch.root);
    const start = async (name: string, cwd: string, tagValue: string | null): Promise<number> => {
      const pidFile = path.join(scratch.root, `${name}.pid`);
      spawn(process.execPath, [launcherPath, sleeperPath, pidFile], { stdio: 'ignore', cwd, env: envWithTag(tagValue) });
      return waitForPidFile(pidFile);
    };
    const insidePid = await start('wsl-inside', scratch.worktree, TASK_ID);
    const outsidePid = await start('wsl-outside', scratch.elsewhere, TASK_ID);
    const untaggedPid = await start('wsl-untagged', scratch.worktree, null);

    const invocation = buildWslReapInvocation([{ taskId: TASK_ID, directories: [scratch.project] }])!;
    const { stdout } = await execFileAsync('sh', ['-c', invocation.script, 'sh', ...invocation.args]);
    const killed = stdout.split(/\s+/).filter((token) => /^\d+$/.test(token)).map(Number);
    expect(killed).toContain(insidePid);
    expect(killed).not.toContain(outsidePid);
    expect(killed).not.toContain(untaggedPid);
    expect(await waitUntilDead([insidePid])).toEqual([]);
    expect(isProcessAlive(outsidePid)).toBe(true);
    expect(isProcessAlive(untaggedPid)).toBe(true);
  }, 60_000);
});
