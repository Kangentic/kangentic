/**
 * Real processes, no mocks: aborting a Post-Worktree Script must stop what the
 * script started, not only the shell that ran it.
 *
 * Before the fix, spawnWithAbort aborted through Node's `signal` option, which
 * kills the direct child only. On Windows that is cmd.exe, so a script's child
 * (an `npm install`) kept running in the worktree and held it open; in /preview
 * the next creation at that path stalled 12 s until the leftover exited. On
 * POSIX the same happens when `sh -c` forks, which the `&&` below forces.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInitScript } from '../../src/main/git/run-init-script';

const createdDirectories: string[] = [];
const startedPids: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid the script's grandchild wrote, once the file holds a whole one. */
function readPid(pidFile: string): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * On Windows a killed process's handle on its cwd can outlive taskkill, and
 * under a full test run's load by well over the second Node's own retry ladder
 * gave it (seen failing with EPERM at the end of a passing test). So the
 * retries are driven here against a clock, with `maxRetries: 0`: Node's ladder
 * compounds per path and has no wall-clock bound. A holder still there after
 * the deadline is a real leftover, and the cleanup throws.
 */
async function removeWithDeadline(directory: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

afterEach(async () => {
  for (const pid of startedPids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const directory of createdDirectories.splice(0)) {
    await removeWithDeadline(directory, 15_000);
  }
}, 20_000);

describe('runInitScript abort, real processes', () => {
  it('stops the process the script started, not only the shell', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tree-kill-'));
    createdDirectories.push(directory);
    const pidFile = path.join(directory, 'grandchild.pid');
    const node = `"${process.execPath}"`;
    // The first command records its pid and sleeps; `&&` makes `sh -c` fork it
    // rather than exec it, so on every platform it is a grandchild of the run.
    const script = `${node} -e "require('fs').writeFileSync('grandchild.pid', String(process.pid)); setTimeout(() => {}, 60000)" && ${node} -e ""`;
    const controller = new AbortController();

    const run = runInitScript(script, directory, { timeoutMs: 120_000, signal: controller.signal });
    const settled = run.catch((error: Error) => error);
    await expect.poll(() => readPid(pidFile), { timeout: 15_000, interval: 50 }).not.toBeNull();
    const grandchildPid = readPid(pidFile)!;
    startedPids.push(grandchildPid);
    expect(isAlive(grandchildPid)).toBe(true);

    controller.abort();

    expect(String(await settled)).toMatch(/external abort/);
    await expect.poll(() => isAlive(grandchildPid), { timeout: 10_000, interval: 100 }).toBe(false);
    // Gone, so the cleanup must not kill its pid: Windows hands a freed pid to
    // the next process soon, and under a full run's load that was a vitest
    // worker, which the cleanup's SIGKILL then took down mid-file.
    startedPids.splice(startedPids.indexOf(grandchildPid), 1);
  }, 30_000);
});
