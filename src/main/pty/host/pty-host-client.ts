/**
 * Main's side of the pty host: the handle a session row holds for its PTY, and
 * the client that talks to the host through a transport.
 *
 * The transport is either the `kangentic-pty-host` utility process
 * (`utility-pty-host-transport.ts`, production) or the same `PtyHostCore`
 * running in this process (`InProcessPtyHostTransport`, unit tests), so both
 * paths run the one core and the one protocol.
 */

import { EventEmitter } from 'node:events';
import type { AgentParser } from '../../../shared/types';
import { PTY_HOST_LOST_EXIT_CODE } from '../../../shared/pty-host';
import type { TranscriptSink } from '../buffer/transcript-writer';
import { HostUnavailableError, type OffMainPty, type OffMainPtyOptions } from '../../utility-process/off-main-pty';
import type { CliChildProcess, CliStdin, OffMainCliOptions } from '../../utility-process/off-main-cli';
import { killChildTreeByPid } from '../../shared/child-tree-stop';
import { PtyHostCore } from './pty-host-core';
import {
  fromPtyHostError,
  type HostExecRequest,
  type HostExecResult,
  type HostProcessInfo,
  type PtyHostCommand,
  type PtyHostDiagnostics,
  type PtyHostEvent,
  type PtyHostMethod,
  type PtyHostRawSpawnResult,
  type PtyHostRequestMap,
  type PtyHostSpawnParams,
  type PtyHostSpawnResult,
  type SeedFrameResult,
} from './protocol';
import type { StopProcessRequest, StopProcessResult, TaggedReapRequest, TaggedReapResult } from '../process-tag/tagged-reap';

/** A listener registration that can be undone. */
export interface PtyDisposable {
  dispose(): void;
}

/**
 * What main needs of a live PTY: its pid and grid, and the three operations.
 * The subset of node-pty's `IPty` the session code always used, so the rows,
 * the kill paths and the shutdown helpers kept their shape.
 */
export interface PtyHandle {
  readonly ptyId: number;
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtyHostLifecycleListener {
  /** The host died: every PTY it held is gone with it. */
  onHostDown(): void;
  /** A host is up and answering; `restarted` when an earlier one died. */
  onHostUp(restarted: boolean): void;
}

export interface PtyHostTransport {
  /** Send a command. Commands and requests keep their order. */
  post(command: PtyHostCommand): void;
  /** `timeoutMs` replaces the transport's default budget for this request. */
  request<M extends PtyHostMethod>(
    method: M,
    params: PtyHostRequestMap[M]['params'],
    options?: { timeoutMs?: number },
  ): Promise<PtyHostRequestMap[M]['result']>;
  /** Install the one listener every host event goes to. */
  setEventListener(listener: (event: PtyHostEvent) => void): void;
  /** The host process's pid while it runs, for the quit drain; null in-process. */
  readonly hostPid: number | null;
  /** The app is quitting: flush transcripts, and for a utility host, exit once
   *  every PTY has, within `exitWaitMs`. Synchronous. */
  shutdown(exitWaitMs?: number): void;
  /** Hear of a host dying and coming back (a utility process only). */
  setLifecycleListener?(listener: PtyHostLifecycleListener): void;
  /** Stop the process tree a dead host left behind for one of its PTYs. Only a
   *  utility host implements it: the one host whose PTYs can outlive it. */
  stopLostPtyTree?(pid: number): void;
  /** What to run the host core on if the utility process keeps crashing. */
  setFallbackFactory?(factory: () => PtyHostTransport): void;
}

export { PTY_HOST_LOST_EXIT_CODE };

export interface PtyHostLifecycleHandler {
  /** The host died; these sessions' PTYs were reported exited. */
  onHostLost(sessionIds: string[]): void;
  /** A replacement host is up: replay what it needs to know. */
  onHostRestarted(): void;
}

/**
 * A PTY that lives in the host. `cols` and `rows` are main's mirror of what it
 * last asked for, which is what node-pty reports too. Once the host reports the
 * exit, `kill()` throws ESRCH and `resize()` throws, as node-pty does on a dead
 * child, so `safeKillPty` and the resize paths keep their meaning.
 */
export class RemotePty implements PtyHandle {
  private exited = false;
  private currentCols: number;
  private currentRows: number;

