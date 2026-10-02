/**
 * Stopping a child process and everything it started, for the agent CLI runs:
 * `stopCli` in `agent/shared/cli-print.ts` (a local run), the pty host's
 * `host-cli-processes.ts` (a run in the host), and main's backstop by pid when
 * the host died or the app is quitting (`stopAllCliRuns`, `pty-host-client.ts`).
 *
 * A `.cmd` shim runs the CLI as a child of cmd.exe, so killing cmd.exe left the
 * CLI running with its working directory and every file it was handed by path,
 * a live MCP token among them. Any other Windows CLI can start children of its
 * own too, and `child.kill` there ends one process with no grace either way, so
 * on Windows `taskkill /T /F` takes the whole tree. On POSIX a CLI can be a
 * wrapper too (a shell script that starts node), so the CLI leads its own
 * process group and the group gets the signal: SIGTERM, then SIGKILL if it has
 * not exited within the grace. Exit is read from the exit code and signal, not
 * `child.killed`, which turns true when a signal is SENT and so never let the
 * SIGKILL fire.
 *
 * It imports nothing but `spawn`: the pty host bundles it, and
 * `tests/unit/pty-host-boundary.test.ts` keeps main-only modules out of that
 * bundle.
 */

import { spawn } from 'node:child_process';

/** How long a child stopped with SIGTERM has to exit before it gets SIGKILL. */
export const TREE_STOP_GRACE_MS = 1_000;

/** What a stop needs of a child: a local `ChildProcess` and a host run both fit. */
export interface StoppableChild {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ChildTreeStopOptions {
  /** POSIX: the child leads its own process group, which gets the signal. */
  readonly leadsGroup: boolean;
  /** What starts `taskkill`: the pty host passes its injectable spawn. */
  readonly spawnProcess?: typeof spawn;
  /** Windows: set once a tree kill has started, so a second stop of the same
   *  child spawns no second `taskkill`. Omitted, every stop spawns one. */
  readonly treeKillLatch?: { treeKillStarted: boolean };
}

export function childHasExited(child: StoppableChild): boolean {
  return typeof child.exitCode === 'number' || typeof child.signalCode === 'string';
}

/** Signal the child's process group when it leads one, else the child itself. */
export function signalChildOrGroup(child: StoppableChild, leadsGroup: boolean, signal: NodeJS.Signals): void {
  if (leadsGroup && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is gone already, or cannot be signalled: try the child itself.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

function spawnTreeKill(pid: number, spawnProcess: typeof spawn): void {
  spawnProcess('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    .on('error', () => undefined)
    .unref();
}

/** Stop a child and what it started: `taskkill /T /F` on Windows, the group's
 *  SIGTERM then SIGKILL after `TREE_STOP_GRACE_MS` on POSIX. */
export function stopChildTree(child: StoppableChild, options: ChildTreeStopOptions): void {
  if (childHasExited(child)) return;
  if (process.platform === 'win32' && child.pid) {
    const latch = options.treeKillLatch;
    if (latch) {
      if (latch.treeKillStarted) return;
      latch.treeKillStarted = true;
    }
    spawnTreeKill(child.pid, options.spawnProcess ?? spawn);
    return;
  }
  signalChildOrGroup(child, options.leadsGroup, 'SIGTERM');
  setTimeout(() => {
    if (!childHasExited(child)) signalChildOrGroup(child, options.leadsGroup, 'SIGKILL');
  }, TREE_STOP_GRACE_MS).unref();
}

/**
 * Stop a tree by pid at once, holding no handle and giving no grace: the
 * moments a run's own stop cannot be relied on (its host died, or the app is
 * quitting and may exit before the host reads the stop). `taskkill /T /F` on
 * Windows; on POSIX SIGKILL to the group, else to the process.
 */
export function killChildTreeByPid(pid: number, spawnProcess: typeof spawn = spawn): void {
  try {
    if (process.platform === 'win32') {
      spawnTreeKill(pid, spawnProcess);
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}
