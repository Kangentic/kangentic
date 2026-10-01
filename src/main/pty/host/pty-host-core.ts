/**
 * The pty host's state and work, independent of how it is reached.
 *
 * Owns every node-pty instance and everything that runs per output chunk: the
 * scrollback ring and headless xterm (`PtyBufferManager`), the raw transcript
 * (`TranscriptWriter`, writing to the project's database itself), output
 * backpressure, the redraw filter (`ResizeManager`), and the adapters' output
 * detectors (session id, stream telemetry, idle, first output). Main sends it
 * commands and requests (`protocol.ts`) and hears back through `emit`.
 *
 * In production this runs in the `kangentic-pty-host` utility process
 * (`pty-host-entry.ts`), so PTY output never crosses main's event loop: on a
 * heavy terminal flood main was 40 to 42% busy, 2.4 to 3.1 s of every 14 s in
 * the headless parse alone. Unit tests run the same core in-process, with
 * events delivered synchronously (`InProcessPtyHostTransport`).
 */

import * as nodePty from 'node-pty';
import type { ActivityState, AgentParser, StreamOutputParser } from '../../../shared/types';
import { PtyBufferManager } from '../buffer/pty-buffer-manager';
import { TranscriptWriter, type TranscriptSink } from '../buffer/transcript-writer';
import { BackpressureController } from '../buffer/backpressure-controller';
import { ResizeManager } from '../lifecycle/resize-manager';
import { FirstOutputTracker } from '../lifecycle/first-output-tracker';
import { SessionIdScanner } from '../lifecycle/session-id-manager';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import { traceTerminal } from '../terminal-trace';
import {
  toPtyHostError,
  type PtyHostCommand,
  type PtyHostDiagnostics,
  type PtyHostEvent,
  type PtyHostRequestMap,
  type PtyHostSpawnParams,
  type PtyHostSpawnResult,
} from './protocol';

/** Rolling window the session-id scan keeps: twice ConPTY's 4 KB flush. */
const SESSION_ID_SCAN_WINDOW = 8192;

export interface PtyHostCoreDeps {
  emit(event: PtyHostEvent): void;
  /** The adapter whose detectors read a session's output, or undefined. */
  resolveAgent(sessionId: string, agentName: string | null): AgentParser | undefined;
  /** Where a project's raw transcript pieces are written, or null. */
  transcriptSinkFor(projectId: string): TranscriptSink | null;
  /** Close any database handle the host holds for a project. */
  closeProject?(projectId: string): void;
  /** How long to merge `outputSeen` and `ptyData` events per session. 0
   *  sends one per chunk (the in-process host); the utility process merges,
   *  so a flood costs main a few messages a second instead of one per chunk. */
  coalesceMs: number;
  spawnPty?: typeof nodePty.spawn;
}

interface HostSession {
  sessionId: string;
  projectId: string;
  agentName: string | null;
  transient: boolean;
  agent: AgentParser | undefined;
  agentResolved: boolean;
  streamParser?: StreamOutputParser;
  agentSessionIdKnown: boolean;
  scanner: SessionIdScanner | null;
  activity: ActivityState | undefined;
  /** The PTY currently feeding this session, for pause/resume and the settle. */
  livePtyId: number | null;
}

interface PtyEntry {
  ptyId: number;
  sessionId: string;
  pty: nodePty.IPty;
  exited: boolean;
  /** A kill was sent. A second one is dropped: killing a ConPTY twice
   *  corrupts its heap on Windows. */
  killed: boolean;
  disposables: nodePty.IDisposable[];
}

interface CoalesceState {
  /** Chunks seen since the window's leading `outputSeen`. */
  chunks: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** A `ptyData` already went out in this window. */
  activitySent: boolean;
  /** More activity arrived after it, to report when the window closes. */
  activityPending: boolean;
}

export class PtyHostCore {
  private readonly sessions = new Map<string, HostSession>();
  private readonly ptys = new Map<number, PtyEntry>();
  private readonly focused = new Set<string>();
  private readonly tapped = new Set<string>();
  private readonly firstOutput = new FirstOutputTracker();
  private readonly resizeManager = new ResizeManager();
  private readonly coalesce = new Map<string, CoalesceState>();
  private readonly bufferManager: PtyBufferManager;
  private readonly transcriptWriter: TranscriptWriter;
  private readonly backpressure: BackpressureController;
  private readonly spawnPty: typeof nodePty.spawn;

