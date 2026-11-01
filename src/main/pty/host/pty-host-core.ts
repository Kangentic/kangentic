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

import type { spawn } from 'node:child_process';
import * as nodePty from 'node-pty';
import type { ActivityState, AgentParser, ExitSequenceStep, StreamOutputParser } from '../../../shared/types';
import type { FromPtyHostPortMessage, ScrollbackInvokeResult, ToPtyHostPortMessage } from '../../../shared/pty-port-protocol';
import { createWriteQueue, type WriteQueue } from '../write-queue';
import { PromptDraftLedger, type WriteOrigin } from '../prompt-draft-ledger';
import { writeCarriesUserContent } from '../../../shared/terminal-input-content';
import { PtyBufferManager } from '../buffer/pty-buffer-manager';
import { TranscriptWriter, type TranscriptSink } from '../buffer/transcript-writer';
import { BackpressureController, STALE_PAUSE_CHECK_MS } from '../buffer/backpressure-controller';
import { ResizeManager } from '../lifecycle/resize-manager';
import { FirstOutputTracker } from '../lifecycle/first-output-tracker';
import { AgentOutputTracker } from '../lifecycle/agent-output-tracker';
import { SessionIdScanner } from '../lifecycle/session-id-manager';
import { getEventLoopLagReport, timeSyncWork } from '../../diagnostics/event-loop-lag';
import { armRoundTripProbe, noteRoundTripStage, readRoundTripProbe } from '../../diagnostics/pty-round-trip-probe';
import { captureThreadCpuProfile } from '../../diagnostics/thread-cpu-profile';
import { isProcessAlive } from '../../shared/process-liveness';
import type { ProcessInfo } from '../../activity-engine/background-shell/process-tree';
import { HostProcessTable } from './host-process-table';
import { endDeadRootOrphans, type DeadRootOrphanApi, type PinnedRoot } from './dead-root-orphans';
import {
  KILL_SNAPSHOT_CAP_MS,
  NO_AGENT_EXIT_WAIT,
  SPAWN_CLOCK_SLACK_MS,
  agentDescendantsOf,
  pruneExitedRoots,
  waitForExitedRootTrees,
  type AgentExitWaitResult,
  type ExitedRoot,
  type RootDescendant,
} from './exited-root-wait';
import {
  OUTPUT_NOT_CONNECTED_EXIT_CODE,
  ROOT_PID_WAIT_LIMIT_MS,
  RootPidGate,
  processNotStartedError,
  retryWindowMs,
  type RootPidOutcome,
} from './root-pid-gate';
import { writeToExitedConsole } from '../spawn/exited-console-input';
import { traceTerminal } from '../terminal-trace';
import { launchesOwnBinary } from './host-exec';
import { LocalSpawnService, type HostSpawnService, type SpawnServiceHooks } from './host-spawn-service';
import { createTaggedProcessReader } from '../process-tag/reader-factory';
import {
  TaggedReaper,
  emptyReapResult,
  stopAnswer,
  type StopProcessRequest,
  type StopProcessResult,
  type TaggedReapRequest,
  type TaggedReapResult,
  type TaggedReaperQueue,
} from '../process-tag/tagged-reap';
import type { TaggedProcessReader } from '../process-tag/process-scan';
import {
  toPtyHostError,
  type HostExecRequest,
  type PtyHostCommand,
  type PtyHostRawSpawnParams,
  type PtyHostRawSpawnResult,
  type PtyHostDiagnostics,
  type PtyHostEvent,
  type PtyHostRequestMap,
  type PtyHostSpawnParams,
  type PtyHostSpawnResult,
  type QueuedPtyHostMethod,
  type RendererPort,
  type SeedFrameResult,
} from './protocol';

/** A renderer's port message, checked before it is trusted: the renderer is
 *  another process, and a malformed message is dropped, never thrown on. */
function isPortMessage(value: unknown): value is ToPtyHostPortMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.sessionId !== 'string') return false;
  if (message.type === 'write') return typeof message.data === 'string';
  // A negative ack would raise the session's in-flight count and pause its PTY.
  if (message.type === 'ack') return typeof message.bytes === 'number' && Number.isFinite(message.bytes) && message.bytes >= 0;
  return false;
}

/** The request method each `TaggedReaper` queue answers, for `batch-started`. */
const QUEUED_METHOD_OF: Record<TaggedReaperQueue, QueuedPtyHostMethod> = {
  reap: 'reapTaggedProcesses',
  stop: 'stopReportedProcess',
};

/** Rolling window the session-id scan keeps: twice ConPTY's 4 KB flush. */
const SESSION_ID_SCAN_WINDOW = 8192;

/**
 * Refuse a PTY whose program is this app's own executable, or main's, as the
 * one-shot runs refuse it (`host-exec.ts`): with the RunAsNode fuse off it
 * boots a second app. A user's shell setting (a session's program) or an agent
 * CLI path override (a probe's) is the way one gets here.
 */
function refuseOwnExecutable(file: string): void {
  if (launchesOwnBinary({ kind: 'execFile', file, args: [], options: {} })) {
    throw new Error('The pty host does not launch its own executable');
  }
}

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
  /**
   * Starts every child process the host runs for main: the one-shot runs, the
   * agent CLI runs, the process table's probe. The utility host passes the
   * spawn worker's (`WorkerSpawnService`), so no process start holds the thread
   * that carries terminal input and output. `LocalSpawnService` otherwise.
   */
  createSpawnService?: (hooks: SpawnServiceHooks) => HostSpawnService;
  /** `LocalSpawnService`'s child spawner; `child_process.spawn` unless a test swaps it. */
  spawnChild?: typeof spawn;
  /** The task-tag reader; the platform's own unless a test swaps it. */
  createTaggedProcessReader?: () => TaggedProcessReader | null;
  /**
   * A reap batch or a Stop started running, after its wait in the queue. Only
   * the utility host passes it, to post `batch-started`: main restarts the
   * budget of every request of that method still waiting. The in-process core
   * has no request timers to restart.
   */
  onBatchStarted?: (method: QueuedPtyHostMethod) => void;
  /**
   * Pins every Windows PTY root from its pid to its exit, and ends what a
   * session's shell left running when it exited on its own
   * (`dead-root-orphans.ts`). Only the utility host passes it: the in-process
   * core runs the unit tests' fake PTYs, whose pids name real processes.
   */
  loadOrphanApi?: () => Promise<DeadRootOrphanApi>;
  /**
   * Lists processes just before a POSIX kill, so a reap can later wait for the
   * agent the shell started (`exited-root-wait.ts`): the shell's death
   * re-parents its children, and no parentage names them afterwards. Only the
   * utility host passes it; the in-process core's fake PTYs kill at once.
   */
  listProcessesBeforeKill?: () => Promise<ProcessInfo[]>;
  /** Whether a pid names a live process; `process.kill(pid, 0)` unless a test swaps it. */
  isProcessAlive?: (pid: number) => boolean;
  /** Defaults to `process.platform`; the orphan cleanup runs only on win32. */
  platform?: NodeJS.Platform;
  /** Defaults to `Date.now`. */
  now?: () => number;
}

/** A root whose children are Linux processes Win32 cannot see. */
function isWslRoot(file: string): boolean {
  return /(^|[\\/])wsl(\.exe)?$/i.test(file.trim());
}

/**
 * Subscribe to a new PTY's output and exit. With a pid gate, both are held
 * until the spawn has been answered (`root-pid-gate.ts`).
 */
function subscribeThroughGate(
  pty: nodePty.IPty,
  pidGate: RootPidGate | null,
  handleData: (data: string) => void,
  handleExit: (exitCode: number, signal: number | undefined) => void,
): nodePty.IDisposable[] {
  const onData = pidGate ? pidGate.gateOutput(handleData) : handleData;
  const onExit = pidGate ? pidGate.gateExit(handleExit) : handleExit;
  return [
    pty.onData(onData),
    pty.onExit(({ exitCode, signal }) => onExit(exitCode, signal)),
  ];
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
  /** `userInput` was sent for this session. */
  userInputReported: boolean;
  /** When the last `userInput` went to main (epoch ms), for its throttle. */
  lastUserInputReportAt: number | null;
}

