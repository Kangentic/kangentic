/**
 * The utility host's spawn service: every child process the host starts for
 * main starts on the spawn worker's thread (`spawn-worker/spawn-worker-entry.ts`),
 * never on the host's own, which carries every terminal's input and output.
 * On Windows CreateProcess holds the thread that calls it, 190 to 454 ms a git
 * start under heavy disk IO (measured 2026-10-25), and on the terminal thread
 * that froze every terminal's echo for as long.
 *
 * - A request (`exec`, the process table) is matched to its answer by id. One
 *   the worker took with it when it died answers as a failed run (`[]` for the
 *   table): its child may have run, so it never runs again here.
 * - A CLI run's events come back as they happened and go to main as they are.
 *   A run the worker took with it ends with `cliError` and `cliClose`, which
 *   main reports as it reports a host loss.
 * - Windows: a tree kill needs the run's pid pinned until its `taskkill` exits
 *   (`child-tree-stop.ts`), and only this thread loads the Windows API, so the
 *   pin is taken here before the stop is sent and released when the worker
 *   reports the taskkill done, or the run closed with no tree kill.
 * - A worker that dies is started again on the next use. Past
 *   `MAX_WORKER_CRASHES`, or if it cannot start at all, the service falls back
 *   to starting children on this thread (`LocalSpawnService`): slower terminals
 *   under load beat no git and no agent CLI runs.
 */

import { recordRelayedSyncSpan } from '../../diagnostics/event-loop-lag';
import { killChildTreeByPid } from '../../shared/child-tree-stop';
import { LocalSpawnService, type HostSpawnService, type ProcessTableProbe, type SpawnServiceHooks } from './host-spawn-service';
import type { HostExecRequest, HostExecResult, PtyHostCliSpawnParams } from './protocol';
import type { FromSpawnWorkerMessage, SpawnWorkerData, ToSpawnWorkerMessage } from './spawn-worker/protocol';
import type { ProcessInfo } from '../../activity-engine/background-shell/process-tree';

/** Worker deaths after which the service starts children on this thread. */
export const MAX_WORKER_CRASHES = 3;
/** A pin held this long is released whatever the worker said: taskkill exits in well under a second. */
const PIN_BACKSTOP_MS = 30_000;

/** The part of a `worker_threads` Worker the service uses, so a test can stand one in. */
export interface SpawnWorkerHandle {
  postMessage(message: ToSpawnWorkerMessage): void;
  on(event: 'message', listener: (message: FromSpawnWorkerMessage) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (exitCode: number) => void): unknown;
  terminate(): unknown;
  unref(): void;
}

export interface WorkerSpawnServiceOptions extends SpawnServiceHooks {
  /** Starts the worker. Throws when it cannot (a missing bundle). */
  createWorker(data: SpawnWorkerData): SpawnWorkerHandle;
  /** Main's executable, which a run may never start. */
  mainExecutable?: string;
  /** Dev builds: a span of 16 ms or more on the worker's thread, labelled `spawn-worker:<label>`. */
  onSlowSpan?: (label: string, ms: number) => void;
  /** The service this one hands over to. `LocalSpawnService` by default. */
  createFallback?: (hooks: SpawnServiceHooks) => HostSpawnService;
}

interface WorkerRun {
  pid: number | null;
  exited: boolean;
}

interface RunPin {
  release: () => void;
  /** The worker reported the tree kill starting, so the pin waits for its end. */
  treeKillRunning: boolean;
  backstop: ReturnType<typeof setTimeout>;
}

export class WorkerSpawnService implements HostSpawnService {
  private worker: SpawnWorkerHandle | null = null;
  private crashes = 0;
  private fallback: HostSpawnService | null = null;
  private nextRequestId = 1;
  private readonly pendingExec = new Map<number, (result: HostExecResult) => void>();
  private readonly pendingTables = new Map<number, (rows: ProcessInfo[]) => void>();
  private readonly runs = new Map<number, WorkerRun>();
  private readonly pins = new Map<number, RunPin>();
  private disposed = false;

  constructor(private readonly options: WorkerSpawnServiceOptions) {
    // Started now, so the first git run of the session does not wait on it.
    this.ensureWorker();
  }

