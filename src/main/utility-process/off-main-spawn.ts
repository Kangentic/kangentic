/**
 * `spawnOffMain`: `child_process.spawn` for main-process code. The child starts
 * in the pty host when one is registered, so the spawn's CreateProcess, which
 * on Windows runs on the calling thread (17 to 71 ms on main, and 3,850 ms once
 * during a launch), never holds main. A caller that needs stdin, streamed or
 * binary output, or a stop uses this. A one-shot run read at its end uses
 * `execFileAsync` (`off-main-exec.ts`), and git uses `gitAt`.
 *
 * The child it returns is the part of a `ChildProcess` both routes share
 * (`CliChildProcess`): `spawn`, `error`, `exit` and `close`, Buffers on
 * `stdout` and `stderr`, `stdin.write` and `stdin.end`. A start that fails
 * arrives as `error` then `close` on either route, never as a throw. `stop`
 * ends the run the same way on both (`CliStopMode`).
 *
 * With no host registered (unit tests, a script that loads main's code, startup
 * before the host) the child starts here, and that is the only start this file
 * makes (.claude/rules/main-starts-no-process.md).
 */

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { withoutCrashpadPipeName } from '../shared/child-env';
import { killChildTreeNow, stopChildTree } from '../shared/child-tree-stop';
import { spawnOffMainCli, type CliChildProcess, type CliOutput, type CliStdin, type CliStopMode } from './off-main-cli';

export interface OffMainSpawnOptions {
  cwd: string;
  /** The child's environment, or main's own when omitted. Either way without
   *  Crashpad's pipe name (child-env.ts). */
  env?: NodeJS.ProcessEnv;
  /** Run `command` through the platform shell, as one command line with no `args`. */
  shell?: boolean;
  /** Lead a process group of its own (POSIX), so a tree stop reaches what it started. */
  detached?: boolean;
  /** `ignore` gives the run no pipes: closed stdin, output to nowhere. Piped when omitted. */
  stdio?: 'pipe' | 'ignore';
  /** Windows: false shows the run's console window. Hidden when omitted. */
  windowsHide?: boolean;
  /** The app never stops this run by itself: not at quit, and not when the pty
   *  host is lost. An explicit `stop` still stops it. */
  outlivesApp?: boolean;
  /** A file opened as the run's stdin in place of a pipe, for input of any size. */
  stdinFile?: string;
}

export interface OffMainChild {
  /** The run. `stdin`, `stdout` and `stderr` are always there: with no pipe
   *  behind one, it never emits and a write to it is dropped. */
  readonly child: CliChildProcess;
  /** True when the run is in the pty host. An `error` after its start then
   *  means the host was lost with it running: the run can no longer be
   *  stopped there, and a run that outlives the app is still going. */
  readonly hosted: boolean;
  /** Stop the run: its whole tree with the grace when no mode is given (`CliStopMode`). */
  stop(mode?: CliStopMode): void;
}

/** A stream with no pipe behind it. */
class InertOutput extends EventEmitter implements CliOutput {
  resume(): this {
    return this;
  }
}

class InertStdin extends EventEmitter implements CliStdin {
  write(): boolean {
    return false;
  }

  end(): void {}
}

/**
 * A local child whose stdio is not all pipes, as the shape a hosted run has:
 * the child's own events and state, and an inert stream wherever it has none.
 */
class LocalChild extends EventEmitter implements CliChildProcess {
  readonly stdout: CliOutput;
  readonly stderr: CliOutput;
  readonly stdin: CliStdin;

