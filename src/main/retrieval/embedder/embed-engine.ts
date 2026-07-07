/**
 * Central, project-agnostic background embedding engine. This is the ONLY
 * embedder of chunks in the app - lifecycle/navigation events (project open,
 * session finalize, live turn-boundary index) only INDEX (a cheap diff-upsert)
 * and call `markDirty(projectId)`; they never embed inline. A project switch
 * therefore performs zero synchronous embedding work, which is what makes the
 * felt hardware spike on project switch impossible by construction.
 *
 * Owns the embed worker singleton (moved out of retrieval-service.ts), a
 * dirty-set of project ids with pending chunks, and a single self-paced drain
 * loop that:
 *  - round-robins across dirty projects, FIFO within each (oldest chunk id
 *    first, via RetrievalStore.chunksNeedingEmbedding),
 *  - embeds one small batch at a time and paces itself with a measured
 *    duty-cycle sleep (see computeEmbedSleepMs) so embedding's own
 *    contribution to CPU/GPU never sustains a peg on any backend - this
 *    applies identically to steady per-turn churn AND to a large first-run or
 *    model-switch backfill, which is why those large one-time passes are
 *    silent instead of a felt burn,
 *  - always yields the shared worker to a live interactive query (search /
 *    MCP recall) via `waitForInteractiveIdle()`, bounded so a continuous
 *    stream of queries can slow but never permanently starve the drain.
 *
 * The DB is the durable queue (`chunksNeedingEmbedding` / `embedded_model`),
 * so a crash mid-drain just leaves chunks pending; the next markDirty (or the
 * getStatus safety-net re-mark) resumes them - nothing is lost.
 */

import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { RetrievalStore } from '../retrieval-store';
import { hasVecSupport } from '../vec-support';
import { EmbedClient } from './embed-client';
import { EMBED_DRAIN_BATCH, EMBED_DUTY_CYCLE, resolveEmbeddingModel, type EmbeddingModelDef } from './embedding-config';
import { isEmbeddingModelPresent } from './embedding-model';
import type { IpcContext } from '../../ipc/ipc-context';
import type { Embedder, StoredChunk } from '../types';
import type { MemoryAcceleration } from '../../../shared/types';

/** The narrow slice of RetrievalStore the engine actually uses. Structural
 *  (not the concrete class) so unit tests inject a plain fake object without
 *  having to satisfy RetrievalStore's private fields. */
export interface EmbedStore {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  resetVec(dimensions: number): void;
  ensureVecTable(dimensions: number): void;
  readonly hasVec: boolean;
  chunksNeedingEmbedding(modelTag: string, limit: number): StoredChunk[];
  writeEmbeddings(rows: Array<{ chunkId: number; vector: Float32Array; contentHash: string }>, modelTag: string): void;
}

/** The narrow slice of EmbedClient the engine actually uses. Structural, for
 *  the same reason as EmbedStore. Extends `Embedder` (dimensions/modelTag/
 *  noiseFloor/embed) because resolveEmbedder hands this straight to the
 *  interactive query path, which relies on those fields. */
export interface EmbedWorkerClient extends Embedder {
  embed(texts: string[], opts?: { timeoutMs?: number; isQuery?: boolean; background?: boolean }): Promise<Float32Array[] | null>;
  setWarmHold(hold: boolean): void;
  waitForInteractiveIdle(): Promise<void>;
  dispose(): void;
  readonly crashed: boolean;
  readonly activeDevice: string | null;
}

/** How long a batch's transient failure (timeout / queue-full) backs off
 *  before the project is retried. */
const TRANSIENT_BACKOFF_MS = 2_000;
/** Upper bound on how long the drain waits for the worker to go interactive-
 *  idle before posting anyway. Keeps a continuous stream of live queries from
 *  permanently starving the background drain. */
const INTERACTIVE_IDLE_WAIT_CAP_MS = 300;

/** Pure duty-cycle pacer: given the last batch's measured wall-time, how long
 *  to sleep so the worker infers for at most `dutyCycle` of wall-time. This is
 *  a machine-independent AVERAGE ceiling (not a wall-clock target): because it
 *  is driven by the batch's REAL measured time, it self-adapts to any
 *  backend/model with no per-device tuning table, and it self-throttles
 *  GENTLER under contention (a busy machine inflates batchMs, which inflates
 *  the sleep) - it can never make an already-busy machine busier. */
export function computeEmbedSleepMs(lastBatchMs: number, dutyCycle: number): number {
  if (dutyCycle <= 0) return 0;
  return Math.max(0, lastBatchMs * (1 / dutyCycle - 1));
}

