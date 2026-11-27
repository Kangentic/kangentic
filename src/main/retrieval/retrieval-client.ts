/**
 * Main's client for the retrieval worker (`worker/retrieval-worker.ts`, the
 * `kangentic-retrieval` utility process), which owns every read and write of
 * the retrieval index.
 *
 * The shape follows the other workers (`line-count-client.ts`,
 * `dictation-client.ts`): a lazy fork through `UTILITY_PROCESS_STDIO` with
 * stderr captured, a restart policy that is the only route to crash telemetry,
 * a request-id map, a stale-exit guard with per-child kill tracking, and a
 * synchronous `dispose()` for the before-quit path. What differs:
 *
 * - An init handshake. The worker is forked with no arguments, so main sends
 *   what it cannot work out: the projects directory (a `--data-dir` override
 *   is argv-only) and the unpacked sqlite-vec binary (resolving it needs
 *   `app`). Requests queue behind the `ready` reply.
 * - No idle recycle. The worker holds the index connections and runs the
 *   background passes, so it lives until dispose or a crash.
 * - A call that times out kills the worker. A stuck worker may be holding the
 *   database's write lock, and main's own writes would otherwise wait on it
 *   until SQLite's busy timeout. The kill counts as a crash, so a worker that
 *   keeps sticking latches off rather than looping. The one exception is a
 *   worker its watchdog says is held in a WAL checkpoint, which holds no write
 *   lock: that call fails and the worker is left to finish, for up to
 *   `CHECKPOINT_HOLD_MAX_MS` (`heldInCheckpoint`).
 * - Worker events (`graph-changed`, `graph-progress`) and, after a crash, a
 *   `respawned` event, so the retrieval service can replay what a new worker
 *   has not seen.
 */

import path from 'node:path';
import { EventEmitter } from 'node:events';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { PATHS } from '../config/paths';
import { recordRelayedSyncSpan } from '../diagnostics/event-loop-lag';
import { recordRetrievalWriteHold } from '../diagnostics/sqlite-busy-holders';
import { unpacked } from '../utility-process/paths';
import { UtilityRestartPolicy } from '../utility-process/restart-policy';
import { StderrTail, UTILITY_PROCESS_STDIO, captureWorkerStderr, watchdogLine } from '../utility-process/stderr-tail';
import { resolveVecLoadablePath } from './vec-extension';
import { isVecLoadCause } from './vec-load-cause';
import { isCheckpointHoldLine } from './worker/checkpoint-labels';
import {
  createChokepointReporter,
  errorCodeOf,
  errorNameOf,
  sendHandledFailure,
  type ChokepointReporter,
} from '../analytics/handled-report';
import { isRuntimeDefect } from '../../shared/handled-error-copy';
import type {
  FromWorkerMessage,
  InitMessage,
  MethodParams,
  MethodResult,
  RequestMessage,
  RetrievalEventName,
  RetrievalMethod,
} from './worker/protocol';
import type { KnowledgeGraphBuildProgress } from '../../shared/types';

const SERVICE_NAME = 'kangentic-retrieval';
/** The worker's checkpoint thread, built beside the worker (`scripts/build.js`). */
const CHECKPOINT_THREAD_BUNDLE = 'retrieval-checkpoint-thread.js';
const MAX_CRASHES = 3;
/** An interactive call's budget. The worker answers between the steps of its
 *  background jobs, and no step runs longer than a conversation KNN (under
 *  400 ms measured), so anything near this is a stuck worker. */
export const INTERACTIVE_TIMEOUT_MS = 15_000;
/** How long closing one project's database may take before the worker is
 *  shut down instead. The close runs between a job's steps. */
const CLOSE_PROJECT_TIMEOUT_MS = 3_000;
/** How long a forked worker may take to say ready. A call's own budget starts
 *  only after ready, so a worker stuck starting (a native module load that
 *  never returns) would otherwise hold every call with no end. */
export const READY_TIMEOUT_MS = 30_000;
/** How long a worker held in a WAL checkpoint is left running, counted from
 *  the first call that hold failed, before it is killed anyway, so a dead disk
 *  still ends. Time, not a count of calls: calls that were pending together
 *  all time out within one budget. */
export const CHECKPOINT_HOLD_MAX_MS = 60_000;

/** The worker is not available: latched off after crashes, disposed, or it
 *  died or stuck mid-call. Callers answer with their degraded result. */
export class RetrievalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalUnavailableError';
  }
}

