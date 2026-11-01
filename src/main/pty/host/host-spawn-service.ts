/**
 * How the pty host starts the child processes it runs for main: the one-shot
 * runs (`exec`), the agent CLI runs (`cliSpawn` and the rest), and the process
 * table's `ps` / PowerShell probe. The core reaches them only through this
 * interface, so where they start is the host's choice:
 *
 * - `WorkerSpawnService` (`worker-spawn-service.ts`), the utility host's: every
 *   start runs on the spawn worker's thread, never on the thread that carries
 *   terminal input and output.
 * - `LocalSpawnService` (below): on the calling thread. The in-process core
 *   uses it (the unit tests' host, and the fallback after repeated host
 *   crashes, where every terminal already runs on main's loop), and so does the
 *   utility host if its worker cannot start.
 */

import type { spawn } from 'node:child_process';
import { createProcessTreeProbe, type ProcessTreeProbe } from '../../activity-engine/background-shell/process-tree';
import { childProcessEnv } from '../../shared/child-env';
import { HostCliProcesses } from './host-cli-processes';
import { runHostExec } from './host-exec';
import type { ToolFailureCause, ToolRunner } from '../process-tag/process-scan';
import type { HostExecFailure, HostExecRequest, HostExecResult, PtyHostCliSpawnParams, PtyHostEvent } from './protocol';

/** The part of a process-tree probe the process table reads (`host-process-table.ts`). */
export type ProcessTableProbe = Pick<ProcessTreeProbe, 'listAllProcesses' | 'dispose'>;

export interface HostSpawnService {
  /** Run a one-shot child process (`host-exec.ts`). Never rejects. */
  exec(request: HostExecRequest): Promise<HostExecResult>;
  /** The `ps` / PowerShell process-table probe, created on first use. */
  processTableProbe(): ProcessTableProbe;
  startCli(params: PtyHostCliSpawnParams): void;
  writeCli(processId: number, data: string): void;
  endCliInput(processId: number, data: string | undefined): void;
  stopCli(processId: number): void;
  /** The host is quitting: stop every run still going. */
  stopAllCli(): void;
  /** Runs whose process started and has not exited yet. */
  readonly liveCliCount: number;
  /** Release what the service holds (the worker). */
  dispose(): void;
}

/**
 * How a failed run ended, as a fixed value. The order matters: a run past its
 * timeout has a signal too, and only execFile's own timer sets `killed`. The
 * last branch is a child that never started, a run the spawn worker took with
 * it when it died, and the host's refusal to start its own executable: none of
 * those has an exit code, a signal or a kill. The errno and the signal name
 * stop here.
 */
function toolFailureCauseOf(failure: HostExecFailure): ToolFailureCause {
  if (failure.killed) return 'timeout';
  if (failure.signal !== null) return 'signal';
  if (failure.exitCode !== null) return 'exit_code';
  return 'spawn_error';
}

/**
 * A tool's stdout through `service`, or how it failed: it could not start,
 * exited with an error or a signal, or ran past `timeoutMs` (then killed with
 * SIGKILL), as `darwin-reader.ts`'s `runTool` answers. The utility host's macOS
 * reap runs `lsappinfo` this way, so every start, a retry's included, lands on
 * the spawn worker.
 */
export function runToolThrough(service: HostSpawnService): ToolRunner {
  return async (command, args, timeoutMs) => {
    const result = await service.exec({
      kind: 'execFile',
      file: command,
      args,
      // `runTool` read stdout with no cap; execFile's default 1 MiB would fail a
      // long `lsappinfo` listing and read as the tool being unavailable.
      options: { env: childProcessEnv({ LC_ALL: 'C' }), timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    });
    return result.ok ? { ok: true, output: result.stdout } : { ok: false, cause: toolFailureCauseOf(result.error) };
  };
}

/** What a spawn service hands back to the core. */
export interface SpawnServiceHooks {
  /** A CLI run's events, for main. */
  emit(event: PtyHostEvent): void;
  /** Windows: pin a CLI run's pid while its tree kill runs (`child-tree-stop.ts`). */
  pinRun(pid: number): (() => void) | null;
}

export class LocalSpawnService implements HostSpawnService {
  private readonly cliProcesses: HostCliProcesses;
  private probe: ProcessTreeProbe | null = null;

  constructor(
    hooks: SpawnServiceHooks,
    private readonly options: { spawnChild?: typeof spawn; createProbe?: () => ProcessTreeProbe } = {},
  ) {
    this.cliProcesses = new HostCliProcesses((event) => hooks.emit(event), options.spawnChild, undefined, (pid) => hooks.pinRun(pid));
  }

  exec(request: HostExecRequest): Promise<HostExecResult> {
    return runHostExec(request);
  }

  processTableProbe(): ProcessTableProbe {
    return {
      listAllProcesses: () => {
        this.probe ??= (this.options.createProbe ?? createProcessTreeProbe)();
        return this.probe.listAllProcesses();
      },
      dispose: () => {
        this.probe?.dispose();
        this.probe = null;
      },
    };
  }

  startCli(params: PtyHostCliSpawnParams): void {
    this.cliProcesses.start(params);
  }

  writeCli(processId: number, data: string): void {
    this.cliProcesses.write(processId, data);
  }

  endCliInput(processId: number, data: string | undefined): void {
    this.cliProcesses.endInput(processId, data);
  }

  stopCli(processId: number): void {
    this.cliProcesses.stop(processId);
  }

  stopAllCli(): void {
    this.cliProcesses.stopAll();
  }

  get liveCliCount(): number {
    return this.cliProcesses.liveCount;
  }

  dispose(): void {
    this.probe?.dispose();
    this.probe = null;
  }
}
