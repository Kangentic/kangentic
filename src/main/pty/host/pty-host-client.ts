/**
 * Main's side of the pty host: the handle a session row holds for its PTY, and
 * the client that talks to the host through a transport.
 *
 * The transport is either the `kangentic-pty-host` utility process
 * (`utility-pty-host-transport.ts`, production) or the same `PtyHostCore`
 * running in this process (`InProcessPtyHostTransport`, unit tests), so both
 * paths run the one core and the one protocol.
 */

import type { AgentParser } from '../../../shared/types';
import { PTY_HOST_LOST_EXIT_CODE } from '../../../shared/pty-host';
import type { TranscriptSink } from '../buffer/transcript-writer';
import { HostUnavailableError, type OffMainPty, type OffMainPtyOptions } from '../../utility-process/off-main-pty';
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
} from './protocol';

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

/** Typed access to the host, and the exit routing for each PTY. */
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

export class PtyHostClient {
  private nextPtyId = 1;
  private readonly handles = new Map<number, RemotePty>();
  private readonly rawHandles = new Map<number, RemoteRawPty>();
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
    // A probe's raw PTY died with the host too.
    const rawHandles = [...this.rawHandles.values()];
    this.rawHandles.clear();
    for (const rawHandle of rawHandles) rawHandle.deliverExit(PTY_HOST_LOST_EXIT_CODE, null);
    const lostSessionIds: string[] = [];
    for (const { handle, listener } of this.takeLiveHandles()) {
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
    const result = await this.transport.request('spawn', { ...params, ptyId });
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

  getRawScrollback(sessionId: string): Promise<string> {
    return this.transport.request('getRawScrollback', { sessionId });
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
      throw new HostUnavailableError(error instanceof Error ? error.message : String(error));
    }
    if (!result.ok) throw fromPtyHostError(result.error);
    const handle = new RemoteRawPty(ptyId, result.pid, this.transport);
    this.rawHandles.set(ptyId, handle);
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

  getDiagnostics(): Promise<PtyHostDiagnostics> {
    return this.transport.request('getDiagnostics', {});
  }

  shutdown(exitWaitMs?: number): void {
    this.transport.shutdown(exitWaitMs);
  }

  private dispatch(event: PtyHostEvent): void {
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
    this.core.disposeProcessTreeProbe();
  }
}