interface PendingCall {
  /** Named in the crash record when another call times out while this one waits. */
  method: RetrievalMethod;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RetrievalClientEvents {
  /** `progress` comes with `graph-progress` only. */
  event: [event: RetrievalEventName, projectId: string, progress?: KnowledgeGraphBuildProgress];
  /** A worker is up and answering (the first, or a replacement). */
  ready: [];
  /** A worker became ready after an earlier one exited. */
  respawned: [];
  /** The worker that was up is gone (exited, stuck, or disposed). */
  down: [];
}

export class RetrievalClient extends EventEmitter<RetrievalClientEvents> {
  private child: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;
  /** Rejects `ready`, for a child dropped before it said so. */
  private failReady: ((error: Error) => void) | null = null;
  private childStderr: StderrTail | null = null;
  private readonly pending = new Map<number, PendingCall>();
  private nextRequestId = 1;
  private disposed = false;
  /** A worker was forked (or a fork tried) before, so the next one to say
   *  ready replaces it. Set at the fork, not at ready: a first worker that dies
   *  before ready failed the calls queued on it (the open project's sweep among
   *  them), and its replacement must still announce `respawned` to replay them. */
  private forkedBefore = false;
  /** A worker said ready and has not gone since, so `down` fires once per up. */
  private workerUp = false;
  /** Children whose exit has landed, so a close never waits for one again. */
  private readonly exitedChildren = new WeakSet<UtilityProcess>();
  private readonly restartPolicy: UtilityRestartPolicy;
  /** How many watchdog lines the worker's stderr held at its last message. A
   *  held loop sends nothing, so a line past this count is the current hold. */
  private watchdogLinesAtLastMessage = 0;
  /** When the current checkpoint hold first failed a call without a kill, or null. */
  private checkpointHoldSince: number | null = null;

  constructor(restartPolicy?: UtilityRestartPolicy) {
    super();
    this.restartPolicy = restartPolicy
      ?? new UtilityRestartPolicy({ service: SERVICE_NAME, maxCrashes: MAX_CRASHES });
  }

  /** Why the worker is off, for status: the newest crash, or null. */
  get unavailableReason(): string | null {
    if (this.disposed) return 'The retrieval worker was shut down';
    if (!this.restartPolicy.maySpawn()) {
      return this.restartPolicy.lastCrashDescription
        ? `The retrieval worker stopped (${this.restartPolicy.lastCrashDescription})`
        : 'The retrieval worker is restarting';
    }
    return null;
  }

  /**
   * Ask the worker. `timeoutMs` null is a background job with no budget; an
   * interactive call keeps the default. Rejects with
   * `RetrievalUnavailableError` when the worker cannot answer, and with the
   * worker's own error when the handler threw.
   */
  async call<Method extends RetrievalMethod>(
    method: Method,
    params: MethodParams<Method>,
    options: { timeoutMs?: number | null } = {},
  ): Promise<MethodResult<Method>> {
    const child = this.ensureSpawned();
    if (!child || !this.ready) throw new RetrievalUnavailableError(this.unavailableReason ?? 'The retrieval worker is unavailable');
    await this.ready;
    if (child !== this.child) throw new RetrievalUnavailableError('The retrieval worker exited');
    const timeoutMs = options.timeoutMs === undefined ? INTERACTIVE_TIMEOUT_MS : options.timeoutMs;
    const requestId = this.nextRequestId++;
    return new Promise<MethodResult<Method>>((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => this.onTimeout(child, requestId, method), timeoutMs);
      timer?.unref();
      this.pending.set(requestId, { method, resolve: resolve as (result: unknown) => void, reject, timer });
      const message: RequestMessage<Method> = { type: 'request', id: requestId, method, params };
      try {
        child.postMessage(message);
      } catch {
        this.settle(requestId, new RetrievalUnavailableError('The retrieval worker exited'));
      }
    });
  }

