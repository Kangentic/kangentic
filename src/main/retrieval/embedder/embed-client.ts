import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { PATHS } from '../../config/paths';
import { UtilityRestartPolicy } from '../../utility-process/restart-policy';
import { StderrTail, UTILITY_PROCESS_STDIO, captureWorkerStderr } from '../../utility-process/stderr-tail';
import { unpacked } from '../../utility-process/paths';
import { HEAVY_IDLE_SHUTDOWN_MS, WORKER_COMMIT_CEILING_BYTES, readProcessCommitBytes } from '../../utility-process/commit-ceiling';
import type { Embedder } from '../types';
import type { EmbeddingModelDef } from './embedding-config';
import type { MemoryAcceleration } from '../../../shared/types';

/** Max queued embed requests before new ones resolve null (backpressure). */
const QUEUE_CAP = 64;
/** Per-request timeout; the caller may lower it for latency-sensitive queries. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Cold init (WASM compile + model load) can exceed a request timeout. */
const INIT_TIMEOUT_MS = 120_000;
/** Kill the worker after this long without a request, unless the engine is
 *  holding it for a drain in progress. Generous on purpose: a cold load is a
 *  3-4 s GPU/CPU burst (the spike commit 51893ffe added the hold to stop),
 *  so the worker should let go only once the index is genuinely finished and
 *  nobody has searched for a good while. Process exit is what gives the
 *  memory back - onnxruntime keeps its arena reservation for the life of the
 *  process (1.75 GB of commit for a 243 MB working set, #706). A worker whose
 *  commit has passed WORKER_COMMIT_CEILING_BYTES gets HEAVY_IDLE_SHUTDOWN_MS
 *  instead (utility-process/commit-ceiling.ts), still only once the drain
 *  has released it. */
const IDLE_SHUTDOWN_MS = 30 * 60_000;
/** After this many crashes inside the restart policy's decay window, disable
 *  the semantic layer. A window rather than the whole app run: a worker that
 *  dies three times in a burst (a bad GPU provider on a cold start, say) used to
 *  disable semantic search until restart, with no in-app signal. */
const MAX_CRASHES = 3;
const SERVICE_NAME = 'kangentic-embeddings';

/**
 * The ordered onnxruntime execution providers to try for an acceleration
 * preference, most-preferred first. 'auto' and 'gpu' both prefer a GPU provider
 * then fall back to CPU, so the semantic layer never breaks when the GPU is
 * unavailable or fails to initialize; 'cpu' forces the universal path. DirectML
 * is the broadly-available GPU provider on Windows (any DX12 GPU); WebGPU is the
 * cross-platform GPU fallback elsewhere.
 */
export function resolveDeviceChain(
  acceleration: MemoryAcceleration,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (acceleration === 'cpu') return ['cpu'];
  const gpu = platform === 'win32' ? 'dml' : 'webgpu';
  return [gpu, 'cpu'];
}