/** Wait for `promise` to settle, or fall through after `capMs` - whichever is
 *  first. Used to bound the interactive-idle wait. */
function raceWithCap(promise: Promise<void>, capMs: number, delay: (ms: number) => Promise<void>): Promise<void> {
  return Promise.race([promise, delay(capMs)]);
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export interface EmbedEngineDeps {
  getDb: (projectId: string) => Database.Database;
  createStore: (db: Database.Database) => EmbedStore;
  createClient: (model: EmbeddingModelDef, acceleration: MemoryAcceleration) => EmbedWorkerClient;
  delay: (ms: number) => Promise<void>;
  dutyCycle: number;
  drainBatchSize: number;
  interactiveIdleWaitCapMs: number;
  transientBackoffMs: number;
}

const defaultDeps: EmbedEngineDeps = {
  getDb: getProjectDb,
  createStore: (db) => new RetrievalStore(db),
  createClient: (model, acceleration) => new EmbedClient(model, acceleration),
  delay: defaultDelay,
  dutyCycle: EMBED_DUTY_CYCLE,
  drainBatchSize: EMBED_DRAIN_BATCH,
  interactiveIdleWaitCapMs: INTERACTIVE_IDLE_WAIT_CAP_MS,
  transientBackoffMs: TRANSIENT_BACKOFF_MS,
};

/** Config/model accessors the engine needs from an IpcContext. Kept as free
 *  functions (mirroring retrieval-service.ts) rather than methods so the
 *  engine has no dependency on the service module. */
function isSemanticEnabled(context: IpcContext): boolean {
  try {
    return context.configManager.load().memory?.semanticEnabled === true;
  } catch {
    return false;
  }
}

function selectedModel(context: IpcContext): EmbeddingModelDef {
  try {
    return resolveEmbeddingModel(context.configManager.load().memory?.embeddingModel);
  } catch {
    return resolveEmbeddingModel(undefined);
  }
}

function selectedAcceleration(context: IpcContext): MemoryAcceleration {
  try {
    return context.configManager.load().memory?.acceleration ?? 'auto';
  } catch {
    return 'auto';
  }
}

/** Whether the embed worker should stay warm (never idle-recycle): semantic
 *  is enabled and a project is open. Gates every cold-load spike the same way
 *  regardless of which path (task-detail open, Quick Find, MCP recall,
 *  background drain) touches the worker next. */
function shouldWarmHold(context: IpcContext, disposed: boolean): boolean {
  return !disposed && isSemanticEnabled(context) && context.currentProjectId != null;
}

export function createEmbedEngine(overrides?: Partial<EmbedEngineDeps>) {
  const deps: EmbedEngineDeps = { ...defaultDeps, ...overrides };

  let attachedContext: IpcContext | null = null;
  let disposed = false;
  let started = false;

  // Embed worker state, moved out of retrieval-service.ts. One client for the
  // whole app: shared by the background drain AND the interactive query path.
  let client: EmbedWorkerClient | null = null;
  let activeModelId: string | null = null;
  let activeAcceleration: MemoryAcceleration | null = null;

  const dirty = new Set<string>();
  let wakeResolve: (() => void) | null = null;
  let wakePromise: Promise<void> | null = null;

  /**
   * Per-project drain-run metrics, for empirically tuning EMBED_DUTY_CYCLE /
   * EMBED_DRAIN_BATCH on real hardware: a "run" starts at the first batch
   * embedded after a project was idle (not merely when it was marked dirty -
   * time spent parked with semantic disabled, or waiting for a crashed
   * client, is deliberately excluded so the throughput number reflects only
   * actual drain work) and ends when the project next has nothing pending.
   * console.debug/info so the trace is always visible live in the terminal
   * and captured to `.kangentic/logs/` only when
   * Settings -> Developer -> Persist Console Logs is on (see log-mirror.ts) -
   * no verbose logging cost for a user who never turns that on.
   */
  const drainRuns = new Map<string, { startedAt: number; chunks: number; batches: number }>();

  function wake(): void {
    if (wakeResolve) {
      wakeResolve();
      wakeResolve = null;
      wakePromise = null;
    }
  }

  function waitForWake(): Promise<void> {
    if (!wakePromise) {
      wakePromise = new Promise<void>((resolve) => {
        wakeResolve = resolve;
      });
    }
    return wakePromise;
  }

  /** The client for `model` + `acceleration`, recreating it when either the
   *  selected model or the acceleration preference changed. Re-resolved on
   *  every drain iteration (never cached across a model switch) and by the
   *  query path. */
  function getClientFor(model: EmbeddingModelDef, acceleration: MemoryAcceleration): EmbedWorkerClient {
    if (client && (activeModelId !== model.id || activeAcceleration !== acceleration)) {
      client.dispose();
      client = null;
    }
    if (!client) {
      client = deps.createClient(model, acceleration);
      activeModelId = model.id;
      activeAcceleration = acceleration;
    }
    return client;
  }

  /** The embedder for the interactive query path (search / MCP recall), or
   *  null for lexical-only. Non-null only when semantic is enabled, the model
   *  is present, and the worker has not crashed past its cap. */
  function resolveEmbedder(context: IpcContext): Embedder | null {
    if (disposed || !isSemanticEnabled(context)) return null;
    const model = selectedModel(context);
    if (!isEmbeddingModelPresent(model)) return null;
    const resolved = getClientFor(model, selectedAcceleration(context));
    resolved.setWarmHold(shouldWarmHold(context, disposed));
    return resolved.crashed ? null : resolved;
  }

  /** Re-evaluate the warm-hold gate, and (when semantic just became viable)
   *  mark the current project dirty. This subsumes the old
   *  scheduleEmbedHeal: enabling semantic while the model is ALREADY on disk,
   *  or switching model/acceleration, would otherwise never fire a fresh
   *  embed trigger. */
  function reconcileWarmHoldAndDirty(context: IpcContext): void {
    if (shouldWarmHold(context, disposed)) {
      client?.setWarmHold(true);
    } else if (client) {
      client.dispose();
      client = null;
      activeModelId = null;
      activeAcceleration = null;
    }
    const projectId = context.currentProjectId;
    if (projectId && isSemanticEnabled(context) && isEmbeddingModelPresent(selectedModel(context))) {
      markDirty(projectId);
    }
  }

  function markDirty(projectId: string): void {
    if (disposed) return;
    dirty.add(projectId);
    wake();
  }

  /** Vec-table dimension sync for one project, moved verbatim from the old
   *  embedPass. A dimension change (a different model) needs a full reset;
   *  same-dimension model switches are handled by the model-tag re-embed in
   *  chunksNeedingEmbedding. Returns false when the project has no usable vec
   *  table (structurally lexical-only), so the drain should skip it. */
  function syncVecTable(store: EmbedStore, model: EmbeddingModelDef): boolean {
    const storedDims = store.getMeta('vec_dims');
    if (storedDims !== String(model.dimensions)) {
      store.resetVec(model.dimensions);
      store.setMeta('vec_dims', String(model.dimensions));
    } else {
      store.ensureVecTable(model.dimensions);
    }
    return store.hasVec;
  }

  /** Pop the next dirty project in round-robin order (insertion order of a
   *  Set). runLoop deletes the popped id before draining and re-adds it (at
   *  the back) only when more work remains, which is what makes this an
   *  actual round-robin across N dirty projects rather than draining one
   *  project to completion before ever trying another. */
  function nextDirtyProject(): string | undefined {
    for (const projectId of dirty) return projectId;
    return undefined;
  }

  type DrainResult = 'drained' | 'more-pending' | 'crashed' | 'transient';

  /** Drain (at most) one small batch for one project. Never mutates `dirty`
   *  itself - runLoop owns rotation based on the returned status, so a
   *  project with more pending work moves to the BACK of the round-robin
   *  instead of being drained to completion before any other project gets a
   *  turn. */
  async function drainOnce(context: IpcContext, projectId: string): Promise<DrainResult> {
    // isSemanticEnabled is not re-checked here: runLoop only calls drainOnce
    // once its own isSemanticEnabled gate has just passed, and treating a
    // disabled semantic layer as 'drained' here would permanently drop a
    // project's dirty flag even though real chunks remain pending.
    const model = selectedModel(context);
    if (!isEmbeddingModelPresent(model)) return 'drained';

    let db;
    try {
      db = deps.getDb(projectId);
    } catch {
      return 'drained';
    }
    if (!hasVecSupport(db)) return 'drained';
    const store = deps.createStore(db);
    if (!syncVecTable(store, model)) return 'drained';

    const resolvedClient = getClientFor(model, selectedAcceleration(context));
    resolvedClient.setWarmHold(shouldWarmHold(context, disposed));

    if (resolvedClient.crashed) {
      // Terminal for this client instance (MAX_CRASHES reached): every
      // project shares the one client, so there is nothing project-specific
      // to retry here. runLoop parks the WHOLE loop on this result rather
      // than busy-spinning through every dirty project against a dead
      // worker. A model/acceleration change (via reconcile) creates a fresh
      // client and wakes the loop; an app restart gets one too.
      return 'crashed';
    }

    const batch = store.chunksNeedingEmbedding(model.modelTag, deps.drainBatchSize);
    if (batch.length === 0) {
      const run = drainRuns.get(projectId);
      if (run) {
        drainRuns.delete(projectId);
        const elapsedMs = Date.now() - run.startedAt;
        console.info('[embed-engine] drain complete', {
          projectId,
          modelId: model.id,
          modelTag: model.modelTag,
          chunksEmbedded: run.chunks,
          batches: run.batches,
          elapsedMs,
          chunksPerMinute: elapsedMs > 0 ? Math.round((run.chunks / elapsedMs) * 60_000) : null,
        });
      }
      return 'drained';
    }

    // Never let a background batch sit in front of a live interactive query.
    // Bounded so a continuous query stream slows, but never permanently
    // starves, the drain.
    await raceWithCap(resolvedClient.waitForInteractiveIdle(), deps.interactiveIdleWaitCapMs, deps.delay);

    if (!drainRuns.has(projectId)) {
      drainRuns.set(projectId, { startedAt: Date.now(), chunks: 0, batches: 0 });
    }

    const startedAt = Date.now();
    const vectors = await resolvedClient.embed(
      batch.map((chunk) => chunk.text),
      { isQuery: false, background: true },
    );
    const batchMs = Date.now() - startedAt;

    if (!vectors) {
      // Transient (timeout / queue full / worker mid-restart): keep the
      // project dirty and back off a short fixed delay rather than busy-spin.
      await deps.delay(deps.transientBackoffMs);
      return 'transient';
    }

    store.writeEmbeddings(
      batch.map((chunk, index) => ({ chunkId: chunk.id, vector: vectors[index], contentHash: chunk.contentHash })),
      model.modelTag,
    );

    const sleepMs = computeEmbedSleepMs(batchMs, deps.dutyCycle);
    const run = drainRuns.get(projectId);
    if (run) {
      run.chunks += batch.length;
      run.batches += 1;
    }
    console.debug('[embed-engine] batch', {
      projectId,
      modelId: model.id,
      batchSize: batch.length,
      batchMs,
      sleepMs,
      dutyCycle: deps.dutyCycle,
    });

    await deps.delay(sleepMs);
    return 'more-pending';
  }

  async function runLoop(): Promise<void> {
    while (!disposed) {
      try {
        const context = attachedContext;
        if (!context || !isSemanticEnabled(context) || dirty.size === 0) {
          await waitForWake();
          continue;
        }
        const projectId = nextDirtyProject();
        if (projectId === undefined) {
          await waitForWake();
          continue;
        }
        // Pop for this turn; re-added below (at the back) only if more work
        // remains, so a project with a deep backlog does not monopolize the
        // loop ahead of other dirty projects.
        dirty.delete(projectId);
        const result = await drainOnce(context, projectId);
        if (disposed) continue;
        if (result === 'more-pending' || result === 'transient') {
          dirty.add(projectId);
        } else if (result === 'crashed') {
          dirty.add(projectId);
          // One shared client: every dirty project would hit the same
          // 'crashed' result right now, so park the whole loop instead of
          // thrashing through each of them. Woken by the next markDirty
          // (e.g. reconcile() after a model/acceleration change).
          await waitForWake();
        }
        // 'drained' -> leave popped; the project is fully caught up.
      } catch (error) {
        console.warn('[embed-engine] drain iteration failed:', error);
      }
    }
  }

  return {
    /** Capture the stable process-global IpcContext and start the drain loop.
     *  Idempotent; call once at startup. `markDirty` stays context-free
     *  because this captured context carries all config/model/warm-hold
     *  reads. */
    attach(context: IpcContext): void {
      attachedContext = context;
      if (started || disposed) return;
      started = true;
      void runLoop();
    },

    markDirty,

    getEmbedder(context: IpcContext): Embedder | null {
      return resolveEmbedder(context);
    },

    reconcile(context: IpcContext): void {
      reconcileWarmHoldAndDirty(context);
    },

    get activeDevice(): string | null {
      return client?.activeDevice ?? null;
    },

    get workerCrashed(): boolean {
      return client?.crashed ?? false;
    },

    /** Synchronous shutdown: mark disposed, resolve the wake deferred (so a
     *  parked loop unblocks and exits its while(!disposed) check on the next
     *  microtask instead of hanging forever), and dispose the worker
     *  (EmbedClient.dispose is synchronous). In-flight work is abandoned; the
     *  next open's markDirty resumes it. */
    dispose(): void {
      disposed = true;
      wake();
      client?.dispose();
      client = null;
      activeModelId = null;
      activeAcceleration = null;
      drainRuns.clear();
    },
  };
}

export type EmbedEngine = ReturnType<typeof createEmbedEngine>;

export const embedEngine = createEmbedEngine();