  private ensureSpawned(): UtilityProcess | null {
    if (this.child) return this.child;
    if (this.disposed || !this.restartPolicy.maySpawn()) return null;

    const workerPath = unpacked(path.join(__dirname, 'retrieval-worker.js'));
    const replacesWorker = this.forkedBefore;
    this.forkedBefore = true;
    // The worker inherits main's environment as it is now, and its commit and
    // code sweeps run `git` from PATH. That includes Crashpad's pipe name on
    // Windows, on purpose: the worker reports its own crashes through it
    // (shared/child-env.ts). Startup extends PATH from the login
    // shell (`restoreShellEnv`, macOS and Linux) before it creates the window,
    // and every call that forks comes after that.
    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(workerPath, [], { serviceName: SERVICE_NAME, stdio: UTILITY_PROCESS_STDIO });
    } catch (error) {
      console.warn('[retrieval] retrieval worker fork failed:', error);
      this.restartPolicy.recordCrash(null, undefined, { cause: 'fork_failed' });
      return null;
    }
    this.child = child;
    const stderrTail = new StderrTail();
    this.childStderr = stderrTail;
    this.watchdogLinesAtLastMessage = 0;
    this.checkpointHoldSince = null;
    captureWorkerStderr(child, stderrTail, !app.isPackaged);
    let markReady: () => void = () => undefined;
    let failReady: (error: Error) => void = () => undefined;
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    this.failReady = failReady;
    // A caller awaiting readiness gets the rejection; nobody else must see it
    // as unhandled.
    this.ready.catch(() => undefined);
    const readyTimer = setTimeout(() => {
      if (child !== this.child) return;
      console.warn('[retrieval] the retrieval worker did not start in time; restarting it');
      this.restartPolicy.recordCrash(null, stderrTail, { cause: 'ready_timeout' });
      this.drop(new RetrievalUnavailableError('The retrieval worker did not start in time'));
    }, READY_TIMEOUT_MS);
    readyTimer.unref();
    const clearReadyTimer = (): void => clearTimeout(readyTimer);
    // report-ok: the timer goes however readiness ended. A rejection is a
    // RetrievalUnavailableError that a waiting call gets. A crash or a late start behind it
    // goes to restartPolicy.recordCrash, and a drop on purpose is no failure.
    this.ready.then(clearReadyTimer, clearReadyTimer);
    child.on('message', (message: unknown) => this.onWorkerMessage(child, message, markReady, replacesWorker));
    child.on('exit', (code: number) => {
      this.exitedChildren.add(child);
      failReady(new RetrievalUnavailableError('The retrieval worker exited before it was ready'));
      this.onWorkerExit(child, code, stderrTail);
    });
    const init: InitMessage = {
      type: 'init',
      projectsDir: PATHS.projectsDir,
      vecLoadablePath: vecLoadablePathOrNull(),
      checkpointThreadPath: unpacked(path.join(__dirname, CHECKPOINT_THREAD_BUNDLE)),
    };
    child.postMessage(init);
    return child;
  }

  private onWorkerMessage(child: UtilityProcess, message: unknown, markReady: () => void, replacesWorker: boolean): void {
    if (child !== this.child || typeof message !== 'object' || message === null) return;
    // The loop ran: whatever hold the watchdog wrote about before this is over.
    this.watchdogLinesAtLastMessage = this.childStderr?.watchdogLineCount() ?? 0;
    this.checkpointHoldSince = null;
    const record = message as FromWorkerMessage;
    if (record.type === 'ready') {
      markReady();
      this.workerUp = true;
      this.emit('ready');
      if (replacesWorker) this.emit('respawned');
      return;
    }
    if (record.type === 'reply') {
      const failure = record.ok ? null : workerFailure(record);
      // Reported here, the one place every failed call passes, because its
      // callers degrade and carry on (`reportFailedCall`).
      const method = this.pending.get(record.id)?.method;
      if (failure && method) reportFailedCall(method, failure);
      this.settle(record.id, failure, record.ok ? record.result : undefined);
      return;
    }
    if (record.type === 'handledError') {
      reportRetrievalWorkerFailure(record);
      return;
    }
    if (record.type === 'event') {
      this.emit('event', record.event, record.projectId, record.progress);
      return;
    }
    if (record.type === 'slow-span') {
      recordRelayedSyncSpan(`worker:${record.label}`, record.ms);
      return;
    }
    if (record.type === 'write-hold') {
      recordRetrievalWriteHold(record.heldMs);
      return;
    }
    if (record.type === 'log') logFromWorker(record.level, record.text);
  }

  private settle(requestId: number, error: Error | null, result?: unknown): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(result);
  }

  private onTimeout(child: UtilityProcess, requestId: number, method: RetrievalMethod): void {
    if (!this.pending.has(requestId) || child !== this.child) return;
    if (this.heldInCheckpoint()) {
      // A PASSIVE checkpoint holds no write lock, and a held write lock is why a
      // stuck worker is killed. A kill would also throw the copy away, so the
      // next worker meets the same WAL and holds again (Sentry DESKTOP-4P: five
      // latches in 80 minutes). Fail this call so its caller degrades, and let
      // the checkpoint finish, up to the ceiling.
      console.warn(`[retrieval] ${method} did not answer in time; the retrieval worker is checkpointing, left running`);
      this.settle(requestId, new RetrievalUnavailableError('The retrieval worker is checkpointing'));
      return;
    }
    console.warn(`[retrieval] ${method} did not answer in time; restarting the retrieval worker`);
    // What else was waiting, read before `drop` settles it all. Background jobs
    // count too: one holding the worker between steps is what a timeout most
    // likely means, and its name is the only trace a packaged build keeps.
    const pendingMethods: RetrievalMethod[] = [];
    for (const [pendingId, entry] of this.pending) {
      if (pendingId !== requestId) pendingMethods.push(entry.method);
    }
    // A stuck worker counts toward the crash cap, recorded now: its exit, when
    // it lands, may come after the next worker is already running.
    this.restartPolicy.recordCrash(null, this.childStderr ?? undefined, { cause: 'request_timeout', method, pendingMethods });
    this.drop(new RetrievalUnavailableError(`The retrieval worker did not answer ${method} in time`));
  }

  /**
   * Whether the worker's loop is held in a WAL checkpoint right now, and has
   * not been failing calls for longer than `CHECKPOINT_HOLD_MAX_MS`: the
   * watchdog wrote a line since the worker's last message, and the newest line
   * names a checkpoint label. Checkpoints normally run on the worker's
   * checkpoint thread and hold no loop; this covers its in-loop fallback.
   */
  private heldInCheckpoint(): boolean {
    const stderr = this.childStderr;
    if (!stderr) return false;
    if (stderr.watchdogLineCount() <= this.watchdogLinesAtLastMessage) return false;
    const line = watchdogLine(stderr.snapshot());
    if (line === null || !isCheckpointHoldLine(line)) return false;
    const now = Date.now();
    this.checkpointHoldSince ??= now;
    return now - this.checkpointHoldSince < CHECKPOINT_HOLD_MAX_MS;
  }

  private onWorkerExit(child: UtilityProcess, exitCode: number, stderrTail: StderrTail): void {
    // A worker already dropped (disposed, or killed for sticking) was dealt
    // with then. `drop` nulls `this.child` before it kills, so that exit is
    // never the current child's, whether it lands before or after a
    // replacement was forked.
    if (child !== this.child) return;
    this.child = null;
    this.ready = null;
    this.failReady = null;
    const exited = new RetrievalUnavailableError('The retrieval worker exited');
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, exited);
    this.markDown();
    if (!this.disposed) this.restartPolicy.recordCrash(exitCode, stderrTail, { cause: 'exit' });
  }

  private markDown(): void {
    if (!this.workerUp) return;
    this.workerUp = false;
    this.emit('down');
  }

  /** Let go of the current worker now: every call waiting on it fails with
   *  `error`, and its exit, whenever it lands, is not read as a crash. */
  private drop(error: RetrievalUnavailableError): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.failReady?.(error);
    this.failReady = null;
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, error);
    this.markDown();
    if (!child) return;
    try {
      child.postMessage({ type: 'shutdown' });
    } catch {
      // The kill below is the real teardown.
    }
    child.kill();
  }

  /** A worker process exists now (up, or starting). */
  get running(): boolean {
    return this.child !== null;
  }

  /** Tell a running worker something that matters only to a running worker
   *  (a job to stop). Forks none, and never rejects. */
  notifyRunning<Method extends RetrievalMethod>(method: Method, params: MethodParams<Method>): void {
    if (!this.child) return;
    void this.call(method, params).catch(() => undefined);
  }

  /**
   * Let go of a project's database in the worker, so its files can be deleted:
   * Windows refuses to unlink a file another process holds open. Never forks a
   * worker to do it. A worker that does not close it in time is shut down, and
   * this waits for its exit, which closes every handle it had.
   */
  async closeProject(projectId: string): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await this.call('project.close', { projectId }, { timeoutMs: CLOSE_PROJECT_TIMEOUT_MS });
      return;
    } catch (error) {
      console.warn(`[retrieval] the worker did not close project ${projectId}; shutting it down:`, error instanceof Error ? error.message : error);
    }
    // A worker that exited during the close holds no handle, and its exit
    // event has already fired: waiting for it would cost the whole timeout.
    if (this.exitedChildren.has(child)) return;
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_PROJECT_TIMEOUT_MS);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child === this.child) this.drop(new RetrievalUnavailableError('The retrieval worker was restarted to release a project'));
    await exited;
  }

  /** Synchronous shutdown for the before-quit path. */
  dispose(): void {
    this.disposed = true;
    this.drop(new RetrievalUnavailableError('The retrieval worker was shut down'));
  }
}

