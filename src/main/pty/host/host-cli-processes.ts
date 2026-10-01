/**
 * The pty host's agent CLI runs: `off-main-cli.ts` on main's side, where
 * `spawnCli` starts every headless run (an Ask answer, a task summary, an
 * auto-name, a warm answer session). On Windows libuv runs CreateProcess
 * synchronously on the calling thread, 13 to 67 ms a run measured on main
 * during the summary backfill, so the runs start here instead.
 *
 * Output goes back as it arrives (`cliData`, in order, then `cliExit` and
 * `cliClose`), so a streamed answer still streams. A stop takes the CLI's
 * whole tree, as `stopCli` did on main: a `.cmd` shim runs the CLI as a child
 * of cmd.exe, and a POSIX wrapper script starts node under it.
 *
 * It never launches this process's own executable: with the RunAsNode fuse
 * off, a packaged Kangentic.exe started as a child boots a second app.
 * `tests/unit/pty-host-boundary.test.ts` pins that, as it does for `host-exec.ts`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import { launchesOwnBinary } from './host-exec';
import { toPtyHostError, type PtyHostCliSpawnParams, type PtyHostEvent } from './protocol';

/** How long a CLI stopped with SIGTERM has to exit before it gets SIGKILL. */
const CLI_KILL_GRACE_MS = 1_000;

interface CliRun {
  child: ChildProcessWithoutNullStreams;
  /** Leads its own process group (POSIX), so a stop signals the group. */
  leadsGroup: boolean;
  /** A Windows tree kill was started; a second would be a wasted spawn. */
  treeKillStarted: boolean;
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return typeof child.exitCode === 'number' || typeof child.signalCode === 'string';
}

export class HostCliProcesses {
  private readonly runs = new Map<number, CliRun>();

  constructor(
    private readonly emit: (event: PtyHostEvent) => void,
    private readonly spawnChild: typeof spawn = spawn,
    /** This process's executable, which a run may never start. */
    private readonly ownExecutable: string = process.execPath,
  ) {}

  start(params: PtyHostCliSpawnParams): void {
    const { processId } = params;
    const ownBinary = params.shell
      ? launchesOwnBinary({ kind: 'exec', command: params.command, options: {} }, this.ownExecutable)
      : launchesOwnBinary({ kind: 'execFile', file: params.command, args: params.args, options: {} }, this.ownExecutable);
    if (ownBinary) {
      this.failToStart(processId, new Error('The pty host does not launch its own executable'));
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      // Labelled: this is the cost moved here from main, paid on the thread
      // that also carries terminal output.
      child = timeSyncWork('cli:spawn', () => this.spawnChild(params.command, params.args, {
        cwd: params.cwd,
        shell: params.shell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: params.env,
        ...(params.detached ? { detached: true } : {}),
      }));
    } catch (error) {
      this.failToStart(processId, error);
      return;
    }
    this.runs.set(processId, { child, leadsGroup: params.detached, treeKillStarted: false });
    child.once('spawn', () => this.emit({ type: 'cliSpawned', processId, pid: child.pid ?? null }));
    child.stdout.on('data', (chunk: Buffer) => this.emit({ type: 'cliData', processId, stream: 'stdout', data: chunk }));
    child.stderr.on('data', (chunk: Buffer) => this.emit({ type: 'cliData', processId, stream: 'stderr', data: chunk }));
    // A CLI that exits before reading its stdin closes the pipe under a long
    // prompt, and the write fails as an EPIPE event; `cliExit` reports it.
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => this.emit({ type: 'cliError', processId, error: toPtyHostError(error) }));
    child.on('exit', (code, signal) => this.emit({ type: 'cliExit', processId, code, signal }));
    child.on('close', (code, signal) => {
      this.runs.delete(processId);
      this.emit({ type: 'cliClose', processId, code, signal });
    });
  }

  write(processId: number, data: string): void {
    const run = this.runs.get(processId);
    if (!run) return;
    try {
      run.child.stdin.write(data);
    } catch {
      // The stdin pipe is already closed; the exit reports why.
    }
  }

  endInput(processId: number, data: string | undefined): void {
    const run = this.runs.get(processId);
    if (!run) return;
    try {
      if (data === undefined) run.child.stdin.end();
      else run.child.stdin.end(data);
    } catch {
      // As above.
    }
  }

  stop(processId: number): void {
    const run = this.runs.get(processId);
    if (run) this.stopRun(run);
  }

  /** The app is quitting: stop every run still going. */
  stopAll(): void {
    for (const run of this.runs.values()) this.stopRun(run);
  }

  /** Runs whose process started and has not exited yet. */
  get liveCount(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (run.child.pid !== undefined && !hasExited(run.child)) count += 1;
    }
    return count;
  }

  /** A spawn that threw, or was refused: reported the way a failed start is. */
  private failToStart(processId: number, error: unknown): void {
    this.emit({ type: 'cliError', processId, error: toPtyHostError(error) });
    this.emit({ type: 'cliClose', processId, code: null, signal: null });
  }

  /**
   * Stop a run and what it started. On Windows `taskkill /T /F` takes the
   * whole tree. On POSIX the run leads its own process group, which gets
   * SIGTERM, then SIGKILL if it has not exited within the grace.
   */
  private stopRun(run: CliRun): void {
    const { child } = run;
    if (hasExited(child)) return;
    if (process.platform === 'win32' && child.pid) {
      if (run.treeKillStarted) return;
      run.treeKillStarted = true;
      this.spawnChild('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => undefined)
        .unref();
      return;
    }
    this.signal(run, 'SIGTERM');
    setTimeout(() => {
      if (!hasExited(child)) this.signal(run, 'SIGKILL');
    }, CLI_KILL_GRACE_MS).unref();
  }

  private signal(run: CliRun, signal: NodeJS.Signals): void {
    if (run.leadsGroup && run.child.pid) {
      try {
        process.kill(-run.child.pid, signal);
        return;
      } catch {
        // The group is gone already: try the CLI itself.
      }
    }
    try {
      run.child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}