  constructor(private readonly deps: PtyHostCoreDeps) {
    this.spawnPty = deps.spawnPty ?? nodePty.spawn;
    this.bufferManager = new PtyBufferManager({
      onFlush: (sessionId, data) => {
        this.consumeFirstOutput(sessionId, data);
        if (this.tapped.has(sessionId)) this.deps.emit({ type: 'tap', sessionId, data });
        if (this.focused.has(sessionId)) {
          this.deps.emit({ type: 'data', sessionId, data });
          this.backpressure.recordEmitted(sessionId, data.length);
        }
      },
      onDrain: (sessionId, data) => {
        // A replay sample took these bytes out of the pending buffer; the
        // renderer gets them inside the reply. Only the first-output latch and
        // a phone's tap still need them.
        this.consumeFirstOutput(sessionId, data);
        if (this.tapped.has(sessionId)) this.deps.emit({ type: 'tap', sessionId, data });
      },
      onAltScreenEnter: (sessionId) => {
        this.deps.emit({ type: 'altScreen', sessionId, inAltScreen: true });
      },
      onAltScreenExit: (sessionId) => {
        this.deps.emit({ type: 'altScreen', sessionId, inAltScreen: false });
      },
    });
    this.transcriptWriter = new TranscriptWriter(
      (sessionId) => {
        const session = this.sessions.get(sessionId);
        return session && !session.transient ? session.projectId : null;
      },
      (projectId) => this.deps.transcriptSinkFor(projectId),
    );
    this.backpressure = new BackpressureController((sessionId) => {
      const ptyId = this.sessions.get(sessionId)?.livePtyId;
      const entry = ptyId === null || ptyId === undefined ? undefined : this.ptys.get(ptyId);
      return entry && !entry.exited ? entry.pty : null;
    });
  }

  // --- Requests -------------------------------------------------------------

  spawn(params: PtyHostSpawnParams): PtyHostSpawnResult {
    // The carry-over is read before the earlier sessions are dropped, so a
    // resume shows unbroken history (see performSpawn).
    const carrySource = params.carryoverFromSessionId;
    const previousScrollback = carrySource ? this.bufferManager.getRawScrollback(carrySource) : '';
    const previousGeometry = carrySource ? this.bufferManager.getCarryoverGeometry(carrySource) : null;
    for (const droppedId of params.dropSessionIds) this.dropSession(droppedId);

    let pty: nodePty.IPty;
    try {
      pty = this.spawnPty(params.file, params.args, {
        name: 'xterm-256color',
        cols: params.cols,
        rows: params.rows,
        cwd: params.cwd,
        env: params.env,
      });
    } catch (error) {
      return { ok: false, error: toPtyHostError(error), previousScrollback };
    }

    this.sessions.set(params.sessionId, {
      sessionId: params.sessionId,
      projectId: params.projectId,
      agentName: params.agentName,
      transient: params.transient,
      agent: undefined,
      agentResolved: false,
      agentSessionIdKnown: params.agentSessionIdKnown,
      scanner: null,
      activity: undefined,
      livePtyId: params.ptyId,
    });
    this.bufferManager.initSession(
      params.sessionId,
      previousScrollback,
      params.cols,
      params.rows,
      previousGeometry,
      params.transient,
    );

    const entry: PtyEntry = { ptyId: params.ptyId, sessionId: params.sessionId, pty, exited: false, killed: false, disposables: [] };
    this.ptys.set(params.ptyId, entry);
    entry.disposables.push(pty.onData((data: string) => timeSyncWork('pty:data', () => this.onPtyData(entry, data))));
    entry.disposables.push(pty.onExit(({ exitCode }: { exitCode: number }) => this.onPtyExit(entry, exitCode)));
    return { ok: true, pid: pty.pid };
  }

  async getScrollback(sessionId: string, settle: boolean): Promise<string> {
    if (settle) await this.bufferManager.waitForResizeRepaint(sessionId);
    return this.bufferManager.getReplaySnapshot(sessionId);
  }

  async getSerializedFrame(sessionId: string, settle: boolean): Promise<string> {
    if (settle) await this.bufferManager.waitForResizeRepaint(sessionId);
    return this.bufferManager.getSerializedFrame(sessionId);
  }

