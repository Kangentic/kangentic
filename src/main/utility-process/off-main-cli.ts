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
 * An environment as plain data the host can receive: unset entries dropped,
 * since `process.env` types every value `string | undefined` and a structured
 * clone would carry the key with nothing in it.
 */
export function toHostEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}