  exec(request: HostExecRequest): Promise<HostExecResult> {
    const worker = this.ensureWorker();
    if (!worker) return this.ensureFallback().exec(request);
    const id = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pendingExec.set(id, resolve);
      this.send(worker, { type: 'exec', id, request });
    });
  }

  processTableProbe(): ProcessTableProbe {
    return {
      listAllProcesses: () => {
        const worker = this.ensureWorker();
        if (!worker) return this.ensureFallback().processTableProbe().listAllProcesses();
        const id = this.nextRequestId++;
        return new Promise<ProcessInfo[]>((resolve) => {
          this.pendingTables.set(id, resolve);
          this.send(worker, { type: 'listProcesses', id });
        });
      },
      dispose: () => {
        if (this.fallback) this.fallback.processTableProbe().dispose();
        if (this.worker) this.send(this.worker, { type: 'disposeProcessTable' });
      },
    };
  }

  startCli(params: PtyHostCliSpawnParams): void {
    const worker = this.ensureWorker();
    if (!worker) {
      this.ensureFallback().startCli(params);
      return;
    }
    this.runs.set(params.processId, { pid: null, exited: false });
    this.send(worker, { type: 'cliSpawn', params });
  }

  writeCli(processId: number, data: string): void {
    if (this.forwardToFallback(processId)) {
      this.fallback?.writeCli(processId, data);
      return;
    }
    if (this.worker) this.send(this.worker, { type: 'cliWrite', processId, data });
  }

  endCliInput(processId: number, data: string | undefined): void {
    if (this.forwardToFallback(processId)) {
      this.fallback?.endCliInput(processId, data);
      return;
    }
    if (this.worker) this.send(this.worker, data === undefined ? { type: 'cliEndInput', processId } : { type: 'cliEndInput', processId, data });
  }

  stopCli(processId: number): void {
    if (this.forwardToFallback(processId)) {
      this.fallback?.stopCli(processId);
      return;
    }
    const run = this.runs.get(processId);
    if (!run || !this.worker) return;
    this.pinBeforeStop(run);
    this.send(this.worker, { type: 'cliStop', processId });
  }

  stopAllCli(): void {
    this.fallback?.stopAllCli();
    if (!this.worker) return;
    for (const run of this.runs.values()) this.pinBeforeStop(run);
    this.send(this.worker, { type: 'cliStopAll' });
  }

  get liveCliCount(): number {
    let count = this.fallback?.liveCliCount ?? 0;
    for (const run of this.runs.values()) if (run.pid !== null && !run.exited) count += 1;
    return count;
  }

  dispose(): void {
    this.disposed = true;
    this.fallback?.dispose();
    const worker = this.worker;
    this.worker = null;
    for (const pid of [...this.pins.keys()]) this.releasePin(pid);
    if (worker) {
      try {
        worker.terminate();
      } catch {
        // Already gone.
      }
    }
  }

  /** A run the fallback started is the fallback's to drive: it never reached the worker. */
  private forwardToFallback(processId: number): boolean {
    return this.fallback !== null && !this.runs.has(processId);
  }

  private ensureFallback(): HostSpawnService {
    this.fallback ??= (this.options.createFallback ?? ((hooks) => new LocalSpawnService(hooks)))({
      emit: this.options.emit,
      pinRun: this.options.pinRun,
    });
    return this.fallback;
  }

  /** The running worker, starting one if none runs; null once the service runs children itself. */
  private ensureWorker(): SpawnWorkerHandle | null {
    if (this.worker) return this.worker;
    if (this.disposed || this.crashes >= MAX_WORKER_CRASHES) return null;
    let worker: SpawnWorkerHandle;
    try {
      worker = this.options.createWorker({
        mainExecutable: this.options.mainExecutable,
        relaySlowSpans: this.options.onSlowSpan !== undefined,
      });
    } catch (error) {
      // A missing bundle does not come back on a retry.
      this.crashes = MAX_WORKER_CRASHES;
      console.warn('[pty-host] the spawn worker could not start; child processes start on the terminal thread:', error instanceof Error ? error.message : String(error));
      return null;
    }
    // The host exits on its own schedule (its shutdown), never held open by this.
    worker.unref();
    worker.on('message', (message) => this.onWorkerMessage(worker, message));
    worker.on('error', (error) => {
      console.warn('[pty-host] the spawn worker failed:', error.message);
    });
    worker.on('exit', (exitCode) => this.onWorkerExit(worker, exitCode));
    this.worker = worker;
    return worker;
  }

  private send(worker: SpawnWorkerHandle, message: ToSpawnWorkerMessage): void {
    try {
      worker.postMessage(message);
    } catch {
      // The worker is exiting; its exit fails what it held.
    }
  }

  private onWorkerMessage(worker: SpawnWorkerHandle, message: FromSpawnWorkerMessage): void {
    if (worker !== this.worker) return;
    switch (message.type) {
      case 'execResult': {
        const resolve = this.pendingExec.get(message.id);
        this.pendingExec.delete(message.id);
        resolve?.(message.result);
        return;
      }
      case 'listProcessesResult': {
        const resolve = this.pendingTables.get(message.id);
        this.pendingTables.delete(message.id);
        resolve?.(message.rows);
        return;
      }
      case 'cliEvent':
        this.trackRun(message.event);
        this.options.emit(message.event);
        return;
      case 'treeKillStarted': {
        const pin = this.pins.get(message.pid);
        if (pin) pin.treeKillRunning = true;
        return;
      }
      case 'treeKillEnded':
        this.releasePin(message.pid);
        return;
      case 'slow-span':
        this.options.onSlowSpan?.(`spawn-worker:${message.label}`, message.ms);
        return;
      case 'log':
        console[message.level](`[spawn-worker] ${message.text}`);
        return;
      default: {
        const unknownMessage: never = message;
        console.warn('[pty-host] unknown spawn worker message:', unknownMessage);
      }
    }
  }

  private trackRun(event: Extract<FromSpawnWorkerMessage, { type: 'cliEvent' }>['event']): void {
    const run = this.runs.get(event.processId);
    if (!run) return;
    switch (event.type) {
      case 'cliSpawned':
        run.pid = event.pid;
        return;
      case 'cliExit':
        run.exited = true;
        return;
      case 'cliClose': {
        run.exited = true;
        this.runs.delete(event.processId);
        // A stop that started no tree kill (the run had already exited, or POSIX) releases here.
        const pin = run.pid === null ? undefined : this.pins.get(run.pid);
        if (run.pid !== null && pin && !pin.treeKillRunning) this.releasePin(run.pid);
        return;
      }
      default:
        return;
    }
  }

  /** Windows: hold the run's pid from before the stop is sent until its taskkill exits. */
  private pinBeforeStop(run: WorkerRun): void {
    if (run.pid === null || run.exited || this.pins.has(run.pid)) return;
    const pid = run.pid;
    const release = this.options.pinRun(pid);
    if (!release) return;
    const backstop = setTimeout(() => this.releasePin(pid), PIN_BACKSTOP_MS);
    backstop.unref?.();
    this.pins.set(pid, { release, treeKillRunning: false, backstop });
  }

  private releasePin(pid: number): void {
    const pin = this.pins.get(pid);
    if (!pin) return;
    this.pins.delete(pid);
    clearTimeout(pin.backstop);
    try {
      pin.release();
    } catch {
      // The handle is the host's own; nothing else holds it.
    }
  }

  private onWorkerExit(worker: SpawnWorkerHandle, exitCode: number): void {
    if (worker !== this.worker) return;
    this.worker = null;
    if (this.disposed) return;
    this.crashes += 1;
    console.warn(`[pty-host] the spawn worker exited (code ${exitCode}); ${this.crashes >= MAX_WORKER_CRASHES ? 'child processes start on the terminal thread from now on' : 'it starts again on the next use'}`);
    const lost = 'The pty host spawn worker exited';
    for (const resolve of this.pendingExec.values()) {
      resolve({ ok: false, error: { message: lost, exitCode: null, killed: false, signal: null, stdout: '', stderr: '' } });
    }
    this.pendingExec.clear();
    for (const resolve of this.pendingTables.values()) resolve([]);
    this.pendingTables.clear();
    for (const pid of [...this.pins.keys()]) this.releasePin(pid);
    for (const [processId, run] of this.runs) {
      // The run's process belongs to this process, not to the thread that
      // died, so it is still running with nothing reading it. Its tree is
      // stopped by pid, as main stops a run a lost host left behind.
      if (run.pid !== null && !run.exited) killChildTreeByPid(run.pid);
      this.options.emit({ type: 'cliError', processId, error: { message: lost } });
      this.options.emit({ type: 'cliClose', processId, code: null, signal: null });
    }
    this.runs.clear();
  }
}

/** Count a worker's slow span in the host's relayed ring and hand it to `relay` (main). */
export function relayWorkerSpan(relay: (label: string, ms: number) => void): (label: string, ms: number) => void {
  return (label, ms) => {
    recordRelayedSyncSpan(label, ms);
    relay(label, ms);
  };
}