interface PendingRequest {
  resolve: (vectors: Float32Array[] | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client for the embedding utilityProcess worker. Spawns lazily on first demand
 * (or ahead of it, via `prewarm()`), shuts the worker down once it has gone
 * IDLE_SHUTDOWN_MS without a request (unless `setWarmHold(true)` is held, which
 * the engine does only while a drain has work pending), and restarts it (with a
 * crash cap) after an unexpected exit. Every failure path - not spawned,
 * crashed, timed out, over the queue cap, or an interactive query whose budget
 * ran out during a cold start - resolves `null` so callers degrade to
 * lexical-only rather than throwing. `dispose()` is synchronous for the
 * shutdown path.
 */
export class EmbedClient implements Embedder {
  readonly dimensions: number;
  readonly modelTag: string;
  readonly noiseFloor: number;

  private readonly deviceChain: string[];
  private readonly restartPolicy: UtilityRestartPolicy;
  /** Commit reader behind the ceiling check; injectable so tests drive it. */
  private readonly readCommitBytes: (pid: number) => number | null;

  constructor(
    private readonly model: EmbeddingModelDef,
    acceleration: MemoryAcceleration = 'auto',
    restartPolicy?: UtilityRestartPolicy,
    options?: { readCommitBytes?: (pid: number) => number | null },
  ) {
    this.dimensions = model.dimensions;
    this.modelTag = model.modelTag;
    this.noiseFloor = model.noiseFloor;
    this.deviceChain = resolveDeviceChain(acceleration);
    this.restartPolicy = restartPolicy
      ?? new UtilityRestartPolicy({ service: SERVICE_NAME, maxCrashes: MAX_CRASHES });
    this.readCommitBytes = options?.readCommitBytes ?? readProcessCommitBytes;
  }

  private child: UtilityProcess | null = null;
  private readyPromise: Promise<boolean> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private currentActiveDevice: string | null = null;
  /** While true, the idle recycle never fires, so the worker (and its loaded
   *  model + GPU backend) stays resident. The engine holds it while a drain
   *  has a batch pending and releases it once every dirty project is caught
   *  up; a query never holds, it just re-arms the idle timer. */
  private warmHold = false;
  /** True while an intentional teardown (idle recycle or dispose) is in flight,
   *  so the resulting 'exit' is not miscounted as a crash. */
  private intentionalShutdown = false;
  /** Resolved (and cleared) whenever no interactive (non-background) request
   *  is in flight. See waitForInteractiveIdle(). */
  private interactiveIdleWaiters: Array<() => void> = [];
  /** Count of interactive (non-background) embed() calls currently anywhere in
   *  flight - INCLUDING the ensureReady() worker-spawn/init window, before the
   *  request reaches `this.pending` in sendEmbed(). This is what
   *  hasInteractiveInFlight() consults: scanning `pending` alone would miss a
   *  live query still blocked in ensureReady() on a cold worker start, letting
   *  the background drain post ahead of it and break the "a live query always
   *  preempts the drain" invariant. */
  private interactiveInFlightCount = 0;

  get crashed(): boolean {
    return this.restartPolicy.exhausted;
  }

  /** Why the worker is off, for the Memory tab: the newest crash's exit code
   *  and first error line. Null while nothing has crashed in the window. */
  get crashReason(): string | null {
    return this.restartPolicy.lastCrashDescription;
  }

  /** The execution provider the worker actually initialized on this run
   *  (e.g. 'dml', 'webgpu', 'cpu'), or null before the worker has reported ready. */
  get activeDevice(): string | null {
    return this.currentActiveDevice;
  }

  async embed(
    texts: string[],
    opts?: { timeoutMs?: number; isQuery?: boolean; background?: boolean },
  ): Promise<Float32Array[] | null> {
    if (texts.length === 0) return [];
    if (this.disposed || this.crashed) return null;
    if (this.pending.size >= QUEUE_CAP) return null;

    const background = opts?.background ?? false;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Track interactive intent BEFORE ensureReady() so a live query counts as
    // in-flight during the cold-start worker-spawn window, not only once it
    // reaches sendEmbed(). Cleared in the finally, which also wakes any waiters.
    if (!background) this.interactiveInFlightCount += 1;
    try {
      // A background batch waits out a cold start however long it takes. An
      // interactive query spends its own budget on it and then degrades to
      // lexical, while the init it started carries on for the next query to
      // join: Quick Find on a released worker keeps answering keystrokes
      // instead of stalling for the model load.
      const ready = background ? await this.ensureReady() : await this.readyWithin(timeoutMs);
      if (!ready || this.disposed) return null;

      this.clearIdleTimer();
      try {
        return await this.sendEmbed(texts, timeoutMs, opts?.isQuery ?? false);
      } finally {
        this.armIdleShutdown();
      }
    } finally {
      if (!background) {
        this.interactiveInFlightCount -= 1;
        this.notifyInteractiveIdleIfClear();
      }
    }
  }

  /** Spawn and initialize the worker ahead of a query, embedding nothing.
   *  Fired from the Quick Find open: the typing that follows is the free
   *  window for the cold start. Shares `ensureReady()`'s memo with the query
   *  path, so it is never a second load; the ready settle arms the idle timer. */
  async prewarm(): Promise<void> {
    if (this.disposed || this.crashed) return;
    await this.ensureReady();
  }

  /** `ensureReady()` bounded by `ms`: false when the init has not finished in
   *  time. The init keeps running and stays memoized either way. */
  private readyWithin(ms: number): Promise<boolean> {
    const ready = this.ensureReady();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref();
      void ready.then((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  /** Resolves once no interactive (non-background) request is in flight.
   *  The background drain (embed-engine) awaits this before every post so it
   *  never sits in front of a live search / MCP recall query. Resolves
   *  immediately when nothing interactive is pending. */
  waitForInteractiveIdle(): Promise<void> {
    if (!this.hasInteractiveInFlight()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.interactiveIdleWaiters.push(resolve);
    });
  }

  private hasInteractiveInFlight(): boolean {
    // Counter, not a `pending` scan: it also covers the ensureReady() window
    // before an interactive request is recorded in `pending`, and it spans the
    // full embed() call for every non-background request, so it strictly
    // subsumes the old scan.
    return this.interactiveInFlightCount > 0;
  }

  private notifyInteractiveIdleIfClear(): void {
    if (this.interactiveIdleWaiters.length === 0) return;
    if (this.hasInteractiveInFlight()) return;
    const waiters = this.interactiveIdleWaiters;
    this.interactiveIdleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Spawn + init the worker if needed. Memoized; returns false on failure. */
  private ensureReady(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.child && this.readyPromise) return this.readyPromise;
    // Covers both "given up" and "still inside the post-crash backoff window".
    // A false here degrades the caller to lexical-only, which is the same path
    // an absent worker already takes.
    if (!this.restartPolicy.maySpawn()) return Promise.resolve(false);

    const workerPath = unpacked(path.join(__dirname, 'embed-worker.js'));
    const modelDir = PATHS.embeddingModelsDir;
    const wasmDir = path.join(unpacked(app.getAppPath()), 'node_modules', 'onnxruntime-web', 'dist', path.sep);

    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(workerPath, [], { serviceName: SERVICE_NAME, stdio: UTILITY_PROCESS_STDIO });
    } catch (error) {
      // A fork that throws is a crash like any other, so it goes through the
      // policy rather than latching the cap directly - otherwise one transient
      // fork failure disabled the semantic layer permanently, with no decay.
      console.warn('[retrieval] embed worker fork failed:', error);
      this.restartPolicy.recordCrash(null);
      return Promise.resolve(false);
    }
    this.child = child;

    // stderr is piped and drained from the first tick, before init is posted:
    // an undrained pipe blocks the worker, and the tail is what names a crash
    // in the project log and the Sentry report (see stderr-tail.ts).
    const stderrTail = new StderrTail();
    captureWorkerStderr(child, stderrTail, !app.isPackaged);

    child.on('message', (message: unknown) => this.onWorkerMessage(message));
    child.on('exit', (code: number) => this.onWorkerExit(child, code, stderrTail));

    this.readyPromise = new Promise<boolean>((resolve) => {
      const readyTimer = setTimeout(() => resolve(false), INIT_TIMEOUT_MS);
      readyTimer.unref();
      this.readyResolver = (ok: boolean) => {
        clearTimeout(readyTimer);
        resolve(ok);
        // Every spawn gets its idle timer here, whoever spawned it: a prewarm
        // posts no request to arm one from, and an interactive query that
        // gave up during this init is no longer around to. A request that
        // follows clears and re-arms it as usual.
        if (ok) this.armIdleShutdown();
      };
    });

    child.postMessage({
      type: 'init',
      modelId: this.model.hfId,
      modelDir,
      wasmDir,
      dtype: this.model.dtype,
      pooling: this.model.pooling,
      queryPrefix: this.model.queryPrefix,
      devices: this.deviceChain,
    });

    return this.readyPromise;
  }

  private readyResolver: ((ok: boolean) => void) | null = null;

  private sendEmbed(
    texts: string[],
    timeoutMs: number,
    isQuery: boolean,
  ): Promise<Float32Array[] | null> {
    if (!this.child) return Promise.resolve(null);
    const requestId = this.nextRequestId++;
    return new Promise<Float32Array[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.notifyInteractiveIdleIfClear();
        resolve(null);
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, timer });
      this.child?.postMessage({ type: 'embed', id: requestId, texts, isQuery });
    });
  }