/** At most one `userInput` report per session this often: a person typing sends one every ten seconds. */
const USER_INPUT_REPORT_INTERVAL_MS = 10_000;

/**
 * A PTY root the host can pin (`PinnedRoot`). The pin is taken once node-pty
 * has set the root's pid and closed as the host handles the root's exit. By
 * then node-pty has recorded the exit, so its kill no longer reaches for the
 * pid (`conpty-console-list.ts`). Until then a pid node-pty's own handle no
 * longer holds (it closes it before it reports the exit) cannot change hands.
 * Holding it longer would keep the dead shell in the process listing, where
 * the reap's protection walk from main would reach the leftovers under it.
 */
interface RootPinHolder {
  pty: nodePty.IPty;
  exited: boolean;
  /** Wall clock just before the spawn. */
  spawnedAtMs: number;
  rootPin: PinnedRoot | null;
  /** The root's creation time from its pin, kept once the pin is closed. */
  rootStartedAtMs: number | null;
}

interface RawPtyEntry extends RootPinHolder {
  /** A kill was sent. A second one is dropped: killing a ConPTY twice
   *  corrupts its heap on Windows. */
  killed: boolean;
}

interface PtyEntry extends RawPtyEntry {
  ptyId: number;
  sessionId: string;
  disposables: nodePty.IDisposable[];
  /** The root's exit time from its pin, read as the host handles the exit. */
  rootExitedAtMs: number | null;
  /** A WSL root: the orphan cleanup has nothing to look at. */
  wslRoot: boolean;
  /** Written to an agent the shell left running, so it exits on its own. */
  exitSequence: ExitSequenceStep[];
  /** The task the PTY runs for, so a reap can wait for what it leaves running. */
  taskId: string | null;
  /**
   * The PTY's serial write queue, created on the first queued write: a
   * renderer's keystrokes and main's queued writes (a paste, a submit, an
   * injected command) share it, so a key never lands inside a paste.
   */
  writeQueue: WriteQueue | null;
  /** Main took this PTY off its row (`sealUserInput`): a renderer's writes are dropped. */
  userInputSealed: boolean;
  /** Main cancelled the spawn (`cancelSpawn`): a never-connected attempt is not retried. */
  spawnCancelled: boolean;
}

/** One attempt at a session spawn whose answer waits on the pid (`answerOnPid`). */
interface GatedSpawnAttempt {
  params: PtyHostSpawnParams;
  /** The carry-over read at the spawn, handed back with a failed answer. */
  previousScrollback: string;
  /** Wall clock just before the first attempt; a retry's window counts from it. */
  firstSpawnedAtMs: number;
  /** How long the request waited for this loop before the first attempt (`sentAtMs`). */
  queuedMs: number;
  /** A retry's backstop (`retryWindowMs`); null on the first attempt. */
  retryLimitMs: number | null;
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
  /** The union of every renderer's visible set: these sessions flush to a renderer. */
  private readonly focused = new Set<string>();
  /** Each renderer's visible sessions (`setRendererFocus`), the routing table for output. */
  private readonly rendererFocus = new Map<number, Set<string>>();
  /** Each renderer's direct port: its keystrokes arrive on it and its output leaves on it. */
  private readonly rendererPorts = new Map<number, RendererPort>();
  /** What each session's user has typed and not sent, in the order the PTY gets it. */
  private readonly promptDrafts = new PromptDraftLedger();
  private readonly tapped = new Set<string>();
  /** The background-shell watcher's process table source, created on first
   *  use: Toolhelp on Windows, `ps` on POSIX (`host-process-table.ts`). */
  private processTable: HostProcessTable | null = null;
  /** Kills what a finished task left running, created on first use. */
  private taggedReaper: TaggedReaper | null = null;
  /** Raw PTYs (`spawnRaw`), by ptyId. */
  private readonly rawPtys = new Map<number, RawPtyEntry>();
  /** Every child process start: one-shot runs, agent CLI runs (`cliSpawn`), the process table's probe. */
  private readonly spawnService: HostSpawnService;
  private readonly firstOutput = new FirstOutputTracker();
  private readonly agentOutput = new AgentOutputTracker();
  private readonly resizeManager = new ResizeManager();
  private readonly coalesce = new Map<string, CoalesceState>();
  private readonly bufferManager: PtyBufferManager;
  private readonly transcriptWriter: TranscriptWriter;
  private readonly backpressure: BackpressureController;
  /** Looks for a pause no ack answers, armed only while a session is paused. */
  private stalePauseTimer: ReturnType<typeof setInterval> | null = null;
  private readonly spawnPty: typeof nodePty.spawn;
  private readonly now: () => number;
  /** Set by `shutdown`: a quit's exits are main's kills, and a cleanup in flight stops waiting. */
  private shuttingDown = false;
  /** Task PTY roots killed or exited lately, for a reap's wait (`exited-root-wait.ts`). */
  private exitedRoots: ExitedRoot[] = [];
  /** The POSIX pre-kill `ps` listing in flight, shared by kills that arrive together. */
  private preKillListing: Promise<ProcessInfo[]> | null = null;
  /** The orphan API once loaded, so a pin is taken in the turn a pid becomes known. */
  private orphanApi: DeadRootOrphanApi | null = null;
  /** Its load in flight. A failed load is tried again next time. */
  private orphanApiLoad: Promise<DeadRootOrphanApi | null> | null = null;
  /** A failed load is logged once per host. */
  private orphanApiLoadFailureLogged = false;

  constructor(private readonly deps: PtyHostCoreDeps) {
    this.spawnPty = deps.spawnPty ?? nodePty.spawn;
    this.now = deps.now ?? Date.now;
    // Loaded ahead, so the first PTY is pinned in the turn its pid is known.
    if (this.onWindows) void this.ensureOrphanApi();
    const spawnHooks: SpawnServiceHooks = { emit: (event) => this.deps.emit(event), pinRun: (pid) => this.pinRun(pid) };
    this.spawnService = deps.createSpawnService
      ? deps.createSpawnService(spawnHooks)
      : new LocalSpawnService(spawnHooks, { spawnChild: deps.spawnChild });
    this.bufferManager = new PtyBufferManager({
      onFlush: (sessionId, data, endOffset) => {
        this.consumeFirstOutput(sessionId, data);
        if (this.tapped.has(sessionId)) this.deps.emit({ type: 'tap', sessionId, data, endOffset });
        if (this.focused.has(sessionId)) {
          if (__KANGENTIC_DEV__) noteRoundTripStage(sessionId, 'flush', data);
          // Straight to each renderer that shows it, on its own port: output
          // never crosses main, so main's event loop cannot hold an echo back.
          // Bytes no port took (a reloading page still in the focus set) are
          // never acked, so they do not count toward a pause.
          if (this.postToRenderersShowing(sessionId, { type: 'data', sessionId, data }) === 0) return;
          const wasPaused = __KANGENTIC_DEV__ && this.backpressure.isPaused(sessionId);
          this.backpressure.recordEmitted(sessionId, data.length);
          if (__KANGENTIC_DEV__ && !wasPaused && this.backpressure.isPaused(sessionId)) noteRoundTripStage(sessionId, 'pause', '');
          this.armStalePauseCheck(sessionId);
        }
      },
      onDrain: (sessionId, data, endOffset) => {
        // A replay sample took these bytes out of the pending buffer; the
        // renderer gets them inside the reply. Only the first-output latch and
        // a phone's tap still need them.
        this.consumeFirstOutput(sessionId, data);
        if (this.tapped.has(sessionId)) this.deps.emit({ type: 'tap', sessionId, data, endOffset });
      },
      onAltScreenEnter: (sessionId) => {
        this.deps.emit({ type: 'altScreen', sessionId, inAltScreen: true });
      },
      onAltScreenExit: (sessionId) => {
        this.deps.emit({ type: 'altScreen', sessionId, inAltScreen: false });
      },
      // The flush above reaches a renderer only when focused, a phone only when tapped.
      hasFlushConsumer: (sessionId) => this.focused.has(sessionId) || this.tapped.has(sessionId),
      onPendingChange: (sessionId, chars) => {
        const wasPaused = __KANGENTIC_DEV__ && this.backpressure.isPaused(sessionId);
        this.backpressure.recordPending(sessionId, chars);
        if (__KANGENTIC_DEV__ && !wasPaused && this.backpressure.isPaused(sessionId)) noteRoundTripStage(sessionId, 'pause', '');
        this.armStalePauseCheck(sessionId);
      },
    });
    this.transcriptWriter = new TranscriptWriter(
      (sessionId) => {
        const session = this.sessions.get(sessionId);
        return session && !session.transient ? session.projectId : null;
      },
      (projectId) => this.deps.transcriptSinkFor(projectId),
    );
    this.backpressure = new BackpressureController(
      (sessionId) => {
        const ptyId = this.sessions.get(sessionId)?.livePtyId;
        const entry = ptyId === null || ptyId === undefined ? undefined : this.ptys.get(ptyId);
        return entry && !entry.exited ? entry.pty : null;
      },
      { now: () => this.now() },
    );
  }

