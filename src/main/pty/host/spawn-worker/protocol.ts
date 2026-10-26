/**
 * The messages between the pty host's terminal thread and its spawn worker
 * (`spawn-worker-entry.ts`), the `worker_threads` Worker that starts every
 * child process the host runs for main.
 *
 * On Windows libuv runs CreateProcess synchronously on the calling thread, and
 * under heavy disk IO one start took 190 to 454 ms (a worktree create beside an
 * `npm ci`, 2026-10-25). On the terminal thread that froze the echo of every
 * terminal for as long. In the worker it holds only the worker.
 *
 * Every field is plain data: the worker port structured-clones it.
 */

import type { ProcessInfo } from '../../../activity-engine/background-shell/process-tree';
import type { HostExecRequest, HostExecResult, PtyHostCliSpawnParams, PtyHostEvent } from '../protocol';

/** What the worker is given when it starts (`workerData`). */
export interface SpawnWorkerData {
  /** Main's executable, which a run may never start (`host-exec.ts`). */
  mainExecutable?: string;
  /** Dev builds: relay spans of 16 ms or more, for the lag report. */
  relaySlowSpans: boolean;
}

/** Terminal thread to worker. */
export type ToSpawnWorkerMessage =
  | { type: 'exec'; id: number; request: HostExecRequest }
  /** The process table from the `ps` / PowerShell probe (`process-tree.ts`). */
  | { type: 'listProcesses'; id: number }
  /** End the probe's persistent PowerShell child, if one runs. */
  | { type: 'disposeProcessTable' }
  | { type: 'cliSpawn'; params: PtyHostCliSpawnParams }
  | { type: 'cliWrite'; processId: number; data: string }
  | { type: 'cliEndInput'; processId: number; data?: string }
  | { type: 'cliStop'; processId: number }
  /** The host is quitting: stop every run still going. */
  | { type: 'cliStopAll' };

/** Worker to terminal thread. */
export type FromSpawnWorkerMessage =
  | { type: 'execResult'; id: number; result: HostExecResult }
  | { type: 'listProcessesResult'; id: number; rows: ProcessInfo[] }
  /**
   * A run's `cliSpawned`, `cliData`, `cliError`, `cliExit` or `cliClose`, for
   * main as it is. Each one is cloned here and again on its way to main: a
   * stream chunk may share a pooled buffer, so transferring it would cost the
   * same copy.
   */
  | { type: 'cliEvent'; event: Extract<PtyHostEvent, { type: `cli${string}` }> }
  /** A run's pid, posted in the turn its spawn returned, ahead of its
   *  `cliSpawned`. The terminal thread's own, never forwarded to main. */
  | { type: 'cliStarted'; processId: number; pid: number }
  /**
   * A Windows tree kill of a run's pid started, and later its `taskkill`
   * exited. The terminal thread pinned the pid before it sent the stop and
   * holds the pin until the second (`child-tree-stop.ts`), since only that
   * thread holds the Windows API.
   */
  | { type: 'treeKillStarted'; pid: number }
  | { type: 'treeKillEnded'; pid: number }
  /** A span of 16 ms or more on the worker's thread (dev builds only). */
  | { type: 'slow-span'; label: string; ms: number }
  /** A console line, which the terminal thread hands on to main's log. */
  | { type: 'log'; level: 'log' | 'info' | 'warn' | 'error'; text: string };