  getRawScrollback(sessionId: string): string {
    return this.bufferManager.getRawScrollback(sessionId);
  }

  getOutputPeek(sessionId: string): string[] {
    return this.bufferManager.getOutputPeek(sessionId);
  }

  getDiagnostics(): PtyHostDiagnostics {
    const pipeline: PtyHostDiagnostics['pipeline'] = [];
    const dimensions: PtyHostDiagnostics['dimensions'] = [];
    for (const sessionId of this.bufferManager.sessionIds()) {
      const buffer = this.bufferManager.getBufferStats(sessionId);
      pipeline.push({
        sessionId,
        pendingBytes: buffer?.pendingBytes ?? 0,
        scrollbackBytes: buffer?.scrollbackBytes ?? 0,
        paused: this.backpressure.isPaused(sessionId),
        inFlightBytes: this.backpressure.getInFlight(sessionId),
      });
      const dimension = this.bufferManager.getDimensionState(sessionId);
      if (dimension) {
        dimensions.push({
          sessionId,
          lastCols: dimension.lastCols,
          lastRows: dimension.lastRows,
          pendingRepaintAt: dimension.pendingRepaintAt,
          pendingRepaintStacked: dimension.pendingRepaintStacked,
          inAltScreen: dimension.inAltScreen,
          geometryChangedAtRingIndex: dimension.geometryChangedAtRingIndex,
        });
      }
    }
    return { pipeline, dimensions };
  }

  /** Answer a request by method name: the one place both transports dispatch. */
  handleRequest<M extends keyof PtyHostRequestMap>(
    method: M,
    params: PtyHostRequestMap[M]['params'],
  ): PtyHostRequestMap[M]['result'] | Promise<PtyHostRequestMap[M]['result']> {
    switch (method) {
      case 'spawn':
        return this.spawn(params as PtyHostSpawnParams) as PtyHostRequestMap[M]['result'];
      case 'getScrollback': {
        const { sessionId, settle } = params as PtyHostRequestMap['getScrollback']['params'];
        return this.getScrollback(sessionId, settle) as Promise<PtyHostRequestMap[M]['result']>;
      }
      case 'getSerializedFrame': {
        const { sessionId, settle } = params as PtyHostRequestMap['getSerializedFrame']['params'];
        return this.getSerializedFrame(sessionId, settle) as Promise<PtyHostRequestMap[M]['result']>;
      }
      case 'getRawScrollback':
        return this.getRawScrollback((params as { sessionId: string }).sessionId) as PtyHostRequestMap[M]['result'];
      case 'getOutputPeek':
        return this.getOutputPeek((params as { sessionId: string }).sessionId) as PtyHostRequestMap[M]['result'];
      case 'getDiagnostics':
        return this.getDiagnostics() as PtyHostRequestMap[M]['result'];
      case 'ping':
        return 'pong' as PtyHostRequestMap[M]['result'];
      default: {
        const unknownMethod: never = method;
        throw new Error(`unknown pty host method: ${String(unknownMethod)}`);
      }
    }
  }

  // --- Commands -------------------------------------------------------------

  handleCommand(command: PtyHostCommand): void {
    switch (command.type) {
      case 'write':
        this.withLivePty(command.ptyId, (entry) => entry.pty.write(command.data));
        return;
      case 'resizePty': {
        const entry = this.ptys.get(command.ptyId);
        if (!entry || entry.exited) return;
        try {
          entry.pty.resize(command.cols, command.rows);
        } catch (error) {
          // node-pty throws once the child has exited but before its exit
          // callback ran (up to ~1 s on Windows, where the exit waits on the
          // conout flush). Main already reported the resize; the exit path
          // owns the cleanup, so record it for the terminal forensics.
          traceTerminal(entry.sessionId, 'resize-failed', {
            cols: command.cols,
            rows: command.rows,
            message: String(error),
          });
        }
        return;
      }
      case 'resizeBuffer':
        this.bufferManager.onResize(command.sessionId, command.cols, command.rows);
        return;
      case 'markResized':
        this.resizeManager.notifyResize(command.sessionId);
        return;
      case 'kill':
        this.kill(command.ptyId);
        return;
      case 'setFocused':
        this.focused.clear();
        for (const sessionId of command.sessionIds) this.focused.add(sessionId);
        return;
      case 'setTapped':
        this.tapped.clear();
        for (const sessionId of command.sessionIds) this.tapped.add(sessionId);
        return;
      case 'ack':
        this.backpressure.acknowledge(command.sessionId, command.bytes);
        return;
      case 'releaseBackpressure':
        for (const sessionId of command.sessionIds) this.backpressure.release(sessionId);
        return;
      case 'setActivity': {
        const session = this.sessions.get(command.sessionId);
        if (session) session.activity = command.activity;
        return;
      }
      case 'setAgentSessionIdKnown': {
        const session = this.sessions.get(command.sessionId);
        if (session) {
          session.agentSessionIdKnown = true;
          session.scanner = null;
        }
        return;
      }
      case 'finalizeTranscript':
        this.transcriptWriter.finalize(command.sessionId);
        return;
      case 'removeSession':
        this.dropSession(command.sessionId);
        return;
      case 'initSession':
        this.bufferManager.initSession(command.sessionId, command.scrollback, command.cols);
        return;
      case 'closeProject':
        this.deps.closeProject?.(command.projectId);
        return;
      case 'shutdown':
        this.killAll();
        return;
      default: {
        const unknownCommand: never = command;
        throw new Error(`unknown pty host command: ${JSON.stringify(unknownCommand)}`);
      }
    }
  }