  private onWorkerMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const record = message as { type?: string; id?: number; vectors?: Float32Array[]; device?: string };
    if (record.type === 'ready') {
      this.currentActiveDevice = typeof record.device === 'string' ? record.device : null;
      this.readyResolver?.(true);
      this.readyResolver = null;
      return;
    }
    if (record.type === 'error' && record.id === undefined) {
      // Init error (model load / backend). Surface it - a silently swallowed init
      // error here is exactly what let a device/version mismatch degrade every
      // search to lexical with no trace. Then fail readiness so callers degrade.
      console.warn('[retrieval] embed worker init failed:', (message as { message?: unknown }).message);
      this.readyResolver?.(false);
      this.readyResolver = null;
      return;
    }
    if ((record.type === 'result' || record.type === 'error') && typeof record.id === 'number') {
      const entry = this.pending.get(record.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(record.id);
      this.notifyInteractiveIdleIfClear();
      entry.resolve(record.type === 'result' ? record.vectors ?? null : null);
    }
  }

  private onWorkerExit(child: UtilityProcess, exitCode?: number, stderrTail?: StderrTail): void {
    const intentional = this.intentionalShutdown;
    // Cleared BEFORE the staleness guard below, not after. The flag belongs to
    // the teardown that set it, so a stale exit must still consume it -
    // otherwise it stays latched and the NEXT worker's genuine crash reads as
    // intentional and is never counted.
    this.intentionalShutdown = false;
    // A killed worker's 'exit' arrives asynchronously, after a replacement may
    // already have been spawned and tracked. Ignore the stale exit so it never
    // nulls the live child or resolves the replacement's in-flight requests.
    // LineCountClient has had this guard; this client did not, so a recycle
    // racing a respawn could tear down the new worker's state. `killChild`
    // nulls `this.child` before killing, so an ordinary intentional exit
    // arrives with `this.child === null` and correctly falls through.
    if (this.child !== null && child !== this.child) return;
    this.child = null;
    // A crash must not leave the idle timer counting down against a child
    // that is already gone.
    this.clearIdleTimer();
    this.currentActiveDevice = null;
    this.readyPromise = null;
    this.readyResolver?.(false);
    this.readyResolver = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pending.clear();
    this.notifyInteractiveIdleIfClear();
    // An idle recycle or dispose is not a crash; only an unexpected exit counts.
    if (!this.disposed && !intentional) this.restartPolicy.recordCrash(exitCode, stderrTail);
  }