  constructor(private readonly childProcess: ChildProcess) {
    super();
    this.stdout = childProcess.stdout ?? new InertOutput();
    this.stderr = childProcess.stderr ?? new InertOutput();
    this.stdin = childProcess.stdin ?? new InertStdin();
    childProcess.on('spawn', () => this.emit('spawn'));
    // With no listener an `error` event throws. Such a caller hears of the
    // failure through `close` instead, as it does from a hosted run.
    childProcess.on('error', (error) => {
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    childProcess.on('exit', (code, signal) => this.emit('exit', code, signal));
    childProcess.on('close', (code, signal) => this.emit('close', code, signal));
  }

  get pid(): number | undefined {
    return this.childProcess.pid;
  }

  get exitCode(): number | null {
    return this.childProcess.exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.childProcess.signalCode;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    return this.childProcess.kill(signal);
  }
}

/** A run that could not be started here, reported the way a hosted one is: `error`, then `close`. */
class FailedChild extends EventEmitter implements CliChildProcess {
  readonly pid = undefined;
  readonly exitCode = null;
  readonly signalCode = null;
  readonly stdout = new InertOutput();
  readonly stderr = new InertOutput();
  readonly stdin = new InertStdin();

  constructor(error: Error) {
    super();
    // After the caller has had its turn to attach listeners, as a real child's events are.
    setImmediate(() => {
      if (this.listenerCount('error') > 0) this.emit('error', error);
      this.emit('close', null, null);
    });
  }

  kill(): boolean {
    return false;
  }
}

function spawnHere(command: string, args: readonly string[], options: OffMainSpawnOptions, env: Record<string, string>): OffMainChild {
  const detached = options.detached === true;
  let childProcess: ChildProcess;
  // A file as stdin is opened here and handed to the child, which keeps its
  // own copy: this one is closed as soon as the spawn returns.
  let stdinDescriptor: number | null = null;
  try {
    if (options.stdinFile !== undefined && options.stdio !== 'ignore') stdinDescriptor = fs.openSync(options.stdinFile, 'r');
    const stdio: StdioOptions = options.stdio === 'ignore' ? 'ignore' : [stdinDescriptor ?? 'pipe', 'pipe', 'pipe'];
    childProcess = spawn(command, [...args], {
      cwd: options.cwd,
      env,
      shell: options.shell === true,
      windowsHide: options.windowsHide ?? true,
      stdio,
      ...(detached ? { detached: true } : {}),
    });
  } catch (error) {
    // report-ok: handed to the caller as the run's `error` event, as a hosted run's failed start is.
    return { child: new FailedChild(error instanceof Error ? error : new Error(String(error))), hosted: false, stop: () => undefined };
  } finally {
    if (stdinDescriptor !== null) fs.closeSync(stdinDescriptor);
  }
  // Nothing here waits for a run the app leaves behind.
  if (options.outlivesApp === true) childProcess.unref();
  const treeStop = { leadsGroup: detached };
  return {
    child: new LocalChild(childProcess),
    hosted: false,
    stop: (mode = 'tree') => {
      if (mode === 'process') {
        try {
          childProcess.kill();
        } catch {
          // report-ok: the process is already gone, which is what the stop wanted.
        }
        return;
      }
      if (mode === 'treeNow') killChildTreeNow(childProcess, treeStop);
      else stopChildTree(childProcess, treeStop);
    },
  };
}

export function spawnOffMain(command: string, args: readonly string[], options: OffMainSpawnOptions): OffMainChild {
  const env = withoutCrashpadPipeName(options.env ?? process.env);
  const hosted = spawnOffMainCli(command, [...args], {
    cwd: options.cwd,
    shell: options.shell === true,
    env,
    detached: options.detached === true,
    ...(options.stdio !== undefined ? { stdio: options.stdio } : {}),
    ...(options.windowsHide !== undefined ? { windowsHide: options.windowsHide } : {}),
    ...(options.outlivesApp !== undefined ? { outlivesApp: options.outlivesApp } : {}),
    ...(options.stdinFile !== undefined ? { stdinFile: options.stdinFile } : {}),
  });
  if (!hosted) return spawnHere(command, args, options, env);
  return {
    child: hosted,
    hosted: true,
    stop: (mode) => {
      if (hosted.stopTree) hosted.stopTree(mode);
      else hosted.kill();
    },
  };
}