  constructor(
    readonly ptyId: number,
    readonly pid: number,
    cols: number,
    rows: number,
    private readonly transport: Pick<PtyHostTransport, 'post'>,
    /** The session this PTY was spawned for, for host-loss reporting. */
    readonly sessionId: string = '',
  ) {
    this.currentCols = cols;
    this.currentRows = rows;
  }

  get cols(): number {
    return this.currentCols;
  }

  get rows(): number {
    return this.currentRows;
  }

  /** The host reported the child's exit. */
  markExited(): void {
    this.exited = true;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  write(data: string): void {
    if (this.exited) return;
    this.transport.post({ type: 'write', ptyId: this.ptyId, data });
  }

  resize(cols: number, rows: number): void {
    if (this.exited) throw new Error('Cannot resize a pty that has already exited');
    this.currentCols = cols;
    this.currentRows = rows;
    this.transport.post({ type: 'resizePty', ptyId: this.ptyId, cols, rows });
  }

  kill(): void {
    if (this.exited) {
      const error = new Error('kill ESRCH') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    }
    this.transport.post({ type: 'kill', ptyId: this.ptyId });
  }
}

export type PtyHostSpawnOutcome =
  | { ok: true; pty: RemotePty }
  | { ok: false; error: Error; previousScrollback: string };

/**
 * A raw PTY running in the host (`spawnRaw`): the probes' handle. Output and
 * exit arrive as events, routed here by ptyId.
 */
export class RemoteRawPty implements OffMainPty {
  private exited = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  constructor(
    readonly ptyId: number,
    readonly pid: number,
    private readonly transport: Pick<PtyHostTransport, 'post'>,
  ) {}

  write(data: string): void {
    if (this.exited) return;
    this.transport.post({ type: 'write', ptyId: this.ptyId, data });
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.transport.post({ type: 'resizePty', ptyId: this.ptyId, cols, rows });
  }

  kill(): void {
    if (this.exited) return;
    this.transport.post({ type: 'kill', ptyId: this.ptyId });
  }

  onData(listener: (data: string) => void): PtyDisposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): PtyDisposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  deliverData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  deliverExit(exitCode: number, signal: number | null): void {
    if (this.exited) return;
    this.exited = true;
    const event = signal === null ? { exitCode } : { exitCode, signal };
    for (const listener of this.exitListeners) listener(event);
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}

/** An agent CLI run's stdout or stderr. The host reads the pipe as it fills,
 *  so `resume()` has nothing to do; it is here for callers that drain a local
 *  child's output. */
class RemoteCliOutput extends EventEmitter {
  resume(): this {
    return this;
  }
}

class RemoteCliStdin extends EventEmitter implements CliStdin {
  private ended = false;

  constructor(
    private readonly processId: number,
    private readonly transport: Pick<PtyHostTransport, 'post'>,
  ) {
    super();
  }

  write(chunk: string): boolean {
    if (this.ended) return false;
    this.transport.post({ type: 'cliWrite', processId: this.processId, data: chunk });
    return true;
  }

  end(chunk?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.transport.post({ type: 'cliEndInput', processId: this.processId, ...(chunk === undefined ? {} : { data: chunk }) });
  }
}

/**
 * An agent CLI run in the host (`cliSpawn`): what `spawnCli` returns when a
 * host is registered. It emits what a local child process emits, in the order
 * the host saw it: `spawn`, `data` on `stdout` and `stderr`, `exit`, then
 * `close`, or `error` for a run that failed to start.
 */
export class RemoteCliProcess extends EventEmitter implements CliChildProcess {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new RemoteCliOutput();
  readonly stderr = new RemoteCliOutput();
  readonly stdin: RemoteCliStdin;
  private closed = false;

  constructor(
    readonly processId: number,
    private readonly transport: Pick<PtyHostTransport, 'post'>,
  ) {
    super();
    this.stdin = new RemoteCliStdin(processId, transport);
  }

  get hasClosed(): boolean {
    return this.closed;
  }

  /** Any signal stops the whole tree, which is what every caller wants. */
  kill(): boolean {
    this.stopTree();
    return true;
  }

  stopTree(): void {
    if (this.closed || this.exitCode !== null || this.signalCode !== null) return;
    this.transport.post({ type: 'cliStop', processId: this.processId });
  }

  deliverSpawned(pid: number | null): void {
    this.pid = pid ?? undefined;
    this.emit('spawn');
  }