  /**
   * Start looking for a stale pause once `sessionId` is paused. A paused PTY
   * reads nothing, so no flush comes along to notice that nothing acks it: a
   * timer has to. Armed only while a session is paused, so an idle host runs
   * none, and unref'd so it never holds the process open.
   */
  private armStalePauseCheck(sessionId: string): void {
    if (this.stalePauseTimer || this.shuttingDown || !this.backpressure.isPaused(sessionId)) return;
    this.stalePauseTimer = setInterval(() => this.checkStalePauses(), STALE_PAUSE_CHECK_MS);
    this.stalePauseTimer.unref?.();
  }

  /** Resume what no renderer has acked for `STALE_PAUSE_MS` (see `releaseStalePauses`). */
  private checkStalePauses(): void {
    for (const release of this.backpressure.releaseStalePauses()) {
      // Warned as well as traced: the trace ring is dev-only, and a packaged
      // build is where a crashed page would otherwise stall an agent unseen.
      console.warn(`[pty-host] session ${release.sessionId.slice(0, 8)} paused with ${release.inFlight} chars unacknowledged and no ack for ${release.idleMs} ms; resuming it with a raised high water until a renderer acknowledges again`);
      traceTerminal(release.sessionId, 'backpressure-stale-release', { inFlight: release.inFlight, idleMs: release.idleMs });
    }
    if (!this.backpressure.hasPausedSession()) this.stopStalePauseCheck();
  }

  private stopStalePauseCheck(): void {
    if (!this.stalePauseTimer) return;
    clearInterval(this.stalePauseTimer);
    this.stalePauseTimer = null;
  }

  // --- Requests -------------------------------------------------------------

  /**
   * Answers at once when node-pty set the pid at the spawn (POSIX), and once
   * it has set it otherwise (Windows ConPTY; `root-pid-gate.ts`). A ConPTY
   * whose output never connected is spawned once more before the answer
   * (`answerGatedSpawn`).
   */
  spawn(params: PtyHostSpawnParams): PtyHostSpawnResult | Promise<PtyHostSpawnResult> {
    // The carry-over is copied, so a resume shows unbroken history (see
    // performSpawn). The source's own state stays until main removes it, which
    // it does only once the spawn is known not to have been cancelled.
    const carrySource = params.carryoverFromSessionId;
    const previousScrollback = carrySource ? this.bufferManager.getRawScrollback(carrySource) : '';
    const previousGeometry = carrySource ? this.bufferManager.getCarryoverGeometry(carrySource) : null;

    let pty: nodePty.IPty;
    const spawnedAtMs = this.now();
    // Main stamped the send with its own `Date.now()`, so this reads the same
    // clock. A request held behind a busy loop has spent that much of main's
    // budget before the first attempt starts.
    const queuedMs = params.sentAtMs === undefined ? 0 : Math.max(0, Date.now() - params.sentAtMs);
    try {
      refuseOwnExecutable(params.file);
      pty = this.spawnSessionPty(params);
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
      userInputReported: false,
      lastUserInputReportAt: null,
    });
    this.bufferManager.initSession(
      params.sessionId,
      previousScrollback,
      params.cols,
      params.rows,
      previousGeometry,
      params.transient,
    );

