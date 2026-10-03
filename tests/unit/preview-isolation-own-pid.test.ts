/**
 * `findOtherPreviewInstances` ignores a PID file that holds the calling
 * process's own pid (scripts/preview-isolation.js).
 *
 * dev.js writes `.kangentic/preview-<port>.pid` for itself and the launcher
 * refuses a second preview of a worktree by listing the OTHER live previews. A
 * PID file naming the current process is the preview itself, not another one,
 * and it is always alive, so without the `pid === process.pid` skip the caller
 * would find itself and refuse to start beside its own PID file. The sibling
 * cases in preview-isolation.test.ts all use a spawned child's pid, so none of
 * them exercises that skip.
 *
 * Real files under a temp directory and a real live child as the positive
 * control, so an empty result cannot be an artifact of pointing at the wrong
 * directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

// CJS script (run by node directly, not bundled), loaded the way preview-isolation.test.ts does.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { findOtherPreviewInstances, isProcessAlive } = require('../../scripts/preview-isolation.js') as {
  findOtherPreviewInstances: (worktreeDir: string) => Array<{ port: number; pid: number; shuttingDown: boolean }>;
  isProcessAlive: (pid: number) => boolean;
};

const OWN_PORT = 5198;
const OTHER_PORT = 5199;

let worktreeDir: string;
let idleProcess: ChildProcess | null = null;

beforeEach(() => {
  worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-own-pid-'));
  fs.mkdirSync(path.join(worktreeDir, '.kangentic'));
});

afterEach(async () => {
  if (idleProcess) {
    const exited = new Promise<void>((resolve) => {
      if (idleProcess!.exitCode !== null || idleProcess!.signalCode !== null) resolve();
      else idleProcess!.once('exit', () => resolve());
    });
    idleProcess.kill();
    await exited;
    idleProcess = null;
  }
  await fs.promises.rm(worktreeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function writePidFile(port: number, pid: number): void {
  fs.writeFileSync(path.join(worktreeDir, '.kangentic', `preview-${port}.pid`), String(pid));
}

describe('findOtherPreviewInstances and the current process', () => {
  it('skips a PID file holding its own pid, which is always alive', () => {
    writePidFile(OWN_PORT, process.pid);

    expect(findOtherPreviewInstances(worktreeDir)).toEqual([]);
  });

  it('still reports another live preview listed beside its own PID file', () => {
    idleProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
    writePidFile(OWN_PORT, process.pid);
    writePidFile(OTHER_PORT, idleProcess.pid!);

    expect(findOtherPreviewInstances(worktreeDir)).toEqual([
      { port: OTHER_PORT, pid: idleProcess.pid, shuttingDown: false },
    ]);
  });
});

describe('a pid this user cannot signal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads as stale, so a reused pid owned by someone else never blocks a launch', () => {
    // A preview's dev.js always runs as the developer, so EPERM means the pid
    // was reused by another user's process. worktree-preview.js's --stop and
    // the launcher's refusal share this one check.
    const foreignPid = 424242;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    writePidFile(OTHER_PORT, foreignPid);

    expect(isProcessAlive(foreignPid)).toBe(false);
    expect(findOtherPreviewInstances(worktreeDir)).toEqual([]);
  });
});