  deliverData(stream: 'stdout' | 'stderr', data: Uint8Array): void {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    (stream === 'stdout' ? this.stdout : this.stderr).emit('data', chunk);
  }

  /** With no listener an `error` event throws, here on main; such a caller
   *  hears of the failure through `exit` and `close` instead. */
  deliverError(error: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  deliverExit(code: number | null, signal: string | null): void {
    this.exitCode = code;
    this.signalCode = signal as NodeJS.Signals | null;
    this.emit('exit', code, this.signalCode);
  }

  deliverClose(code: number | null, signal: string | null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, signal as NodeJS.Signals | null);
  }

  /** The host died with this run in it: fail it the way a killed child ends. */
  deliverHostLost(): void {
    if (this.closed) return;
    // Its pipes went with the host, but on Windows a child outlives its parent.
    if (this.pid !== undefined && this.exitCode === null && this.signalCode === null) killChildTreeByPid(this.pid);
    this.deliverError(new Error('The pty host stopped while the agent was running'));
    if (this.exitCode === null && this.signalCode === null) this.deliverExit(null, 'SIGKILL');
    this.deliverClose(null, 'SIGKILL');
  }
}

/** Typed access to the host, and the exit routing for each PTY. */
export class PtyHostClient {
  private nextPtyId = 1;
  private nextProcessId = 1;
  private readonly handles = new Map<number, RemotePty>();
  private readonly rawHandles = new Map<number, RemoteRawPty>();
  private readonly cliHandles = new Map<number, RemoteCliProcess>();
  private readonly exitListeners = new Map<number, (exitCode: number) => void>();
  private eventHandler: ((event: PtyHostEvent) => void) | null = null;
  private lifecycleHandler: PtyHostLifecycleHandler | null = null;

  constructor(readonly transport: PtyHostTransport) {
    transport.setEventListener((event) => this.dispatch(event));
    transport.setLifecycleListener?.({
      onHostDown: () => this.reportHostLost(),
      onHostUp: (restarted) => {
        if (restarted) this.lifecycleHandler?.onHostRestarted();
      },
    });
  }

  /** Where every event other than a PTY's exit goes. */
  setEventHandler(handler: (event: PtyHostEvent) => void): void {
    this.eventHandler = handler;
  }

  /** Hear of the host dying and of its replacement. */
  setLifecycleHandler(handler: PtyHostLifecycleHandler): void {
    this.lifecycleHandler = handler;
  }

  /**
   * The host died: report every PTY it held as exited, through each one's own
   * exit listener, so the sessions end exactly as a PTY exit ends them.
   */
  private reportHostLost(): void {
    // A closed pseudo console (Windows) or a hangup (POSIX) usually ends what a
    // PTY ran, but nothing guarantees it. An agent left running would go on
    // editing its worktree beside the session recovery resumes on the new host,
    // so each tree still live is stopped by pid before its exit is reported.
    const stopTree = (pid: number): void => {
      if (pid > 0) this.transport.stopLostPtyTree?.(pid);
    };
    // A probe's raw PTY died with the host too.
    const rawHandles = [...this.rawHandles.values()];
    this.rawHandles.clear();
    for (const rawHandle of rawHandles) {
      stopTree(rawHandle.pid);
      rawHandle.deliverExit(PTY_HOST_LOST_EXIT_CODE, null);
    }
    // So did every agent CLI run. A run never restarts on the new host: a
    // second run would be a second paid answer.
    const cliHandles = [...this.cliHandles.values()];
    this.cliHandles.clear();
    for (const cliHandle of cliHandles) {
      try {
        cliHandle.deliverHostLost();
      } catch (error) {
        console.error('[pty-host] an agent run could not be failed after the host was lost:', error);
      }
    }
    const lostSessionIds: string[] = [];
    for (const { handle, listener } of this.takeLiveHandles()) {
      stopTree(handle.pid);
      handle.markExited();
      if (handle.sessionId) lostSessionIds.push(handle.sessionId);
      try {
        listener?.(PTY_HOST_LOST_EXIT_CODE);
      } catch (error) {
        console.error('[pty-host] exit handling after the host was lost failed:', error);
      }
    }
    this.lifecycleHandler?.onHostLost(lostSessionIds);
  }

  get hostPid(): number | null {
    return this.transport.hostPid;
  }

  post(command: PtyHostCommand): void {
    this.transport.post(command);
  }

