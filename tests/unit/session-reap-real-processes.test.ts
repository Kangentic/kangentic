/**
 * The discriminating test for the session reap, against REAL processes.
 *
 * Every other test in this change uses fixtures. This one exists because the
 * fixtures cannot prove the thing that actually matters: that the two mechanisms
 * differ, and that only the tree walk finds the process from the incident.
 *
 * The repro is pinned to the reported shape and must stay that way:
 *
 *   - the leaked process's ARGV does not contain the worktree path
 *   - its EXECUTABLE PATH does not either (`process.execPath`, captured before
 *     the cd, is the test runner's own node, well outside the temp worktree)
 *   - only its CWD does
 *   - and it is a GRANDCHILD, reached through a shell wrapper that itself lives
 *     outside the worktree
 *
 * Relax any of those and the test starts passing on the command-line scan alone,
 * at which point it would happily green-light a fix that does not fix the bug.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProcessTreeProbe,
  walkDescendants,
} from '../../src/main/activity-engine/background-shell/process-tree';
import {
  scanAllProcesses,
  findWorktreePathProcesses,
  killProcess,
} from '../../src/main/git/zombie-reaper';
import { reapCapturedTree } from '../../src/main/pty/session-tree-reap';
import { isProcessAlive } from '../../src/main/shared/process-liveness';

/** Generous: a cold PowerShell CIM query can take ~1s on a loaded Windows host. */
const APPEAR_TIMEOUT_MS = 20_000;
const SCAN_TIMEOUT_MS = 10_000;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/**
 * Start `shell wrapper -> node` with the node process's cwd inside `worktreeDir`
 * and no mention of that path in either its argv or its image path. Returns the
 * wrapper child, which stands in for the session's PTY.
 */
function startLeakedServer(worktreeDir: string, scriptDir: string): ChildProcess {
  // Sleep rather than listen: binding a port would make the test racy against
  // whatever else is running, and the port is not what is under test here.
  const inlineScript = 'setTimeout(function(){}, 60000)';
  const isWindows = process.platform === 'win32';
  const wrapperPath = path.join(scriptDir, isWindows ? 'run-server.cmd' : 'run-server.sh');
  // `process.execPath` is captured HERE, outside the worktree, and passed as an
  // absolute path. That is what keeps executablePath off the needle.
  const wrapperBody = isWindows
    ? `@echo off\r\ncd /d "${worktreeDir}"\r\n"${process.execPath}" -e "${inlineScript}"\r\n`
    // Deliberately NOT `exec`: exec replaces the shell, which would collapse the
    // grandchild into the wrapper pid itself and leave the descendant set empty.
    // The incident's shape is a shell that OUTLIVES its child, and the test only
    // discriminates if the leaked process is genuinely one level down.
    : `#!/bin/sh\ncd "${worktreeDir}"\n"${process.execPath}" -e "${inlineScript}"\n`;
  fs.writeFileSync(wrapperPath, wrapperBody, { mode: 0o755 });

  const child = isWindows
    ? spawn('cmd.exe', ['/c', wrapperPath], { stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sh', [wrapperPath], { stdio: 'ignore' });
  // Kill the TREE, not just the wrapper. `child.kill()` reaches the shell only,
  // and the surviving grandchild would keep the temp worktree undeletable - the
  // exact failure this test is about, which would otherwise show up as a
  // confusing EPERM in teardown rather than as the assertion it belongs in.
  cleanups.push(() => killProcess(child.pid!).catch(() => { /* already gone */ }));
  return child;
}

describe('session reap against real processes', () => {
  it('the tree walk finds a cwd-only pinner that the path scan cannot see', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-reap-'));
    // Best-effort: if an assertion failed before the reap ran, a survivor may
    // still hold the directory. Leave it to the OS temp cleaner rather than
    // masking the real failure with an EPERM from teardown.
    cleanups.push(() => {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* held */ }
    });
    // Shaped like the real thing: <project>/.kangentic/worktrees/<slug>.
    const worktreeDir = path.join(root, '.kangentic', 'worktrees', 'task-8');
    const scriptDir = path.join(root, 'scratchpad');
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(scriptDir, { recursive: true });

    const wrapper = startLeakedServer(worktreeDir, scriptDir);
    expect(wrapper.pid).toBeGreaterThan(0);

    const probe = createProcessTreeProbe();
    cleanups.push(() => probe.dispose());

    // ---- Piece A: walk the tree from the wrapper, the way a session teardown
    // walks from its PTY pid.
    let descendantPids: number[] = [];
    const deadline = Date.now() + APPEAR_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const all = await probe.listAllProcesses();
      if (all.length > 0) {
        descendantPids = walkDescendants(all, wrapper.pid!).map((entry) => entry.pid);
        if (descendantPids.length > 0) break;
      }
      // Paced deliberately. Each POSIX poll forks `ps`, and CI runs this tier at
      // several workers, so a tight loop here would be a fork storm that makes
      // this test the flake it was written to prevent.
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }

    expect(descendantPids.length).toBeGreaterThan(0);

    // ---- The removal-time path scan, given the same worktree.
    const rows = await scanAllProcesses(SCAN_TIMEOUT_MS);
    expect(rows.length).toBeGreaterThan(0);
    const scanMatchedPids = findWorktreePathProcesses(rows, worktreeDir, new Set())
      .map((match) => match.pid);

    // The whole point, and it holds on every platform: this process references
    // the worktree ONLY through its cwd, which no scan can match. The tree walk
    // above is the only thing that finds it.
    expect(scanMatchedPids).toEqual([]);

    // ---- The consequence, on the platform where it bites. Windows refuses to
    // remove a directory that is a live process's cwd, which is how the incident
    // turned a leaked dev server into a husk with no git admin entry and then a
    // hung worktree creation. POSIX unlinks a busy directory happily, so there
    // is nothing to assert there.
    if (process.platform === 'win32') {
      expect(() => fs.rmSync(worktreeDir, { recursive: true, force: true })).toThrow();
    }

    // ---- The fix. Reap the captured tree, exactly as a Done move now does.
    const killed = await reapCapturedTree({
      rootPid: wrapper.pid!,
      pids: descendantPids,
      capturedAt: Date.now(),
    });
    expect(killed.length).toBeGreaterThan(0);

    // taskkill returns before the kernel has torn every handle down.
    const goneBy = Date.now() + 10_000;
    while (Date.now() < goneBy && descendantPids.some((pid) => isProcessAlive(pid))) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    expect(descendantPids.filter((pid) => isProcessAlive(pid))).toEqual([]);

    // And now the directory the reap exists to free actually frees. Retried,
    // because Windows drops the cwd handle a beat AFTER the process exits -
    // which is why production removes through `removeWithRetry` rather than a
    // bare rm. Before the reap this loop would exhaust and still throw.
    let removed = false;
    const removeBy = Date.now() + 10_000;
    while (!removed && Date.now() < removeBy) {
      try {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
        removed = true;
      } catch {
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
    }
    expect(removed).toBe(true);
    expect(fs.existsSync(worktreeDir)).toBe(false);
  }, 60_000);
});
