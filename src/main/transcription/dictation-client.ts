import path from 'node:path';
import { EventEmitter } from 'node:events';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { UtilityRestartPolicy } from '../utility-process/restart-policy';
import { StderrTail, UTILITY_PROCESS_STDIO, captureWorkerStderr } from '../utility-process/stderr-tail';
import { unpacked } from '../utility-process/paths';
import { HEAVY_IDLE_SHUTDOWN_MS, WORKER_COMMIT_CEILING_BYTES, readProcessCommitBytes } from '../utility-process/commit-ceiling';
import type {
  CancelMessage,
  CreateSessionMessage,
  DisposeWarmMessage,
  EnsureEngineRequest,
  ErrorMessage,
  FinalizeMessage,
  PartialMessage,
  PrewarmMessage,
  PushMessage,
  ResultMessage,
  ShutdownMessage,
  WorkerRequest,
} from './dictation-worker';

/** Cold model load (a 600 MB NeMo model takes 1.5 s from a warm disk, and
 *  Cohere Transcribe's 2.7 GB far longer from a slow one). Generous like
 *  EmbedClient's INIT_TIMEOUT_MS. */
const ENSURE_ENGINE_TIMEOUT_MS = 120_000;
/** A decode pass on a long utterance; generous but bounded. */
const FINALIZE_TIMEOUT_MS = 30_000;
/** Recycle a worker that has served a session after this long without a
 *  request, or after HEAVY_IDLE_SHUTDOWN_MS once its commit has passed
 *  WORKER_COMMIT_CEILING_BYTES (utility-process/commit-ceiling.ts). Only such
 *  a worker holds the accurate model (HybridEngine loads it lazily on the
 *  first session), and onnxruntime never returns that arena to the OS
 *  in-process, so the recycle is a process exit: 3 GB of commit for an idle
 *  631 MB model was what fired the low-memory warning (#706). A worker that
 *  has only been pre-warmed holds the live model alone and is not
 *  recycled while under the ceiling - it IS the instant first press - unless
 *  a settings switch made it warm a second engine (warmedEngineKeys).
 *  TranscriptionService re-warms a recycled worker straight back to that
 *  baseline.
 *
 *  The worker's commit, measured on 2026-10-05. The other comments that reason
 *  about dictation memory (armIdleShutdown, HybridEngine, TranscriptionService's
 *  warmCap) point here rather than repeat the figures:
 *    - the live model alone: 160 MB for the Zipformer (Light), 780 MB for
 *      Nemotron or a chunked Parakeet v3 (Best, Balanced)
 *    - Best with its refinement model loaded: 1.5 GB (Parakeet v3 adds
 *      740 MB), at the commit ceiling
 *    - Best switched English to French and back with a warm cap of 1: 716,
 *      1,409, then 2,083 MB, since a disposed engine's arena stays reserved;
 *      a cap of 2 serves the switch back from the warm engine
 *    - that worker recycled: 716 MB, the one engine in use
 *
 *  The timer never runs while a session is open. A session's frames travel
 *  fire-and-forget and would not touch it, so `activeSessions` gates both the
 *  arm and the fire instead, however long the hold. */
const IDLE_SHUTDOWN_MS = 30 * 60_000;
/** After this many crashes inside the restart policy's decay window, stop
 *  trying to offload. See restart-policy.ts's header for why this is a
 *  window, not the whole app run. */
const MAX_CRASHES = 3;
const SERVICE_NAME = 'kangentic-dictation';

export type { EnsureEngineRequest };
/** A createSession request body, derived from the worker's own message shape
 *  (minus the envelope fields `request()` fills in) so the two sides can
 *  never drift apart on a field rename. */
export type CreateSessionRequest = Omit<CreateSessionMessage, 'type' | 'id'>;

/** Why an idle worker was recycled, as the recycle log line names it. */
type RecycleReason = 'ceiling' | 'served-session' | 'engine-switch';