    const entry: PtyEntry = {
      ptyId: params.ptyId,
      sessionId: params.sessionId,
      pty,
      exited: false,
      killed: false,
      disposables: [],
      spawnedAtMs,
      rootPin: null,
      rootStartedAtMs: null,
      rootExitedAtMs: null,
      wslRoot: isWslRoot(params.file),
      exitSequence: params.exitSequence ?? ['\x03'],
      taskId: params.taskId ?? null,
      writeQueue: null,
      userInputSealed: false,
      spawnCancelled: false,
    };
    this.ptys.set(params.ptyId, entry);
    return this.answerOnPid(entry, { params, previousScrollback, firstSpawnedAtMs: spawnedAtMs, queuedMs, retryLimitMs: null });
  }

  /** Start a session's PTY, the first attempt and a retry alike. */
  private spawnSessionPty(params: PtyHostSpawnParams): nodePty.IPty {
    // Labelled like the `cli:spawn:<program>` spans: the pseudo console and its console host
    // start on this thread, which every terminal's output shares.
    return timeSyncWork('pty:spawn', () => this.spawnPty(params.file, params.args, {
      name: 'xterm-256color',
      cols: params.cols,
      rows: params.rows,
      cwd: params.cwd,
      env: params.env,
    }));
  }

  /**
   * Subscribe to the entry's PTY and answer the spawn: at once when node-pty
   * set the pid at the spawn, otherwise once it has (`root-pid-gate.ts`).
   */
  private answerOnPid(entry: PtyEntry, attempt: GatedSpawnAttempt): PtyHostSpawnResult | Promise<PtyHostSpawnResult> {
    // Holds the PTY's events while the answer waits for node-pty to set the
    // pid (Windows). Null when it was set at the spawn.
    const pidGate = entry.pty.pid > 0
      ? null
      : new RootPidGate(entry.pty, attempt.retryLimitMs ?? ROOT_PID_WAIT_LIMIT_MS);
    entry.disposables.push(...subscribeThroughGate(
      entry.pty,
      pidGate,
      (data) => timeSyncWork('pty:data', () => this.onPtyData(entry, data)),
      (exitCode) => this.onPtyExit(entry, exitCode),
    ));
    if (!pidGate) {
      this.pinRootOf(entry);
      return { ok: true, pid: entry.pty.pid };
    }
    return pidGate.outcome.then((outcome) => this.answerGatedSpawn(entry, pidGate, outcome, attempt));
  }

  /** Answer a spawn whose pid node-pty had not set yet (see `spawn`). */
  private answerGatedSpawn(
    entry: PtyEntry,
    pidGate: RootPidGate,
    outcome: RootPidOutcome,
    attempt: GatedSpawnAttempt,
  ): PtyHostSpawnResult | Promise<PtyHostSpawnResult> {
    if (outcome.kind === 'failed') {
      // Nothing started, so this is a failed spawn, not a session that ended:
      // main hears no exit. The attempt's listeners go first, so nothing the
      // dead PTY still emits reaches the entry a retry reuses.
      pidGate.discard();
      for (const disposable of entry.disposables) disposable.dispose();
      entry.disposables.length = 0;
      const retryLimitMs = this.retryLimitFor(entry, outcome.exitCode, attempt);
      if (retryLimitMs !== null) {
        console.warn(`[pty-host] session ${entry.sessionId.slice(0, 8)}'s PTY output never connected after ${this.now() - entry.spawnedAtMs} ms (longest pty host stall ${pidGate.longestStallMs} ms); spawning it once more`);
        try {
          entry.pty = this.spawnSessionPty(attempt.params);
        } catch (error) {
          return this.failGatedSpawn(entry, error, attempt.previousScrollback);
        }
        entry.spawnedAtMs = this.now();
        return this.answerOnPid(entry, { ...attempt, retryLimitMs });
      }
      return this.failGatedSpawn(
        entry,
        processNotStartedError(outcome.exitCode, this.now() - entry.spawnedAtMs, pidGate.longestStallMs),
        attempt.previousScrollback,
      );
    }
    if (outcome.kind === 'timedOut') {
      console.warn(`[pty-host] session ${entry.sessionId.slice(0, 8)}'s PTY reported no pid and no exit within the wait; answering without its pid, so its root is not pinned and nothing it leaves running at a natural exit is cleaned up`);
    }
    this.pinRootOf(entry);
    pidGate.release();
    return { ok: true, pid: entry.pty.pid };
  }

  /**
   * The backstop for a second attempt at a spawn whose output never connected
   * (`root-pid-gate.ts`), or null when it gets none. Only the first attempt is
   * retried, and only while it is still wanted: not in a quit, not after main
   * gave up and killed the ptyId (its request timed out), not after a teardown
   * cancelled the spawn (`cancelSpawn`), and not when the session is no longer
   * this PTY's (removed, or spawned again since). The retry must also fit
   * inside main's budget for the answer, which runs from main's send.
   */
  private retryLimitFor(entry: PtyEntry, exitCode: number, attempt: GatedSpawnAttempt): number | null {
    if (exitCode !== OUTPUT_NOT_CONNECTED_EXIT_CODE || attempt.retryLimitMs !== null) return null;
    if (this.shuttingDown || entry.killed || entry.spawnCancelled) return null;
    if (this.sessions.get(entry.sessionId)?.livePtyId !== entry.ptyId) return null;
    return retryWindowMs(attempt.queuedMs + this.now() - attempt.firstSpawnedAtMs);
  }

  /** Answer a gated spawn as failed: the host forgets the session as if the spawn had thrown. */
  private failGatedSpawn(entry: PtyEntry, error: unknown, previousScrollback: string): PtyHostSpawnResult {
    // Main's failure path seeds the session's ring again.
    entry.exited = true;
    this.ptys.delete(entry.ptyId);
    if (this.sessions.get(entry.sessionId)?.livePtyId === entry.ptyId) this.dropSession(entry.sessionId);
    return { ok: false, error: toPtyHostError(error), previousScrollback };
  }

  async getScrollback(sessionId: string, settle: boolean): Promise<string> {
    if (settle) await this.bufferManager.waitForResizeRepaint(sessionId);
    return this.bufferManager.getReplaySnapshot(sessionId);
  }

  /**
   * A renderer's replay, answered on its own port. The sample's answer leaves
   * in the same turn the sample ends, on the port that carries the session's
   * output, so every byte flushed before the sample arrives before the answer
   * and every byte after it arrives after: the order the renderer's held-byte
   * drop relies on (`useTerminal.ts`). Main only learns where the answer went.
   */
  async getScrollbackForRenderer(params: PtyHostRequestMap['getScrollbackForRenderer']['params']): Promise<ScrollbackInvokeResult> {
    // A reload replaces the renderer's port while the sample settles, and the
    // reloaded page numbers its requests from 1 again: an answer posted on the
    // new port could settle that page's request with this one's data. The
    // answer goes only on the port that asked, while it is still the current one.
    const askingPort = this.rendererPorts.get(params.rendererId);
    const answerPort = (): RendererPort | undefined => {
      const current = this.rendererPorts.get(params.rendererId);
      return askingPort === undefined || current === askingPort ? current : undefined;
    };
    let data: string;
    try {
      data = await this.getScrollback(params.sessionId, params.settle);
    } catch (error) {
      const port = answerPort();
      if (!port) throw error;
      port.postMessage({ type: 'scrollbackFailed', requestId: params.requestId, message: error instanceof Error ? error.message : String(error) });
      return { sentToPort: true };
    }
    const port = answerPort();
    if (!port) return { sentToPort: false, data };
    port.postMessage({ type: 'scrollback', requestId: params.requestId, data });
    return { sentToPort: true };
  }

  /**
   * Take a renderer's direct port (main brokers one per renderer and replaces
   * it on a reload or a host restart). Its keystrokes and acks arrive on it,
   * and the output of the sessions it shows leaves on it.
   */
  attachRendererPort(rendererId: number, port: RendererPort): void {
    const previous = this.rendererPorts.get(rendererId);
    if (previous && previous !== port) {
      try {
        previous.close();
      } catch {
        // Already closed with the page that held it.
      }
    }
    this.rendererPorts.set(rendererId, port);
    port.on('message', (messageEvent) => this.onPortMessage(messageEvent.data));
    port.on('close', () => {
      if (this.rendererPorts.get(rendererId) === port) this.rendererPorts.delete(rendererId);
    });
    port.start();
  }

  private onPortMessage(message: unknown): void {
    if (!isPortMessage(message)) return;
    if (message.type === 'ack') {
      this.backpressure.acknowledge(message.sessionId, message.bytes);
      return;
    }
    this.writeUserInput(message.sessionId, message.data);
  }

  /** A renderer's keystrokes for a session: to its live PTY, unless main sealed it. */
  private writeUserInput(sessionId: string, data: string): void {
    const ptyId = this.sessions.get(sessionId)?.livePtyId;
    const entry = ptyId === null || ptyId === undefined ? undefined : this.ptys.get(ptyId);
    if (!entry || entry.exited || entry.userInputSealed || data.length === 0) return;
    this.enqueueWrite(entry, data, 'user');
  }

  /** Into the PTY's write queue, written at once when nothing is ahead of it. */
  private enqueueWrite(entry: PtyEntry, data: string, origin: WriteOrigin): void {
    if (entry.exited || data.length === 0) return;
    this.stampInput(entry, data);
    this.recordDraft(entry.sessionId, data, origin);
    // xterm's own replies (device attributes, cursor position, focus and mouse
    // reports) arrive here as 'user' too, so only a write that carries a key
    // or text marks the session used.
    if (origin === 'user' && writeCarriesUserContent(data)) this.reportUserInput(entry.sessionId);
    entry.writeQueue ??= createWriteQueue(
      () => (entry.exited ? null : entry.pty),
      undefined,
      { onAutoDispose: () => { entry.writeQueue = null; } },
    );
    entry.writeQueue.enqueue(data);
  }

  /** Input is about to reach this PTY, queued or direct. */
  private stampInput(entry: PtyEntry, data: string): void {
    if (__KANGENTIC_DEV__) noteRoundTripStage(entry.sessionId, 'write', data);
    // In the alt screen, the answer to this input flushes on the next loop turn, not the 16 ms timer.
    this.bufferManager.noteInput(entry.sessionId);
  }

  /** Fold a write into the session's draft, and tell main when the draft changed. */
  private recordDraft(sessionId: string, data: string, origin: WriteOrigin): void {
    const before = this.promptDrafts.get(sessionId);
    this.promptDrafts.record(sessionId, data, origin);
    const after = this.promptDrafts.get(sessionId);
    if (after !== before) this.deps.emit({ type: 'promptDraft', sessionId, draft: after });
  }

  /**
   * Tell main that a human used this session: at once the first time, then at
   * most once every `USER_INPUT_REPORT_INTERVAL_MS`, so main knows when a
   * person last typed without an event per keystroke.
   */
  private reportUserInput(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const now = Date.now();
    // A wall clock stepped back (an NTP step, a VM resume) reports at once,
    // rather than holding every report until the clock catches up.
    const sinceLastReport = session.lastUserInputReportAt === null ? null : now - session.lastUserInputReportAt;
    if (session.userInputReported && sinceLastReport !== null
      && sinceLastReport >= 0 && sinceLastReport < USER_INPUT_REPORT_INTERVAL_MS) return;
    session.userInputReported = true;
    session.lastUserInputReportAt = now;
    this.deps.emit({ type: 'userInput', sessionId, at: now });
  }

  private clearDraft(sessionId: string): void {
    if (this.promptDrafts.get(sessionId) === null) return;
    this.promptDrafts.clear(sessionId);
    this.deps.emit({ type: 'promptDraft', sessionId, draft: null });
  }

  /** Stop a PTY's queued writes: what is still queued is dropped. */
  private disposeWriteQueue(entry: PtyEntry): void {
    entry.writeQueue?.dispose();
    entry.writeQueue = null;
  }

  /** Post to every renderer that shows the session. Returns how many ports took it. */
  private postToRenderersShowing(sessionId: string, message: FromPtyHostPortMessage): number {
    let posted = 0;
    for (const [rendererId, sessionIds] of this.rendererFocus) {
      if (!sessionIds.has(sessionId)) continue;
      const port = this.rendererPorts.get(rendererId);
      if (!port) continue;
      port.postMessage(message);
      posted += 1;
    }
    return posted;
  }

  /** The same union `SessionManager.recomputeFocusedUnion` keeps from the same
   *  per-renderer sets (`setRendererFocus`). Change the two together: main reads
   *  its copy to decide what is watched, and this one gates the flush. */
  private recomputeFocused(): void {
    this.focused.clear();
    for (const sessionIds of this.rendererFocus.values()) {
      for (const sessionId of sessionIds) this.focused.add(sessionId);
    }
  }

  async getSerializedFrame(sessionId: string, settle: boolean): Promise<string> {
    if (settle) await this.bufferManager.waitForResizeRepaint(sessionId);
    return this.bufferManager.getSerializedFrame(sessionId);
  }

  /**
   * The mobile seed with its parser barrier offset (PtyBufferManager.getSeedFrame),
   * after the same settle. The two phases are timed separately for the phone's
   * slow-request line: a slow open caused by the repaint settle is not fixed by
   * serializing fewer rows, and one caused by the serialize is.
   */
  async getSeedFrame(sessionId: string, settle: boolean, scrollbackLines?: number): Promise<SeedFrameResult> {
    const settleStartedAt = performance.now();
    if (settle) await this.bufferManager.waitForResizeRepaint(sessionId);
    const serializeStartedAt = performance.now();
    const seed = await this.bufferManager.getSeedFrame(sessionId, scrollbackLines);
    return {
      ...seed,
      settleMs: Math.round(serializeStartedAt - settleStartedAt),
      serializeMs: Math.round(performance.now() - serializeStartedAt),
    };
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
        return this.spawn(params as PtyHostSpawnParams) as PtyHostRequestMap[M]['result'] | Promise<PtyHostRequestMap[M]['result']>;
      case 'getScrollback': {
        const { sessionId, settle } = params as PtyHostRequestMap['getScrollback']['params'];
        return this.getScrollback(sessionId, settle) as Promise<PtyHostRequestMap[M]['result']>;
      }
      case 'getScrollbackForRenderer':
        return this.getScrollbackForRenderer(params as PtyHostRequestMap['getScrollbackForRenderer']['params']) as Promise<PtyHostRequestMap[M]['result']>;
      case 'drainWrites': {
        const queue = this.ptys.get((params as PtyHostRequestMap['drainWrites']['params']).ptyId)?.writeQueue;
        return (queue ? queue.drained().then(() => true as const) : Promise.resolve(true as const)) as Promise<PtyHostRequestMap[M]['result']>;
      }
      case 'getPromptDraft':
        return this.promptDrafts.get((params as PtyHostRequestMap['getPromptDraft']['params']).sessionId) as PtyHostRequestMap[M]['result'];
      case 'getSerializedFrame': {
        const { sessionId, settle } = params as PtyHostRequestMap['getSerializedFrame']['params'];
        return this.getSerializedFrame(sessionId, settle) as Promise<PtyHostRequestMap[M]['result']>;
      }
      case 'getSeedFrame': {
        const { sessionId, settle, scrollbackLines } = params as PtyHostRequestMap['getSeedFrame']['params'];
        return this.getSeedFrame(sessionId, settle, scrollbackLines) as Promise<PtyHostRequestMap[M]['result']>;
      }
      case 'getRawScrollback':
        return this.getRawScrollback((params as { sessionId: string }).sessionId) as PtyHostRequestMap[M]['result'];
      case 'getOutputPeek':
        return this.getOutputPeek((params as { sessionId: string }).sessionId) as PtyHostRequestMap[M]['result'];
      case 'getDiagnostics':
        return this.getDiagnostics() as PtyHostRequestMap[M]['result'];
      case 'ping':
        return 'pong' as PtyHostRequestMap[M]['result'];
      case 'closeProject':
        this.deps.closeProject?.((params as { projectId: string }).projectId);
        return true as PtyHostRequestMap[M]['result'];
      case 'exec':
        return this.spawnService.exec(params as HostExecRequest) as Promise<PtyHostRequestMap[M]['result']>;
      case 'listProcesses':
        this.processTable ??= new HostProcessTable({ createFallbackProbe: () => this.spawnService.processTableProbe() });
        return this.processTable.list() as Promise<PtyHostRequestMap[M]['result']>;
      case 'reapTaggedProcesses':
        return this.reapTaggedProcesses(params as TaggedReapRequest) as Promise<PtyHostRequestMap[M]['result']>;
      case 'stopReportedProcess':
        return this.stopReportedProcess(params as StopProcessRequest) as Promise<PtyHostRequestMap[M]['result']>;
      case 'checkReportedProcesses':
        return this.checkReportedProcesses((params as PtyHostRequestMap['checkReportedProcesses']['params']).identities) as Promise<PtyHostRequestMap[M]['result']>;
      case 'awaitAgentExit':
        return this.awaitAgentExit((params as PtyHostRequestMap['awaitAgentExit']['params']).taskIds) as Promise<PtyHostRequestMap[M]['result']>;
      case 'spawnRaw':
        return this.spawnRaw(params as PtyHostRawSpawnParams) as PtyHostRequestMap[M]['result'] | Promise<PtyHostRequestMap[M]['result']>;
      case 'devArmRoundTripProbe':
        if (!__KANGENTIC_DEV__) throw new Error(`${method} is dev-only`);
        return armRoundTripProbe((params as PtyHostRequestMap['devArmRoundTripProbe']['params']).durationMs) as PtyHostRequestMap[M]['result'];
      case 'devReadRoundTripProbe':
        if (!__KANGENTIC_DEV__) throw new Error(`${method} is dev-only`);
        return readRoundTripProbe() as PtyHostRequestMap[M]['result'];
      case 'devLagReport':
        if (!__KANGENTIC_DEV__) throw new Error(`${method} is dev-only`);
        return getEventLoopLagReport() as PtyHostRequestMap[M]['result'];
      case 'devCpuProfile':
        if (!__KANGENTIC_DEV__) throw new Error(`${method} is dev-only`);
        return captureThreadCpuProfile((params as PtyHostRequestMap['devCpuProfile']['params']).durationMs) as Promise<PtyHostRequestMap[M]['result']>;
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
        if (this.withRawPty(command.ptyId, (rawPty) => rawPty.write(command.data))) return;
        this.withLivePty(command.ptyId, (entry) => {
          this.stampInput(entry, command.data);
          entry.pty.write(command.data);
        });
        return;
      case 'enqueueWrite':
        // Main's queued writes; a sealed PTY takes only the direct ones (its exit sequence).
        this.withLivePty(command.ptyId, (entry) => {
          if (!entry.userInputSealed) this.enqueueWrite(entry, command.data, command.origin);
        });
        return;
      case 'sealUserInput': {
        const entry = this.ptys.get(command.ptyId);
        if (!entry) return;
        entry.userInputSealed = true;
        // Main dropped its row's handle, so what was still queued for it goes
        // too, as main's own queue dropped it when the handle was nulled.
        this.disposeWriteQueue(entry);
        return;
      }
      case 'resizePty': {
        if (this.withRawPty(command.ptyId, (rawPty) => rawPty.resize(command.cols, command.rows))) return;
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
        if (this.killRaw(command.ptyId)) return;
        this.kill(command.ptyId);
        return;
      case 'setRendererFocus':
        if (command.sessionIds.length === 0) this.rendererFocus.delete(command.rendererId);
        else this.rendererFocus.set(command.rendererId, new Set(command.sessionIds));
        this.recomputeFocused();
        return;
      case 'forgetRenderer': {
        this.rendererFocus.delete(command.rendererId);
        this.recomputeFocused();
        const port = this.rendererPorts.get(command.rendererId);
        this.rendererPorts.delete(command.rendererId);
        try {
          port?.close();
        } catch {
          // Closed with its page already.
        }
        return;
      }
      case 'setTapped':
        this.tapped.clear();
        for (const sessionId of command.sessionIds) this.tapped.add(sessionId);
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
      case 'cancelSpawn':
        // Read only by `retryLimitFor`: a spawn still waiting on its pid is not
        // tried again. A second attempt already started runs on, because
        // node-pty holds a kill until a ConPTY's first output. Main abandons
        // what the answer brings back.
        for (const entry of this.ptys.values()) {
          if (entry.sessionId === command.sessionId) entry.spawnCancelled = true;
        }
        return;
      case 'initSession':
        this.bufferManager.initSession(command.sessionId, command.scrollback, command.cols);
        return;
      case 'cliSpawn':
        this.spawnService.startCli(command.params);
        return;
      case 'cliWrite':
        this.spawnService.writeCli(command.processId, command.data);
        return;
      case 'cliEndInput':
        this.spawnService.endCliInput(command.processId, command.data);
        return;
      case 'cliStop':
        this.spawnService.stopCli(command.processId);
        return;
      case 'shutdown':
        // Main's killAll has already posted every kill, a young session's
        // after its exit-sequence grace (pty-teardown-grace), so killing here
        // would cut that grace short. Nothing writes the transcripts after this.
        this.shuttingDown = true;
        this.stopStalePauseCheck();
        this.transcriptWriter.finalizeAll();
        this.disposeProcessTable();
        // Raw PTYs are probes nobody waits on; end them now so the exit wait
        // covers them too.
        for (const ptyId of [...this.rawPtys.keys()]) this.killRaw(ptyId);
        // A CLI left running would keep its run directory, and the live MCP
        // token in it, on disk after the app is gone. Main's stopAllCliRuns
        // has posted most of these stops already; a second is a no-op.
        this.spawnService.stopAllCli();
        return;
      default: {
        const unknownCommand: never = command;
        throw new Error(`unknown pty host command: ${JSON.stringify(unknownCommand)}`);
      }
    }
  }

  /**
   * Kill what the given tasks left running (`process-tag/tagged-reap.ts`).
   * The PTY roots protected from the kill are read from this host's own table
   * on every scan, so a young PTY whose kill main deferred for its exit grace,
   * and a PTY spawned after the request, are both covered.
   */
  reapTaggedProcesses(request: TaggedReapRequest): Promise<TaggedReapResult> {
    const reaper = this.ensureTaggedReaper();
    if (!reaper) return Promise.resolve(emptyReapResult());
    return reaper.request(request);
  }

  /**
   * Stop one process a reap reported, with everything under it, after the
   * user asked for it by name. Kangentic's tree and every PTY this host holds
   * stay out of reach, as in a reap.
   */
  stopReportedProcess(request: StopProcessRequest): Promise<StopProcessResult> {
    const reaper = this.ensureTaggedReaper();
    if (!reaper) return Promise.resolve(stopAnswer('failed'));
    return reaper.stop(request);
  }

  /**
   * Whether each process a report named still runs, for the leftover list's
   * recheck. Identity only (pid and start key), never a scan.
   */
  checkReportedProcesses(identities: ReadonlyArray<{ pid: number; startKey: string }>): Promise<Array<boolean | null>> {
    const reaper = this.ensureTaggedReaper();
    if (!reaper) return Promise.resolve(identities.map(() => null));
    return reaper.checkRunning(identities);
  }

  /**
   * Wait for what these tasks' exited shells left running to exit by itself,
   * before main's reap of them (`exited-root-wait.ts`). Answers at once when
   * nothing of theirs was killed or exited lately, in the in-process core, and
   * during a quit.
   */
  async awaitAgentExit(taskIds: readonly string[]): Promise<AgentExitWaitResult> {
    this.exitedRoots = pruneExitedRoots(this.exitedRoots, this.now());
    const wanted = new Set(taskIds);
    const roots = this.exitedRoots.filter((root) => wanted.has(root.taskId));
    if (roots.length === 0 || this.shuttingDown) return NO_AGENT_EXIT_WAIT;
    // The Win32 API is needed only for a killed root read by parentage.
    const needsParentage = roots.some((root) => !root.orphanCleanup && !root.descendants);
    const api = needsParentage ? await this.ensureOrphanApi() : null;
    return waitForExitedRootTrees(
      api,
      roots,
      new Set([process.pid, process.ppid, ...this.liveRootPids()]),
      {
        sleep: (ms) => this.sleepUnref(ms),
        now: this.now,
        isStopping: () => this.shuttingDown,
        isAlive: this.deps.isProcessAlive ?? isProcessAlive,
      },
    );
  }

  /** `deps.platform`, else this process's, is Windows. */
  private get onWindows(): boolean {
    return (this.deps.platform ?? process.platform) === 'win32';
  }

  /**
   * The orphan API, loaded once and kept (the utility host on Windows only;
   * null elsewhere). A load that fails is logged once and tried again on the
   * next use.
   */
  private ensureOrphanApi(): Promise<DeadRootOrphanApi | null> {
    const load = this.deps.loadOrphanApi;
    if (!load) return Promise.resolve(null);
    if (this.orphanApi) return Promise.resolve(this.orphanApi);
    this.orphanApiLoad ??= load().then(
      (api) => {
        this.orphanApi = api;
        return api;
      },
      (error: unknown) => {
        this.orphanApiLoad = null;
        if (!this.orphanApiLoadFailureLogged) {
          this.orphanApiLoadFailureLogged = true;
          console.warn('[pty-host] could not load the Windows process API:', error instanceof Error ? error.message : String(error));
        }
        return null;
      },
    );
    return this.orphanApiLoad;
  }

  /**
   * Pin a Windows PTY root once node-pty has set its pid (`RootPinHolder`): at
   * once when the orphan API is loaded, else when its load lands, unless the
   * root's exit was handled first.
   */
  private pinRootOf(holder: RootPinHolder): void {
    if (!this.deps.loadOrphanApi || !this.onWindows) return;
    const pin = (api: DeadRootOrphanApi | null): void => {
      if (!api || holder.exited || holder.rootPin || holder.pty.pid <= 0) return;
      try {
        holder.rootPin = timeSyncWork('pty:pinRoot', () => api.pinRoot(holder.pty.pid, holder.spawnedAtMs - SPAWN_CLOCK_SLACK_MS));
      } catch (error) {
        console.warn('[pty-host] could not pin a PTY root:', error instanceof Error ? error.message : String(error));
        return;
      }
      if (holder.rootPin) holder.rootStartedAtMs = holder.rootPin.startedAtMs;
    };
    if (this.orphanApi) pin(this.orphanApi);
    else void this.ensureOrphanApi().then(pin);
  }

  /**
   * Pin an agent CLI run's pid while its tree kill runs (`child-tree-stop.ts`):
   * the run is this host's child and has not exited, so the pid is still its
   * own. Answers what closes the pin, or null without the orphan API.
   */
  private pinRun(pid: number): (() => void) | null {
    if (!this.orphanApi || !this.onWindows) return null;
    try {
      const pin = this.orphanApi.pinRoot(pid, 0);
      return pin ? () => pin.release() : null;
    } catch (error) {
      console.warn('[pty-host] could not pin a CLI run:', error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /**
   * Read the root's exit time off its pin and close the pin. Null without one,
   * or when the read fails. Never throws: it runs inside the exit handling,
   * which must still tell main the PTY ended.
   */
  private unpinRoot(holder: RootPinHolder): number | null {
    const pin = holder.rootPin;
    if (!pin) return null;
    holder.rootPin = null;
    try {
      return pin.readExitedAtMs();
    } catch (error) {
      console.warn('[pty-host] could not read a PTY root\'s exit time:', error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      try {
        pin.release();
      } catch {
        // The handle is the host's own; nothing else holds it.
      }
    }
  }

  private sleepUnref(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  private ensureTaggedReaper(): TaggedReaper | null {
    if (!this.taggedReaper) {
      const reader = (this.deps.createTaggedProcessReader ?? createTaggedProcessReader)();
      if (!reader) return null;
      this.taggedReaper = new TaggedReaper({
        reader,
        liveRootPids: () => this.liveRootPids(),
        onBatchStart: (kind) => this.deps.onBatchStarted?.(QUEUED_METHOD_OF[kind]),
      });
    }
    return this.taggedReaper;
  }

  /** Every PTY this host still holds, session and raw, by root pid. */
  private liveRootPids(): number[] {
    const pids: number[] = [];
    for (const entry of this.ptys.values()) {
      if (!entry.exited && entry.pty.pid > 0) pids.push(entry.pty.pid);
    }
    for (const raw of this.rawPtys.values()) {
      if (raw.pty.pid > 0) pids.push(raw.pty.pid);
    }
    return pids;
  }

  /** End the process table's fallback PowerShell child, if one runs. */
  disposeProcessTable(): void {
    this.processTable?.dispose();
    this.processTable = null;
  }

  /** Flush every pending transcript piece (in-process quit). */
  finalizeTranscripts(): void {
    this.transcriptWriter.finalizeAll();
  }

  /** PTYs still waiting for their exit callback, raw ones included. */
  get livePtyCount(): number {
    let count = this.rawPtys.size;
    for (const entry of this.ptys.values()) if (!entry.exited) count += 1;
    return count;
  }

  /** Everything the shutdown waits on: the live PTYs and CLI runs. */
  get liveChildCount(): number {
    return this.livePtyCount + this.spawnService.liveCliCount;
  }

  /**
   * Spawn a raw PTY: output goes back as `rawData` per chunk, with none of
   * the session pipeline. For the short probes that drive a CLI's TUI.
   */
  spawnRaw(params: PtyHostRawSpawnParams): PtyHostRawSpawnResult | Promise<PtyHostRawSpawnResult> {
    let rawPty: nodePty.IPty;
    const spawnedAtMs = this.now();
    try {
      refuseOwnExecutable(params.file);
      // A probe's pseudo console starts on this thread too, like `pty:spawn`.
      rawPty = timeSyncWork('pty:spawnRaw', () => this.spawnPty(params.file, params.args, {
        name: params.name,
        cols: params.cols,
        rows: params.rows,
        cwd: params.cwd,
        env: params.env,
      }));
    } catch (error) {
      return { ok: false, error: toPtyHostError(error) };
    }
    const { ptyId } = params;
    const raw: RawPtyEntry = { pty: rawPty, killed: false, exited: false, spawnedAtMs, rootPin: null, rootStartedAtMs: null };
    this.rawPtys.set(ptyId, raw);
    // Answered once node-pty has set the pid, as a session spawn is (`spawn`).
    const pidGate = rawPty.pid > 0 ? null : new RootPidGate(rawPty);
    subscribeThroughGate(
      rawPty,
      pidGate,
      (data) => this.deps.emit({ type: 'rawData', ptyId, data }),
      (exitCode, signal) => {
        raw.exited = true;
        this.unpinRoot(raw);
        this.rawPtys.delete(ptyId);
        this.deps.emit({ type: 'rawExit', ptyId, exitCode, signal: signal ?? null });
        if (!raw.killed) this.releaseExitedPty(rawPty);
      },
    );
    if (!pidGate) {
      this.pinRootOf(raw);
      return { ok: true, pid: rawPty.pid };
    }
    return pidGate.outcome.then((outcome): PtyHostRawSpawnResult => {
      if (outcome.kind === 'failed') {
        // Not spawned again: only a session spawn is retried. The failure
        // rejects to the probe's caller (`spawnOffMainPty`).
        pidGate.discard();
        this.rawPtys.delete(ptyId);
        return { ok: false, error: toPtyHostError(processNotStartedError(outcome.exitCode, this.now() - raw.spawnedAtMs, pidGate.longestStallMs)) };
      }
      if (outcome.kind === 'timedOut') {
        console.warn(`[pty-host] raw PTY ${ptyId} reported no pid and no exit within the wait; answering without its pid`);
      }
      this.pinRootOf(raw);
      pidGate.release();
      return { ok: true, pid: rawPty.pid };
    });
  }

  // --- Internals ------------------------------------------------------------

  /** Run `action` on a raw PTY. False when `ptyId` is not a raw PTY. */
  private withRawPty(ptyId: number, action: (rawPty: nodePty.IPty) => void): boolean {
    const raw = this.rawPtys.get(ptyId);
    if (!raw) return false;
    try {
      action(raw.pty);
    } catch {
      // Exited, its exit callback still to come.
    }
    return true;
  }

  /** Kill a raw PTY once. False when `ptyId` is not a raw PTY. */
  private killRaw(ptyId: number): boolean {
    const raw = this.rawPtys.get(ptyId);
    if (!raw) return false;
    if (raw.killed) return true;
    raw.killed = true;
    try {
      raw.pty.kill();
    } catch {
      // Already gone.
    }
    return true;
  }

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
    this.disposeWriteQueue(entry);
    // Recorded now, not at the exit, so a reap posted right after the kill
    // (a Command Terminal's, on its row's removal) already finds the root.
    const descendants = this.listDescendantsBeforeKill(entry);
    this.recordKilledRoot(entry, descendants);
    if (!descendants) {
      this.killNow(entry);
      return;
    }
    void descendants.then(() => this.killNow(entry));
  }

  private killNow(entry: PtyEntry): void {
    if (entry.exited) return;
    try {
      entry.pty.kill();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EACCES' && code !== 'ESRCH') console.warn('[pty-host] pty.kill() failed:', error);
    }
  }

  /**
   * Whether a reap could wait on what this PTY's shell leaves running: a task
   * PTY with a real root, not a WSL one, in a host that is not shutting down.
   */
  private isLedgerRoot(entry: PtyEntry): entry is PtyEntry & { taskId: string } {
    return entry.taskId !== null && entry.taskId !== '' && !this.shuttingDown && !entry.wslRoot && entry.pty.pid > 0;
  }

  /**
   * POSIX: the shell's agent, listed before the kill re-parents it
   * (`agentDescendantsOf`). The kill waits for the listing, bounded by
   * `KILL_SNAPSHOT_CAP_MS`; null where none is taken (Windows reads
   * parentage after the fact, a PTY with no task, a host already shutting
   * down). A quit's kills arrive before its `shutdown`, so they still list,
   * once for all of them: about 10 ms that no reap reads, accepted rather
   * than threading a quit flag through every kill.
   */
  private listDescendantsBeforeKill(entry: PtyEntry): Promise<RootDescendant[]> | null {
    const list = this.deps.listProcessesBeforeKill;
    if (!list || this.onWindows) return null;
    if (!this.isLedgerRoot(entry)) return null;
    const rootPid = entry.pty.pid;
    // Kills that arrive together (a quit, several To Do moves) share one `ps`.
    this.preKillListing ??= list().finally(() => { this.preKillListing = null; });
    const listed = this.preKillListing.then((rows) => agentDescendantsOf(rows, rootPid)).catch(() => [] as RootDescendant[]);
    const capped = new Promise<RootDescendant[]>((resolve) => {
      const timer = setTimeout(() => resolve([]), KILL_SNAPSHOT_CAP_MS);
      timer.unref?.();
    });
    return Promise.race([listed, capped]);
  }

  /** Remember a root main killed, for a reap's wait (`exited-root-wait.ts`). */
  private recordKilledRoot(entry: PtyEntry, descendants: Promise<RootDescendant[]> | null): void {
    if (!this.isLedgerRoot(entry)) return;
    // Windows reads the shell's children by parentage at wait time; POSIX
    // needs the pre-kill listing. Without either there is nothing to wait on.
    if (this.onWindows ? !this.deps.loadOrphanApi : !descendants) return;
    const now = this.now();
    this.exitedRoots = pruneExitedRoots(this.exitedRoots, now);
    this.exitedRoots.push({
      taskId: entry.taskId,
      rootPid: entry.pty.pid,
      spawnedAtMs: entry.spawnedAtMs,
      rootStartedAtMs: entry.rootStartedAtMs,
      exitedAtMs: now,
      orphanCleanup: null,
      descendants,
    });
  }

  private dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.clearDraft(sessionId);
    this.bufferManager.removeSession(sessionId);
    this.transcriptWriter.remove(sessionId);
    this.firstOutput.removeSession(sessionId);
    this.agentOutput.removeSession(sessionId);
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
    // Only an agent spawn types the clear prelude this waits for; a bare
    // shell would scan its output for a handoff that never comes.
    if (session?.agentName && this.agentOutput.consume(sessionId, data)) {
      this.deps.emit({ type: 'agentOutput', sessionId });
    }
  }

  private onPtyData(entry: PtyEntry, data: string): void {
    const sessionId = entry.sessionId;
    if (__KANGENTIC_DEV__) noteRoundTripStage(sessionId, 'data', data);
    this.bufferManager.onData(sessionId, data);

    // A session main removed while its PTY was still exiting (a young
    // session's kill waits out the exit grace) keeps feeding the ring above,
    // as before, but nothing else: there is no row to attribute it to. That
    // includes the output report, whose merge window would otherwise come
    // back after `dropSession` deleted it and never be removed.
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.noteOutput(sessionId);

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
    entry.rootExitedAtMs = this.unpinRoot(entry);
    for (const disposable of entry.disposables) {
      try {
        disposable.dispose();
      } catch {
        // Best effort.
      }
    }
    this.ptys.delete(entry.ptyId);
    this.disposeWriteQueue(entry);
    const session = this.sessions.get(entry.sessionId);
    if (session?.livePtyId === entry.ptyId) {
      session.livePtyId = null;
      // The prompt died with the PTY; a remembered draft would otherwise be
      // reported as discarded by the next session to reuse this id.
      this.clearDraft(entry.sessionId);
    }
    this.backpressure.release(entry.sessionId);
    this.flushCoalesced(entry.sessionId);
    // Flush the transcript before main hears of the exit, as the spawn flow's
    // exit handler did.
    this.transcriptWriter.finalize(entry.sessionId);
    this.deps.emit({ type: 'exit', ptyId: entry.ptyId, sessionId: entry.sessionId, exitCode });
    // The orphan cleanup writes through the exited PTY, so it releases it
    // when it is done; otherwise release it now. A PTY main killed is released.
    // The root is recorded in this same turn, so a reap main starts on hearing
    // of the exit always finds it.
    const orphanCleanup = this.endOrphansOf(entry);
    if (!orphanCleanup && !entry.killed) this.releaseExitedPty(entry.pty);
    if (orphanCleanup) this.recordOrphanedRoot(entry, orphanCleanup);
  }

  /**
   * Remember a task root whose shell exited on its own while the orphan
   * cleanup asks its agent to leave, for a reap's wait (`exited-root-wait.ts`).
   * A root main killed was recorded when the kill arrived.
   */
  private recordOrphanedRoot(entry: PtyEntry, orphanCleanup: Promise<void>): void {
    if (!entry.taskId) return;
    const exitedAtMs = this.now();
    this.exitedRoots = pruneExitedRoots(this.exitedRoots, exitedAtMs);
    this.exitedRoots.push({
      taskId: entry.taskId,
      rootPid: entry.pty.pid,
      spawnedAtMs: entry.spawnedAtMs,
      rootStartedAtMs: entry.rootStartedAtMs,
      exitedAtMs,
      orphanCleanup,
      descendants: null,
    });
  }

  /**
   * Free what node-pty still holds for a PTY that exited on its own (Windows).
   *
   * node-pty ends a ConPTY's conout worker thread only in kill(), never after
   * the process exits by itself, so the host kept one worker per such exit for
   * its whole life. Measured over 100 exits with
   * `scripts/probe-conpty-exit-race.js --mode churn`: the worker process grew
   * from 36 MB to 688 MB on node-pty 1.1.0 and to 690 MB on 1.2.0-beta.15, and
   * stayed at 62 MB with a kill after each exit.
   *
   * The kill frees that and nothing else. node-pty dropped its native handle
   * at the exit, so the native kill is a no-op and the pseudoconsole stays open
   * (microsoft/node-pty#965), and the console-list shortcut returns no pid once
   * `_exitCode` is set, so nothing is killed by pid (`conpty-console-list.ts`).
   * Never on POSIX, where a kill after the exit signals a pid that may name
   * another process by then.
   */
  private releaseExitedPty(pty: nodePty.IPty): void {
    if (!this.onWindows) return;
    try {
      pty.kill();
    } catch {
      // Nothing left to free.
    }
  }

  /**
   * The shell exited on its own, so whatever it was running (the agent) is
   * still attached to a console nobody will close (`dead-root-orphans.ts`).
   * The agent is asked to exit through that console first and terminated only
   * if it is still running after the grace. A kill we sent closed the console
   * itself, and a quit's exits are main's kills, so neither is looked at.
   * It runs only with the shell's exact creation and exit times, read off its
   * pin: a guessed window can take an earlier or later owner's process for
   * the shell's (`dead-root-orphans.ts`). Without them what the shell ran is
   * left running and logged.
   * The cleanup when one started (it settles, never rejects, and releases the
   * PTY when it ends); null otherwise.
   */
  private endOrphansOf(entry: PtyEntry): Promise<void> | null {
    if (!this.deps.loadOrphanApi || !this.onWindows) return null;
    // Read at the exit, not the spawn: on Windows node-pty sets the pid after
    // spawn() returns (`root-pid-gate.ts`), and keeps it after the exit.
    if (entry.killed || this.shuttingDown || entry.wslRoot || entry.pty.pid <= 0) return null;
    // Both times come off a pin, which only a loaded API takes.
    const api = this.orphanApi;
    if (!api || entry.rootStartedAtMs === null || entry.rootExitedAtMs === null) {
      console.warn(`[pty-host] session ${entry.sessionId.slice(0, 8)}'s shell exited on its own, but its lifetime could not be read; what it ran is left running`);
      return null;
    }
    return this.runOrphanCleanup(entry, api, entry.rootStartedAtMs, entry.rootExitedAtMs);
  }

  private async runOrphanCleanup(entry: PtyEntry, api: DeadRootOrphanApi, rootStartedAtMs: number, rootExitedAtMs: number): Promise<void> {
    const shortSessionId = entry.sessionId.slice(0, 8);
    try {
      const result = await endDeadRootOrphans(
        api,
        {
          rootPid: entry.pty.pid,
          rootStartedAtMs,
          rootExitedAtMs,
          protectedPids: new Set([process.pid, process.ppid, ...this.liveRootPids()]),
        },
        {
          askToExit: () => writeToExitedConsole(entry.pty, entry.exitSequence),
          sleep: (ms) => new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            timer.unref?.();
          }),
          now: this.now,
          isStopping: () => this.shuttingDown,
        },
      );
      if (result.found.length === 0) return;
      console.log(
        `[pty-host] session ${shortSessionId}'s shell exited on its own, leaving ${result.found.join(', ')} running;`
        + ` ${result.asked ? 'asked it to exit' : 'could not ask it to exit'}; exited by themselves: ${result.exitedByThemselves.length};`
        + ` terminated after the grace: ${result.terminated.length}${result.terminated.length > 0 ? ` (${result.terminated.join(', ')})` : ''}`,
      );
      if (result.notTerminated > 0) {
        console.warn(`[pty-host] session ${shortSessionId}: ${result.notTerminated} process(es) its exited shell left running could not be terminated`);
      }
    } catch (error) {
      console.warn(`[pty-host] could not end what session ${shortSessionId}'s exited shell left running:`, error instanceof Error ? error.message : String(error));
    } finally {
      this.releaseExitedPty(entry.pty);
    }
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