  /** Hold (or release) the worker against the idle recycle. Releasing re-arms
   *  the timer immediately so a stale hold does not linger past its use. A
   *  no-op when nothing changes: a release with no hold taken must leave a
   *  countdown already running alone, or every "nothing to drain" pass
   *  would restart it. */
  setWarmHold(hold: boolean): void {
    if (hold === this.warmHold) return;
    this.warmHold = hold;
    if (hold) this.clearIdleTimer();
    else this.armIdleShutdown();
  }

  private armIdleShutdown(): void {
    if (this.disposed || !this.child || this.warmHold || this.idleTimer || this.pending.size > 0) return;
    const delayMs = this.overCommitCeiling() ? HEAVY_IDLE_SHUTDOWN_MS : IDLE_SHUTDOWN_MS;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.child && this.pending.size === 0) this.killChild();
    }, delayMs);
    this.idleTimer.unref();
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
    this.readyPromise = null;
    if (child) {
      // Set only when there is a child to classify. Latched with nothing to
      // kill, the flag would be consumed by the NEXT worker's genuine crash
      // and read it as intentional.
      this.intentionalShutdown = true;
      try {
        child.postMessage({ type: 'shutdown' });
      } catch {
        // ignore; kill below is the real teardown
      }
      child.kill();
    }
  }

  /** Synchronous shutdown for the before-quit path. */
  dispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pending.clear();
    this.notifyInteractiveIdleIfClear();
    this.killChild();
  }
}