  /**
   * Kill every live PTY and report their child pids (the quit path). The
   * transcripts are flushed first, since nothing will write them after.
   */
  killAll(): number[] {
    this.transcriptWriter.finalizeAll();
    const pids: number[] = [];
    for (const entry of this.ptys.values()) {
      if (entry.exited) continue;
      pids.push(entry.pty.pid);
      this.kill(entry.ptyId);
    }
    return pids;
  }

  /** Flush every pending transcript piece (in-process quit). */
  finalizeTranscripts(): void {
    this.transcriptWriter.finalizeAll();
  }

  /** PTYs still waiting for their exit callback. */
  get livePtyCount(): number {
    let count = 0;
    for (const entry of this.ptys.values()) if (!entry.exited) count += 1;
    return count;
  }

  // --- Internals ------------------------------------------------------------

  private withLivePty(ptyId: number, action: (entry: PtyEntry) => void): void {
    const entry = this.ptys.get(ptyId);
    if (!entry || entry.exited) return;
    try {
      action(entry);
    } catch {
      // node-pty throws once the child has exited but before its exit
      // callback ran; the exit path owns the cleanup.
    }
  }

  private kill(ptyId: number): void {
    const entry = this.ptys.get(ptyId);
    if (!entry || entry.exited || entry.killed) return;
    entry.killed = true;
    try {
      entry.pty.kill();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EACCES' && code !== 'ESRCH') console.warn('[pty-host] pty.kill() failed:', error);
    }
  }

