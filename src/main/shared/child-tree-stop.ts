/**
 * Stopping a child process and everything it started. The agent CLI runs:
 * `stopCli` in `agent/shared/cli-print.ts` (a local run), the pty host's
 * `host-cli-processes.ts` (a run in the host), and main's backstop by pid when
 * the host died or the app is quitting (`stopAllCliRuns`, `pty-host-client.ts`).
 * And main's own children that time out or are aborted: git through
 * `git/spawn-with-abort.ts` (the init script among them), a run-script
 * automation, and the project search's git.
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
 *
 * A Windows process keeps its parent's pid after the parent exits, and Windows
 * hands that pid to new processes. A tree kill that follows recorded parent
 * pids without comparing creation times therefore takes a stranger's tree as
 * soon as a process in the tree it was asked for holds that pid. Measured on
 * Windows 11 Pro build 26200, 2026-10-21, with
 * `scripts/probe-taskkill-stale-parent.mjs`: in two runs the orphan's dead
 * parent's pid came back after 359 and 1,035 process starts (12 and 11 s), and
 * both times the orphan survived `taskkill /PID <new owner> /T /F`, which
 * killed the new owner and its console host. taskkill adds a process to the
 * tree only when it was created after the parent it names.
 * Every Kangentic tree stop rests on that, and
 * `tests/unit/taskkill-stale-parent.test.ts` reruns the probe on Windows CI.
 * `tests/unit/process-kill-sites.test.ts` keeps every tree kill in the
 * classified files, on `taskkill /T`, and fails on a tree-kill package.
 *
 * The fact covers what taskkill finds under the pid, not the pid itself.
 * `taskkill /PID X` ends whatever holds X when it opens it, about 550 ms after
 * the spawn (measured, median of 10). So a stop names a child's pid only while
 * something pins it:
 * - A local child (`stopChildTree`, `killChildTreeNow`) is stopped only while
 *   Node has not handled its exit. Until then libuv holds the process handle,
 *   and Windows does not reuse a pid while a handle to its process is open.
 *   The run can still exit by itself and lose that pin inside taskkill's start.
 *   Reusing one given pid took 359 to 1,035 process starts in the probe, so
 *   that needs hundreds of starts within half a second.
 * - The pty host's runs pass `pinRoot`, a handle of the host's own, held until
 *   taskkill has exited, which closes that window.
 * - `killChildTreeByPid` holds nothing. It runs after the pty host died, or
 *   at quit, when no handle on the run survives anywhere.
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
  /** Windows: opens a handle of the caller's own on the child and answers
   *  what closes it, or null. Held until `taskkill` exits, so the pid cannot
   *  change hands before taskkill opens it (see the header). */
  readonly pinRoot?: (pid: number) => (() => void) | null;
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

/** `taskkill /T /F` of `pid`, calling `unpin` once taskkill has exited or failed to start. */
function spawnTreeKill(pid: number, spawnProcess: typeof spawn, unpin: (() => void) | null = null): void {
  let unpinned = false;
  const release = (): void => {
    if (unpinned) return;
    unpinned = true;
    unpin?.();
  };
  try {
    spawnProcess('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      .on('error', release)
      .on('exit', release)
      .unref();
  } catch (error) {
    release();
    throw error;
  }
}

/** A Windows tree kill of a child that has not exited, once per latch, pinned when the caller can pin. */
function startTreeKill(pid: number, options: ChildTreeStopOptions): void {
  const latch = options.treeKillLatch;
  if (latch) {
    if (latch.treeKillStarted) return;
    latch.treeKillStarted = true;
  }
  spawnTreeKill(pid, options.spawnProcess ?? spawn, options.pinRoot?.(pid) ?? null);
}

/** Stop a child and what it started: `taskkill /T /F` on Windows, the group's
 *  SIGTERM then SIGKILL after `TREE_STOP_GRACE_MS` on POSIX. */
export function stopChildTree(child: StoppableChild, options: ChildTreeStopOptions): void {
  if (childHasExited(child)) return;
  if (process.platform === 'win32' && child.pid) {
    startTreeKill(child.pid, options);
    return;
  }
  signalChildOrGroup(child, options.leadsGroup, 'SIGTERM');
  setTimeout(() => {
    if (!childHasExited(child)) signalChildOrGroup(child, options.leadsGroup, 'SIGKILL');
  }, TREE_STOP_GRACE_MS).unref();
}

/**
 * Stop a local child and what it started at once, with no grace: a run that
 * timed out or was aborted. Windows: `taskkill /T /F`, only while the child
 * has not exited. After the exit Node no longer pins its pid, and taskkill
 * could not reach what it started through it anyway (see the header). POSIX:
 * SIGKILL to the child's group, else the child, even after it exited: a group's
 * id is not handed out again while any member lives.
 */
export function killChildTreeNow(child: StoppableChild, options: ChildTreeStopOptions): void {
  if (process.platform === 'win32') {
    if (!childHasExited(child) && child.pid) startTreeKill(child.pid, options);
    return;
  }
  signalChildOrGroup(child, options.leadsGroup, 'SIGKILL');
}

/**
 * Stop a tree by pid at once, holding no handle and giving no grace: the
 * moments a run's own stop cannot be relied on (its host died, or the app is
 * quitting and may exit before the host reads the stop). `taskkill /T /F` on
 * Windows; on POSIX SIGKILL to the group, else to the process. Nothing pins
 * the pid here (see the header), so a caller with a child handle uses
 * `stopChildTree` or `killChildTreeNow` instead.
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