interface PendingRequest {
  resolve: (value: { text?: string }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client for the `kangentic-dictation` utilityProcess worker (see
 * dictation-worker.ts for the wire protocol and DESKTOP-X for why the engine
 * runs there at all). Spawns lazily on first demand, recycles a worker that
 * has served a session or warmed a second engine once it has been idle for
 * IDLE_SHUTDOWN_MS (a short HEAVY_IDLE_SHUTDOWN_MS once its commit passes the
 * ceiling, read when a request settles and again at that short window, which
 * also recycles a prewarm-only worker that has grown), emitting
 * `'recycled'` so the service can warm a fresh, small one, and restarts it
 * (with a crash cap) after an unexpected exit.
 *
 * Unlike EmbedClient/LineCountClient, dictation has no fallback engine to
 * degrade to - a failed request REJECTS rather than resolving null/empty, so
 * a lost session surfaces to the renderer as an error instead of silently
 * committing nothing (see useDictation.ts's "never fail SILENTLY" contract).
 * `dispose()` is synchronous for the before-quit path.
 */
export class DictationClient extends EventEmitter {
  private child: UtilityProcess | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly restartPolicy: UtilityRestartPolicy;
  private disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  /** True once the current child has created a session, which is what makes
   *  it load the refinement model. Such a child is worth recycling; a
   *  prewarm-only child is the resident baseline unless it has passed the
   *  commit ceiling (armIdleShutdown). Per child: cleared on every kill and
   *  exit. */
  private servedSession = false;
  /** Engine keys the current child has been asked to warm. More than one
   *  means a settings switch loaded a second engine, and a disposed engine's
   *  arena stays reserved, so the child holds more than the one engine in use
   *  (figures in IDLE_SHUTDOWN_MS's note). Such a child gets the long idle
   *  window, as one that served a session does: the warm cap of 2 keeps a
   *  switch back instant while the user is switching, and a recycle half an
   *  hour later gives the second engine's commit back. Per child: cleared on
   *  every kill and exit. */
  private readonly warmedEngineKeys = new Set<string>();
  /** Sessions created and not yet finalized or cancelled. A recycle never
   *  fires while one is open. Every path that ends a session (finalize,
   *  cancel, a failed create, a kill, an exit) clears its entry, and
   *  TranscriptionService ends every session it starts, so an entry cannot
   *  go stale. */
  private readonly activeSessions = new Set<string>();
  /** Commit reader behind the ceiling check; injectable so tests drive it. */
  private readonly readCommitBytes: (pid: number) => number | null;

  constructor(
    restartPolicy?: UtilityRestartPolicy,
    options?: { readCommitBytes?: (pid: number) => number | null },
  ) {
    super();
    this.restartPolicy = restartPolicy
      ?? new UtilityRestartPolicy({ service: SERVICE_NAME, maxCrashes: MAX_CRASHES });
    this.readCommitBytes = options?.readCommitBytes ?? readProcessCommitBytes;
  }

  get crashed(): boolean {
    return this.restartPolicy.exhausted;
  }

  /** Why the worker is off, for the Dictation settings tab: the newest
   *  crash's exit code and first error line. Null while nothing has crashed
   *  in the window. */
  get crashReason(): string | null {
    return this.restartPolicy.lastCrashDescription;
  }

  /** Ensure the engine for `request` is warm in the worker (build + load if
   *  needed), without creating a session. Used by `prewarm`. Rejects if the
   *  worker is unavailable or the load failed. */
  async ensureWarm(request: EnsureEngineRequest): Promise<void> {
    const child = this.ensureSpawned();
    if (!child) throw new Error(this.unavailableMessage());
    this.clearIdleTimer();
    // Counted before the reply, so a warm that fails or times out still
    // counts. A timed-out load can keep going in the worker after this
    // client stops waiting, and a failed one can leave its arena reserved.
    // Counting it costs at most one early recycle; not counting it could
    // leave a second engine's commit held for good.
    this.warmedEngineKeys.add(request.engineKey);
    try {
      await this.request<PrewarmMessage>(child, { type: 'prewarm', ...request }, ENSURE_ENGINE_TIMEOUT_MS);
    } finally {
      this.armIdleShutdown();
    }
  }

  /** Create a session in the worker; its partials arrive as this client's
   *  `'partial'` events (dictationSessionId, text). Rejects if the worker is
   *  unavailable or the load failed. */
  async createSession(request: CreateSessionRequest): Promise<void> {
    const child = this.ensureSpawned();
    if (!child) throw new Error(this.unavailableMessage());
    this.clearIdleTimer();
    this.servedSession = true;
    this.activeSessions.add(request.dictationSessionId);
    try {
      await this.request<CreateSessionMessage>(child, { type: 'createSession', ...request }, ENSURE_ENGINE_TIMEOUT_MS);
    } catch (error) {
      // The service cancels a session whose create failed; drop it here too,
      // so a failed create can never hold the recycle open.
      this.activeSessions.delete(request.dictationSessionId);
      throw error;
    } finally {
      this.armIdleShutdown();
    }
  }

  /** Fire-and-forget PCM push, mirroring the original synchronous ingest -
   *  no round trip, no backpressure. A no-op if the worker is unavailable
   *  (the eventual finalize() will fail and report the loss).
   *
   *  Electron's `UtilityProcess.postMessage` transfer list accepts only
   *  `MessagePortMain[]`, not `ArrayBuffer[]` - unlike a browser
   *  `MessagePort`, it has no zero-copy ArrayBuffer transfer, so this is a
   *  structured-clone COPY across the process boundary, not a transfer. At
   *  32 KB/sec (50 frames/sec x 640 bytes) that copy is negligible; slicing
   *  a fresh buffer here (rather than posting `pcm` itself) still guards
   *  against a caller that reuses/pools its Int16Array afterward. */
  push(dictationSessionId: string, pcm: Int16Array): void {
    if (!this.child) return;
    // Int16Array#buffer is typed ArrayBufferLike (to admit a SharedArrayBuffer-
    // backed view); PCM here is always a plain ArrayBuffer (constructed from
    // one in transcription-service.ts's ingest -> push call), never shared.
    const buffer = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    const message: PushMessage = { type: 'push', dictationSessionId, pcm: buffer };
    try {
      this.child.postMessage(message);
    } catch {
      // A dead child between the null-check and the call is a lost race,
      // not a caller error; the eventual finalize() will surface the loss.
    }
  }

  /** Flush and finalize a session, returning the committed text. Rejects on
   *  worker unavailability or timeout - dictation has no silent fallback. */
  async finalize(dictationSessionId: string): Promise<string> {
    if (!this.child) throw new Error(this.unavailableMessage());
    const child = this.child;
    this.clearIdleTimer();
    try {
      const result = await this.request<FinalizeMessage>(child, { type: 'finalize', dictationSessionId }, FINALIZE_TIMEOUT_MS);
      return result.text ?? '';
    } finally {
      this.activeSessions.delete(dictationSessionId);
      this.armIdleShutdown();
    }
  }

  /** Fire-and-forget cancel; a no-op if the worker is unavailable. Ends the
   *  session for the recycle's purposes either way. */
  cancel(dictationSessionId: string): void {
    this.activeSessions.delete(dictationSessionId);
    if (!this.child) return;
    const message: CancelMessage = { type: 'cancel', dictationSessionId };
    try {
      this.child.postMessage(message);
    } catch {
      // Same lost-race reasoning as push() above.
    }
    this.armIdleShutdown();
  }

  /** Release every warm engine in the worker in place, keeping the process.
   *  The client half of the worker's `disposeWarm` protocol (whose mid-load
   *  supersede guard dictation-worker.test.ts covers). Not what disabling
   *  dictation does any more - that is `release()`, since an in-process
   *  dispose leaves onnxruntime's reservation behind. A no-op if the worker
   *  was never spawned - nothing is warm either way. */
  disposeWarm(): void {
    if (!this.child) return;
    const message: DisposeWarmMessage = { type: 'disposeWarm' };
    try {
      this.child.postMessage(message);
    } catch {
      // Same lost-race reasoning as push() above.
    }
  }

  private ensureSpawned(): UtilityProcess | null {
    if (this.child) return this.child;
    if (this.disposed) return null;
    // Covers both "given up" and "still inside the post-crash backoff window".
    if (!this.restartPolicy.maySpawn()) return null;

    const workerPath = unpacked(path.join(__dirname, 'dictation-worker.js'));
    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(workerPath, [], { serviceName: SERVICE_NAME, stdio: UTILITY_PROCESS_STDIO });
    } catch (error) {
      // A fork that throws is a crash like any other, so it goes through the
      // policy rather than latching the cap directly - otherwise one transient
      // fork failure disabled dictation permanently, with no decay.
      console.warn('[transcription] dictation worker fork failed:', error);
      this.restartPolicy.recordCrash(null, undefined, { cause: 'fork_failed' });
      return null;
    }
    this.child = child;
    // stderr is piped and drained from the first tick: an undrained pipe
    // blocks the worker, and the tail is what names a crash in the project
    // log and the Sentry report (see stderr-tail.ts).
    const stderrTail = new StderrTail();
    captureWorkerStderr(child, stderrTail, !app.isPackaged);
    child.on('message', (message: unknown) => this.onWorkerMessage(message));
    child.on('exit', (code: number) => this.onWorkerExit(child, code, stderrTail));
    return child;
  }

  /** Send a correlated request and await its reply. `T` is the concrete
   *  message type being sent (one of the WorkerRequest variants that carries
   *  an `id`); `payload` is everything that message needs except the `id`
   *  this method assigns. Typed against the worker's own exported message
   *  shapes so a field renamed on one side fails to compile on the other,
   *  instead of silently sending a payload the worker never recognizes. */
  private request<T extends WorkerRequest & { id: number }>(
    child: UtilityProcess,
    payload: Omit<T, 'id'>,
    timeoutMs: number,
  ): Promise<{ text?: string }> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('The dictation worker did not respond in time'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      child.postMessage({ ...payload, id: requestId } as T);
    });
  }