  private dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.bufferManager.removeSession(sessionId);
    this.transcriptWriter.remove(sessionId);
    this.firstOutput.removeSession(sessionId);
    this.resizeManager.removeSession(sessionId);
    this.backpressure.release(sessionId);
    const coalesceState = this.coalesce.get(sessionId);
    if (coalesceState?.timer) clearTimeout(coalesceState.timer);
    this.coalesce.delete(sessionId);
  }

  private agentFor(session: HostSession): AgentParser | undefined {
    if (!session.agentResolved) {
      session.agent = this.deps.resolveAgent(session.sessionId, session.agentName);
      // An in-process resolver reads main's registry row, which a test may
      // add after the spawn returns; keep asking until it answers.
      session.agentResolved = session.agent !== undefined;
    }
    return session.agent;
  }

  private consumeFirstOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    const agent = session ? this.agentFor(session) : undefined;
    const detector = agent ? (chunk: string) => agent.detectFirstOutput(chunk) : undefined;
    if (this.firstOutput.consume(sessionId, data, detector)) {
      const inAltScreen = this.bufferManager.getDimensionState(sessionId)?.inAltScreen === true;
      this.deps.emit({ type: 'firstOutput', sessionId, inAltScreen });
    }
  }

  private onPtyData(entry: PtyEntry, data: string): void {
    const sessionId = entry.sessionId;
    this.bufferManager.onData(sessionId, data);
    this.noteOutput(sessionId);

    // A session main removed while its PTY was still exiting (a young
    // session's kill waits out the exit grace) keeps feeding the ring above,
    // as before, but nothing else: there is no row to attribute it to.
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!session.transient) this.transcriptWriter.onData(sessionId, data);

    const agent = this.agentFor(session);
    if (!agent) return;

    const fromOutput = agent.runtime?.sessionId?.fromOutput;
    if (fromOutput && !session.agentSessionIdKnown) {
      session.scanner ??= new SessionIdScanner(SESSION_ID_SCAN_WINDOW);
      const capturedId = session.scanner.scanChunk(data, fromOutput);
      if (capturedId) {
        session.agentSessionIdKnown = true;
        session.scanner = null;
        this.deps.emit({ type: 'agentSessionId', sessionId, capturedId });
      }
    }

    const streamFactory = agent.runtime?.streamOutput;
    if (streamFactory) {
      session.streamParser ??= streamFactory.createParser();
      const result = session.streamParser.parseTelemetry(data);
      if (result && (result.usage || (result.events && result.events.length > 0))) {
        this.deps.emit({
          type: 'streamTelemetry',
          sessionId,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.events && result.events.length > 0 ? { events: result.events } : {}),
        });
      }
    }

    const strategy = agent.runtime?.activity;
    if (strategy && strategy.kind !== 'hooks') {
      if (strategy.detectIdle?.(data)) {
        this.flushCoalesced(sessionId);
        this.deps.emit({ type: 'ptyIdle', sessionId });
      } else if (data.length > 0 && this.resizeManager.shouldNotifyOnData(sessionId, data, session.activity)) {
        this.noteActivity(sessionId);
      }
    }
  }

  private onPtyExit(entry: PtyEntry, exitCode: number): void {
    if (entry.exited) return;
    entry.exited = true;
    for (const disposable of entry.disposables) {
      try {
        disposable.dispose();
      } catch {
        // Best effort.
      }
    }
    this.ptys.delete(entry.ptyId);
    const session = this.sessions.get(entry.sessionId);
    if (session?.livePtyId === entry.ptyId) session.livePtyId = null;
    this.backpressure.release(entry.sessionId);
    this.flushCoalesced(entry.sessionId);
    // Flush the transcript before main hears of the exit, as the spawn flow's
    // exit handler did.
    this.transcriptWriter.finalize(entry.sessionId);
    this.deps.emit({ type: 'exit', ptyId: entry.ptyId, sessionId: entry.sessionId, exitCode });
  }

  /**
   * The session's merge window, opened if none is. The first chunk of a burst
   * is reported at once (leading edge), so an idle session reads as active
   * without waiting out the window; the rest of the window is merged.
   */
  private openWindow(sessionId: string): { state: CoalesceState; opened: boolean } {
    let state = this.coalesce.get(sessionId);
    if (!state) {
      state = { chunks: 0, timer: null, activitySent: false, activityPending: false };
      this.coalesce.set(sessionId, state);
    }
    if (state.timer !== null) return { state, opened: false };
    state.timer = setTimeout(() => this.flushCoalesced(sessionId), this.deps.coalesceMs);
    return { state, opened: true };
  }

  /** Report output: per chunk in-process, merged per window in the utility. */
  private noteOutput(sessionId: string): void {
    if (this.deps.coalesceMs <= 0) {
      this.deps.emit({ type: 'outputSeen', sessionId, chunks: 1 });
      return;
    }
    const { state, opened } = this.openWindow(sessionId);
    if (opened) this.deps.emit({ type: 'outputSeen', sessionId, chunks: 1 });
    else state.chunks += 1;
  }

  private noteActivity(sessionId: string): void {
    if (this.deps.coalesceMs <= 0) {
      this.deps.emit({ type: 'ptyData', sessionId });
      return;
    }
    const { state } = this.openWindow(sessionId);
    if (!state.activitySent) {
      state.activitySent = true;
      this.deps.emit({ type: 'ptyData', sessionId });
    } else {
      state.activityPending = true;
    }
  }

  /** Send what a window merged, and close the window. */
  private flushCoalesced(sessionId: string): void {
    const state = this.coalesce.get(sessionId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (state.chunks > 0) {
      this.deps.emit({ type: 'outputSeen', sessionId, chunks: state.chunks });
      state.chunks = 0;
    }
    if (state.activityPending) this.deps.emit({ type: 'ptyData', sessionId });
    state.activitySent = false;
    state.activityPending = false;
  }
}