/** The error a failed reply rejects with, its class and errno restored so a caller can classify it. */
function workerFailure(reply: Extract<FromWorkerMessage, { type: 'reply'; ok: false }>): Error {
  const error = new Error(reply.error) as NodeJS.ErrnoException;
  if (reply.errorName) error.name = reply.errorName;
  if (reply.errorCode) error.code = reply.errorCode;
  return error;
}

/**
 * A call the worker answered with a failure. Every caller of `call()` catches
 * the rejection and degrades (a viewer shows Retry, a report goes out without a
 * section, a token count keeps its snapshot), so before this a defect in a
 * worker handler reached nobody: the worker cannot report, and only the
 * `sqlite_vec_load` relay below did.
 *
 * Reported for the two classes that are never an expected answer: a runtime
 * defect (`TypeError`, `RangeError`, `ReferenceError`) and a SQLite failure,
 * which is the environment and groups by its code. A plain `Error` a handler
 * throws on purpose (a project that closed mid-call, a file that is gone) is not
 * reported here, since the worker's handlers do not yet say which of theirs are
 * refusals. A worker that is down rejects with `RetrievalUnavailableError`, an
 * expected class, and never comes through this path at all.
 *
 * The error is rebuilt in main from the reply (`workerFailure`), so every
 * failure carries the same frames and Sentry's stack grouping would fold them
 * into one issue. It groups by method, name and code instead, the same exception
 * the relayed worker failure below takes. `method` is a fixed `RetrievalMethod`.
 * The reply's message never leaves: the copy is path-free like every other.
 */