  async spawn(params: Omit<PtyHostSpawnParams, 'ptyId'>): Promise<PtyHostSpawnOutcome> {
    const ptyId = this.nextPtyId;
    this.nextPtyId += 1;
    let result: PtyHostSpawnResult;
    try {
      result = await this.transport.request('spawn', { ...params, ptyId });
    } catch (error) {
      // The host was lost or did not answer in time. A host that still runs
      // the request later would start a PTY no handle holds, so a kill follows
      // it (commands keep their order, and an unknown ptyId is a no-op). To the
      // session this is a spawn that failed, and it is reported as one: a
      // throw here skipped the failure path and left a promoted queue row
      // `queued` for good.
      this.transport.post({ type: 'kill', ptyId });
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)), previousScrollback: '' };
    }
    if (!result.ok) {
      return { ok: false, error: fromPtyHostError(result.error), previousScrollback: result.previousScrollback };
    }
    const handle = new RemotePty(ptyId, result.pid, params.cols, params.rows, this.transport, params.sessionId);
    this.handles.set(ptyId, handle);
    return { ok: true, pty: handle };
  }

  /**
   * Run `listener` when this PTY exits. The disposable detaches it; the quit
   * path does, so a late exit cannot land on a torn-down session.
   */
  onPtyExit(ptyId: number, listener: (exitCode: number) => void): PtyDisposable {
    this.exitListeners.set(ptyId, listener);
    return {
      dispose: () => {
        if (this.exitListeners.get(ptyId) === listener) this.exitListeners.delete(ptyId);
      },
    };
  }

  getScrollback(sessionId: string, settle: boolean): Promise<string> {
    return this.transport.request('getScrollback', { sessionId, settle });
  }

  getSerializedFrame(sessionId: string, settle: boolean): Promise<string> {
    return this.transport.request('getSerializedFrame', { sessionId, settle });
  }

  getSeedFrame(sessionId: string, settle: boolean, scrollbackLines?: number): Promise<SeedFrameResult> {
    return this.transport.request('getSeedFrame', { sessionId, settle, scrollbackLines });
  }

  getRawScrollback(sessionId: string, timeoutMs?: number): Promise<string> {
    return this.transport.request('getRawScrollback', { sessionId }, timeoutMs === undefined ? undefined : { timeoutMs });
  }

  getOutputPeek(sessionId: string): Promise<string[]> {
    return this.transport.request('getOutputPeek', { sessionId });
  }

  /**
   * Spawn a raw PTY in the host for a probe. Rejects with
   * `HostUnavailableError` when the host cannot be asked, and with the spawn's
   * own error when it failed there.
   */
  async spawnRaw(file: string, args: string[], options: OffMainPtyOptions): Promise<RemoteRawPty> {
    const ptyId = this.nextPtyId;
    this.nextPtyId += 1;
    let result: PtyHostRawSpawnResult;
    try {
      result = await this.transport.request('spawnRaw', { ptyId, file, args, ...options });
    } catch (error) {
      // The caller spawns locally instead. A host that only timed out may
      // still run the request, and the probe would then run twice, so a kill
      // follows it (an unknown ptyId is a no-op).
      this.transport.post({ type: 'kill', ptyId });
      throw new HostUnavailableError(error instanceof Error ? error.message : String(error));
    }
    if (!result.ok) throw fromPtyHostError(result.error);
    const handle = new RemoteRawPty(ptyId, result.pid, this.transport);
    this.rawHandles.set(ptyId, handle);
    return handle;
  }

  /**
   * Start an agent CLI run in the host (`host-cli-processes.ts`). Returns at
   * once; a spawn that fails there arrives as the handle's `error` event.
   */
  spawnCli(command: string, args: string[], options: OffMainCliOptions): RemoteCliProcess {
    const processId = this.nextProcessId;
    this.nextProcessId += 1;
    const handle = new RemoteCliProcess(processId, this.transport);
    this.cliHandles.set(processId, handle);
    this.transport.post({ type: 'cliSpawn', params: { processId, command, args, ...options } });
    return handle;
  }

  /** Run a one-shot child process in the host (see `host-exec.ts`). */
  exec(request: HostExecRequest, timeoutMs: number): Promise<HostExecResult> {
    return this.transport.request('exec', request, { timeoutMs });
  }

  /** The process table, from the host's persistent probe. */
  listProcesses(): Promise<HostProcessInfo[]> {
    return this.transport.request('listProcesses', {});
  }

  /** Kill what the given tasks left running (see `process-tag/tagged-reap.ts`). */
  reapTaggedProcesses(request: TaggedReapRequest, timeoutMs: number): Promise<TaggedReapResult> {
    return this.transport.request('reapTaggedProcesses', request, { timeoutMs });
  }

  /** Stop one process a reap reported (see `process-tag/tagged-reap.ts`). */
  stopReportedProcess(request: StopProcessRequest, timeoutMs: number): Promise<StopProcessResult> {
    return this.transport.request('stopReportedProcess', request, { timeoutMs });
  }

  getDiagnostics(): Promise<PtyHostDiagnostics> {
    return this.transport.request('getDiagnostics', {});
  }

  shutdown(exitWaitMs?: number): void {
    this.transport.shutdown(exitWaitMs);
  }

  private dispatch(event: PtyHostEvent): void {
    switch (event.type) {
      case 'cliSpawned':
        this.cliHandles.get(event.processId)?.deliverSpawned(event.pid);
        return;
      case 'cliData':
        this.cliHandles.get(event.processId)?.deliverData(event.stream, event.data);
        return;
      case 'cliError':
        this.cliHandles.get(event.processId)?.deliverError(fromPtyHostError(event.error));
        return;
      case 'cliExit':
        this.cliHandles.get(event.processId)?.deliverExit(event.code, event.signal);
        return;
      case 'cliClose': {
        const cliHandle = this.cliHandles.get(event.processId);
        this.cliHandles.delete(event.processId);
        cliHandle?.deliverClose(event.code, event.signal);
        return;
      }
      default:
        break;
    }
    if (event.type === 'rawData') {
      this.rawHandles.get(event.ptyId)?.deliverData(event.data);
      return;
    }
    if (event.type === 'rawExit') {
      const rawHandle = this.rawHandles.get(event.ptyId);
      this.rawHandles.delete(event.ptyId);
      rawHandle?.deliverExit(event.exitCode, event.signal);
      return;
    }
    if (event.type === 'exit') {
      const handle = this.handles.get(event.ptyId);
      handle?.markExited();
      this.handles.delete(event.ptyId);
      const listener = this.exitListeners.get(event.ptyId);
      this.exitListeners.delete(event.ptyId);
      listener?.(event.exitCode);
      return;
    }
    this.eventHandler?.(event);
  }

  /**
   * Every PTY the host still runs, as handles: the host went away, and each of
   * these must be reported exited. Clears the routing.
   */
  private takeLiveHandles(): Array<{ handle: RemotePty; listener: ((exitCode: number) => void) | undefined }> {
    const live = [...this.handles.values()].map((handle) => ({
      handle,
      listener: this.exitListeners.get(handle.ptyId),
    }));
    this.handles.clear();
    this.exitListeners.clear();
    return live;
  }
}

