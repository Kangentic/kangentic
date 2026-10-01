/**
 * `spawnOffMainCli`: an agent CLI's headless run (an Ask answer, a task
 * summary, an auto-name, a warm answer session) started in the pty host when
 * one is registered. On Windows libuv runs CreateProcess synchronously on the
 * calling thread, and these runs come in bursts: the summary backfill spawned
 * the CLI 39 times in 100 s, 13 to 67 ms each on main.
 *
 * The run is a command, not a request, so the handle comes back at once, as
 * `child_process.spawn`'s does, and a spawn that fails in the host reaches it
 * as an `error` event. Once posted it never falls back to a local spawn: a
 * second run would be a second paid answer. With no spawner registered (unit
 * tests, startup before the host exists) the caller spawns locally.
 */

import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';

/** A run's stdout or stderr: `data` events carrying Buffers. */
export interface CliOutput extends EventEmitter {
  /** Drain without a `data` listener (a run whose output nobody reads). */
  resume(): unknown;
}

/** The stdin half the CLI runs use: write the prompt, then end it. */
export interface CliStdin extends EventEmitter {
  write(chunk: string): boolean;
  end(chunk?: string): void;
}

/**
 * The part of `ChildProcessWithoutNullStreams` the CLI runs use. A local
 * child process satisfies it as it is; `RemoteCliProcess` (`pty-host-client.ts`)
 * is the host's.
 *
 * Events, as `child_process` emits them: `spawn`, `error`, `exit` (code,
 * signal), then `close` (code, signal) once stdio has ended, after the last
 * `data` on `stdout` and `stderr` (Buffers).
 */
export interface CliChildProcess extends EventEmitter {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: CliOutput;
  readonly stderr: CliOutput;
  readonly stdin: CliStdin;
  kill(signal?: NodeJS.Signals | number): boolean;
  /** A process running elsewhere stops its own tree (`stopCli`). */
  stopTree?(): void;
}

export interface OffMainCliOptions {
  cwd: string;
  /** Run through the platform shell: a Windows `.cmd` or `.bat` shim. */
  shell: boolean;
  /** The whole environment the child gets. */
  env: Record<string, string>;
  /** Lead a process group of its own (POSIX), so a stop reaches its children. */
  detached: boolean;
}

export type OffMainCliSpawner = (command: string, args: string[], options: OffMainCliOptions) => CliChildProcess;

let spawner: OffMainCliSpawner | null = null;

export function setOffMainCliSpawner(next: OffMainCliSpawner | null): void {
  spawner = next;
}

/** The run in the pty host, or null when no host is registered (spawn locally). */
export function spawnOffMainCli(command: string, args: string[], options: OffMainCliOptions): CliChildProcess | null {
  return spawner ? spawner(command, args, options) : null;
}

/**
 * Stop a host run's CLI tree from main, by pid, for the two moments the host
 * cannot be relied on to do it: the host died (its pipes went with it, but on
 * Windows a child outlives its parent), or the app is quitting (main may exit,
 * and the host be torn down, before the host reads its `cliStop`). A second
 * stop of a tree the host also stops is harmless. `taskkill /T /F` on Windows;
 * on POSIX the run leads its own process group, which gets SIGKILL.
 */
export function stopCliTreeByPid(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
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