const retrievalCallReporter: ChokepointReporter = createChokepointReporter('retrieval_call', {
  shouldReport: (error) => isRuntimeDefect(error) || (errorCodeOf(error)?.startsWith('SQLITE_') ?? false),
});

function reportFailedCall(method: RetrievalMethod, error: Error): void {
  retrievalCallReporter.report(error, {
    tags: { method },
    fingerprint: ['retrieval-call', method, errorNameOf(error), errorCodeOf(error) ?? 'none'],
  });
}

const reportedWorkerFailures = new Set<string>();

/** A failure the worker relayed by a fixed code (`HandledErrorMessage`), reported once per code per run. */
function reportRetrievalWorkerFailure(message: Extract<FromWorkerMessage, { type: 'handledError' }>): void {
  if (reportedWorkerFailures.has(message.code)) return;
  reportedWorkerFailures.add(message.code);
  const error = new Error(`The retrieval worker reported ${message.code}`) as NodeJS.ErrnoException;
  error.name = message.errorName ?? 'Error';
  if (message.errorCode) error.code = message.errorCode;
  // Fixed words only: the cause is an enum the worker read from the loader's
  // message, and the message itself never crossed the process line. Both are
  // checked here, since a type does not survive the wire.
  const tags: Record<string, string> = { code: message.code };
  if (message.loadCause !== undefined) tags.load_cause = isVecLoadCause(message.loadCause) ? message.loadCause : 'other';
  if (typeof message.fileExists === 'boolean') tags.vec_file_exists = message.fileExists ? 'yes' : 'no';
  // The fingerprint leaves the cause out, so DESKTOP-4Q keeps grouping its events.
  sendHandledFailure('retrieval_worker', error, tags, {}, ['retrieval-worker', message.code, message.errorCode ?? message.errorName ?? 'none']);
}

/** A worker log line into main's log. An error also went to the worker's
 *  stderr, which a dev build already passes through, so it is printed here only
 *  in a packaged build, where nothing else would show it. */
function logFromWorker(level: 'log' | 'info' | 'warn' | 'error', text: string): void {
  if (level === 'error' && !app.isPackaged) return;
  console[level](`[retrieval-worker] ${text}`);
}

function vecLoadablePathOrNull(): string | null {
  try {
    return resolveVecLoadablePath();
  } catch {
    return null;
  }
}

export const retrievalClient = new RetrievalClient();