export interface InProcessPtyHostOptions {
  resolveAgent(sessionId: string, agentName: string | null): AgentParser | undefined;
  transcriptSinkFor(projectId: string): TranscriptSink | null;
}

/**
 * The host core run inside this process: commands and events are synchronous
 * calls, requests resolve on the next microtask. Used by unit tests, which
 * mock node-pty and drive output synchronously, and as the host when no
 * utility process is configured.
 */
export class InProcessPtyHostTransport implements PtyHostTransport {
  readonly core: PtyHostCore;
  readonly hostPid = null;
  private listener: ((event: PtyHostEvent) => void) | null = null;

  constructor(options: InProcessPtyHostOptions) {
    this.core = new PtyHostCore({
      emit: (event) => this.listener?.(event),
      resolveAgent: options.resolveAgent,
      transcriptSinkFor: options.transcriptSinkFor,
      coalesceMs: 0,
    });
  }

  post(command: PtyHostCommand): void {
    this.core.handleCommand(command);
  }

  request<M extends PtyHostMethod>(method: M, params: PtyHostRequestMap[M]['params']): Promise<PtyHostRequestMap[M]['result']> {
    try {
      return Promise.resolve(this.core.handleRequest(method, params));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  setEventListener(listener: (event: PtyHostEvent) => void): void {
    this.listener = listener;
  }

  shutdown(): void {
    this.core.finalizeTranscripts();
    this.core.disposeProcessTable();
  }
}