  private onWorkerMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    // Fields from every WorkerReply variant, each optional: a rename or drop
    // of any of these in dictation-worker.ts fails this cast to compile,
    // rather than the field silently reading as undefined at runtime.
    const record = message as Partial<ResultMessage> & Partial<ErrorMessage> & Partial<PartialMessage>;
    if (record.type === 'partial' && typeof record.dictationSessionId === 'string') {
      this.emit('partial', record.dictationSessionId, record.text ?? '');
      return;
    }
    if ((record.type === 'result' || record.type === 'error') && typeof record.id === 'number') {
      const entry = this.pending.get(record.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(record.id);
      if (record.type === 'result') {
        entry.resolve({ text: record.text });
      } else {
        entry.reject(new Error(record.message ?? 'Failed to prepare the dictation engine'));
      }
    }
  }

  private onWorkerExit(child: UtilityProcess, exitCode?: number, stderrTail?: StderrTail): void {
    // Only the current child's exit is a crash. killChild() nulls this.child
    // before it kills, so every intentional exit (a release, an idle recycle,
    // dispose) arrives from a child that is no longer current, and so does a
    // killed predecessor's exit landing after its replacement spawned. Both are
    // dropped here, in any order, so neither nulls the live child nor rejects
    // its requests. Do not add a kill mark beside this guard. A release with no
    // worker left (a renderer reload sends two) overwrites it, and the
    // released worker's exit(0) then reads as a crash.
    if (child !== this.child) return;
    this.child = null;
    // A crash must not leave the idle timer running against a child that is
    // already gone: it would fire on the replacement (which, freshly
    // pre-warmed, has served no session) or on nothing, as a phantom recycle.
    this.clearIdleTimer();
    this.servedSession = false;
    this.warmedEngineKeys.clear();
    this.activeSessions.clear();
    const lostSessionError = new Error('The dictation worker exited unexpectedly');
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(lostSessionError);
    }
    this.pending.clear();
    if (!this.disposed) this.restartPolicy.recordCrash(exitCode, stderrTail);
  }

  /** Kill the worker now, on purpose (dictation was turned off). Unlike the
   *  idle recycle this emits no `'recycled'`, so nothing re-warms it. A
   *  later request spawns afresh; `dispose()` is the one that refuses. */
  release(): void {
    this.clearIdleTimer();
    const turnedOffError = new Error('Dictation was turned off');
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(turnedOffError);
    }
    this.pending.clear();
    this.killChild();
  }

  /** Arm the idle recycle. A child past the commit ceiling is recycled at
   *  HEAVY_IDLE_SHUTDOWN_MS. Under it, the ceiling is read once more at that
   *  point: a child can keep growing after its last request settled (a
   *  finalize that stopped waiting while the accurate model kept loading), and
   *  the settle-time reading would otherwise be the only one it gets. Past
   *  that check, only a child worth recycling waits out the rest of
   *  IDLE_SHUTDOWN_MS: one that served a session and so holds the refinement
   *  model, or one a settings switch made warm a second engine. A prewarm-only
   *  child holding its one engine under the ceiling is left resident on
   *  purpose. Recycled, a child re-warms only the engine in use (figures in
   *  IDLE_SHUTDOWN_MS's note). The two-stage read is the policy
   *  commit-ceiling.ts describes; EmbedClient.armIdleShutdown runs the same
   *  stages, so a change to one belongs in both. */
  private armIdleShutdown(): void {
    if (this.disposed || this.idleTimer || !this.isIdle()) return;
    if (this.overCommitCeiling()) {
      this.scheduleRecycle(HEAVY_IDLE_SHUTDOWN_MS, 'ceiling');
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.isIdle()) return;
      if (this.overCommitCeiling()) {
        this.recycle('ceiling');
        return;
      }
      const reason = this.longWindowReason();
      if (reason) this.scheduleRecycle(IDLE_SHUTDOWN_MS - HEAVY_IDLE_SHUTDOWN_MS, reason);
    }, HEAVY_IDLE_SHUTDOWN_MS);
    this.idleTimer.unref();
  }

  /** Why a child under the ceiling is worth recycling after a long quiet, or
   *  null for the resident baseline. */
  private longWindowReason(): Exclude<RecycleReason, 'ceiling'> | null {
    if (this.servedSession) return 'served-session';
    if (this.warmedEngineKeys.size > 1) return 'engine-switch';
    return null;
  }

  private scheduleRecycle(delayMs: number, reason: RecycleReason): void {
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.isIdle()) this.recycle(reason);
    }, delayMs);
    this.idleTimer.unref();
  }

  /** Recycle the idle child and ask for a fresh baseline. Logged with the
   *  reason and the commit given back, since otherwise a recycle shows only as
   *  a new pid. */
  private recycle(reason: RecycleReason): void {
    const pid = this.child?.pid;
    const commitBytes = typeof pid === 'number' ? this.readCommitBytes(pid) : null;
    const commitText = commitBytes === null ? 'unknown' : `${Math.round(commitBytes / (1024 * 1024))} MB`;
    console.info(`[transcription] recycling the dictation worker (${reason}, commit ${commitText})`);
    this.killChild();
    this.emit('recycled');
  }

  private isIdle(): boolean {
    return this.child !== null && this.pending.size === 0 && this.activeSessions.size === 0;
  }

  /** Whether the current child's commit has passed the ceiling, which earns
   *  it the short idle window. False with no child or no reading. */
  private overCommitCeiling(): boolean {
    const pid = this.child?.pid;
    if (typeof pid !== 'number') return false;
    const commitBytes = this.readCommitBytes(pid);
    return commitBytes !== null && commitBytes > WORKER_COMMIT_CEILING_BYTES;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    this.servedSession = false;
    this.warmedEngineKeys.clear();
    this.activeSessions.clear();
    if (child) {
      try {
        const message: ShutdownMessage = { type: 'shutdown' };
        child.postMessage(message);
      } catch {
        // ignore; kill below is the real teardown
      }
      child.kill();
    }
  }

  private unavailableMessage(): string {
    return this.crashReason
      ? `Dictation is unavailable (${this.crashReason})`
      : 'Dictation is unavailable right now';
  }

  /** Synchronous shutdown for the before-quit path. */
  dispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
    const lostSessionError = new Error('The dictation worker was shut down');
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(lostSessionError);
    }
    this.pending.clear();
    this.killChild();
  }
}

export const dictationClient = new DictationClient();
