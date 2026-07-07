import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { PATHS } from '../../config/paths';
import type { Embedder } from '../types';
import type { EmbeddingModelDef } from './embedding-config';
import type { MemoryAcceleration } from '../../../shared/types';

/** Max queued embed requests before new ones resolve null (backpressure). */
const QUEUE_CAP = 64;
/** Per-request timeout; the caller may lower it for latency-sensitive queries. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Cold init (WASM compile + model load) can exceed a request timeout. */
const INIT_TIMEOUT_MS = 120_000;
/** Kill the worker after this long idle to reclaim its memory. */
const IDLE_SHUTDOWN_MS = 5 * 60_000;
/** After this many crashes in one app run, disable the semantic layer. */
const MAX_CRASHES = 3;

/** Rewrite an in-asar path to its asar.unpacked twin when packaged. */
function unpacked(absolutePath: string): string {
  return app.isPackaged ? absolutePath.replace('app.asar', 'app.asar.unpacked') : absolutePath;
}

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
 * Client for the embedding utilityProcess worker. Spawns lazily on first demand,
 * shuts the worker down when idle (unless `setWarmHold(true)` is held), and
 * restarts it (with a crash cap) after an unexpected exit. Every failure path -
 * not spawned, crashed, timed out, over the queue cap - resolves `null` so
 * callers degrade to lexical-only rather than throwing. `dispose()` is
 * synchronous for the shutdown path.
 */
export class EmbedClient implements Embedder {
  readonly dimensions: number;
  readonly modelTag: string;
  readonly noiseFloor: number;

  private readonly deviceChain: string[];

  constructor(private readonly model: EmbeddingModelDef, acceleration: MemoryAcceleration = 'auto') {
    this.dimensions = model.dimensions;
    this.modelTag = model.modelTag;
    this.noiseFloor = model.noiseFloor;
    this.deviceChain = resolveDeviceChain(acceleration);
  }

  private child: UtilityProcess | null = null;
  private readyPromise: Promise<boolean> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private crashCount = 0;
  private disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private currentActiveDevice: string | null = null;
  /** While true, the idle recycle never fires, so the worker (and its loaded
   *  model + GPU backend) stays resident. The service holds it whenever semantic
   *  search is enabled and a project is open. */
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
    return this.crashCount >= MAX_CRASHES;
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
    // Track interactive intent BEFORE ensureReady() so a live query counts as
    // in-flight during the cold-start worker-spawn window, not only once it
    // reaches sendEmbed(). Cleared in the finally, which also wakes any waiters.
    if (!background) this.interactiveInFlightCount += 1;
    try {
      const ready = await this.ensureReady();
      if (!ready || this.disposed) return null;

      this.clearIdleTimer();
      try {
        return await this.sendEmbed(
          texts,
          opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          opts?.isQuery ?? false,
        );
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
    if (this.disposed || this.crashed) return Promise.resolve(false);
    if (this.child && this.readyPromise) return this.readyPromise;

    const workerPath = unpacked(path.join(__dirname, 'embed-worker.js'));
    const modelDir = PATHS.embeddingModelsDir;
    const wasmDir = path.join(unpacked(app.getAppPath()), 'node_modules', 'onnxruntime-web', 'dist', path.sep);

    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(workerPath, [], { serviceName: 'kangentic-embeddings' });
    } catch (error) {
      console.warn('[retrieval] embed worker fork failed:', error);
      this.crashCount = MAX_CRASHES;
      return Promise.resolve(false);
    }
    this.child = child;

    child.on('message', (message: unknown) => this.onWorkerMessage(message));
    child.on('exit', () => this.onWorkerExit());

    this.readyPromise = new Promise<boolean>((resolve) => {
      const readyTimer = setTimeout(() => resolve(false), INIT_TIMEOUT_MS);
      readyTimer.unref();
      this.readyResolver = (ok: boolean) => {
        clearTimeout(readyTimer);
        resolve(ok);
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

  private onWorkerExit(): void {
    this.child = null;
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
    if (!this.disposed && !this.intentionalShutdown) this.crashCount += 1;
    this.intentionalShutdown = false;
  }

  /** Hold (or release) the worker against the idle recycle. Releasing re-arms
   *  the timer immediately so a stale hold does not linger past its use. */
  setWarmHold(hold: boolean): void {
    this.warmHold = hold;
    if (hold) this.clearIdleTimer();
    else this.armIdleShutdown();
  }

  private armIdleShutdown(): void {
    if (this.disposed || this.warmHold || this.idleTimer || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) this.killChild();
    }, IDLE_SHUTDOWN_MS);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private killChild(): void {
    this.intentionalShutdown = true;
    const child = this.child;
    this.child = null;
    this.readyPromise = null;
    if (child) {
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
