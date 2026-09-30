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
 *    stream of queries can slow but never permanently starve the drain,
 *  - holds the worker resident only while it has a batch to embed, and
 *    releases it once every dirty project is caught up, so the worker's own
 *    idle recycle (EmbedClient.IDLE_SHUTDOWN_MS) can let a genuinely idle
 *    worker go. The hold used to be keyed on semantic search being ENABLED,
 *    which kept a 1.75 GB commit reservation resident for the life of the app
 *    with nothing to do (#706). It is keyed on work now; a query never holds,
 *    it just re-arms the idle timer, and opening the Knowledge Graph warms the
 *    worker (`prewarm`) so the first question after a release still lands warm.
 *
 * The DB is the durable queue (`chunksNeedingEmbedding` / `embedded_model`),
 * so a crash mid-drain just leaves chunks pending; the next markDirty (or the
 * getStatus safety-net re-mark) resumes them - nothing is lost. Its reads and
 * writes run in the retrieval worker (`embed-store-access.ts`); this loop
 * embeds and paces.
 */

import { CONVERSATION_CORPUS } from '../corpora';
import { EmbedClient } from './embed-client';
import { EMBED_DRAIN_BATCH, EMBED_DUTY_CYCLE, resolveEmbeddingModel, type EmbeddingModelDef } from './embedding-config';
import { isEmbeddingModelPresent } from './embedding-model';
import { retrievalClient, RetrievalUnavailableError } from '../retrieval-client';
import type { EmbedStoreAccess } from './embed-store-access';
import type { IpcContext } from '../../ipc/ipc-context';
import type { Embedder, StoredChunk } from '../types';
import type { KnowledgeGraphAcceleration } from '../../../shared/types';

export type { EmbedStore } from './embed-store-access';

/** The drain's database steps, run by the retrieval worker. */
const workerEmbedStoreAccess: EmbedStoreAccess = {
  // No call budget: a first batch after a model switch resets the vec
  // tables, which pages through every vector.
  nextBatch: (projectId, model, limit) => retrievalClient.call(
    'embed.nextBatch',
    { projectId, dimensions: model.dimensions, modelTag: model.modelTag, limit },
    { timeoutMs: null },
  ),
  write: (projectId, rows, modelTag) => retrievalClient.call('embed.write', { projectId, rows, modelTag }),
};

/** The narrow slice of EmbedClient the engine actually uses. Structural, for
 *  the same reason as EmbedStore. Extends `Embedder` (dimensions/modelTag/
 *  noiseFloor/embed) because resolveClient hands this straight to the
 *  interactive query path, which relies on those fields. */
export interface EmbedWorkerClient extends Embedder {
  embed(texts: string[], opts?: { timeoutMs?: number; isQuery?: boolean; background?: boolean }): Promise<Float32Array[] | null>;
  setWarmHold(hold: boolean): void;
  /** Spawn + init the worker ahead of a query, embedding nothing. */
  prewarm(): Promise<void>;
  waitForInteractiveIdle(): Promise<void>;
  dispose(): void;
  readonly crashed: boolean;
  /** Why the worker is off (exit code + first error line), or null. */
  readonly crashReason: string | null;
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
  store: EmbedStoreAccess;
  createClient: (model: EmbeddingModelDef, acceleration: KnowledgeGraphAcceleration) => EmbedWorkerClient;
  delay: (ms: number) => Promise<void>;
  dutyCycle: number;
  drainBatchSize: number;
  interactiveIdleWaitCapMs: number;
  transientBackoffMs: number;
  /** The clock the record-progress reports are paced by. */
  now: () => number;
}

/**
 * How often a run that embeds task records reports its progress. A full record
 * run takes minutes (2,342 chunks in about six on the real board), and a share
 * that moved only at the end sat at "0% embedded" the whole time.
 */
export const RECORD_PROGRESS_INTERVAL_MS = 30_000;

/** Batches a run embeds before its rate is taken as this machine's: the first
 *  batch pays the worker's warm-up. */
export const RATE_MIN_BATCHES = 3;

const defaultDeps: EmbedEngineDeps = {
  store: workerEmbedStoreAccess,
  createClient: (model, acceleration) => new EmbedClient(model, acceleration),
  delay: defaultDelay,
  dutyCycle: EMBED_DUTY_CYCLE,
  drainBatchSize: EMBED_DRAIN_BATCH,
  interactiveIdleWaitCapMs: INTERACTIVE_IDLE_WAIT_CAP_MS,
  transientBackoffMs: TRANSIENT_BACKOFF_MS,
  now: () => Date.now(),
};

/** Config/model accessors the engine needs from an IpcContext. Kept as free
 *  functions (mirroring retrieval-service.ts) rather than methods so the
 *  engine has no dependency on the service module. */
function isSemanticEnabled(context: IpcContext): boolean {
  try {
    return context.configManager.load().knowledgeGraph?.enabled === true;
  } catch {
    return false;
  }
}

function selectedModel(context: IpcContext): EmbeddingModelDef {
  try {
    return resolveEmbeddingModel(context.configManager.load().knowledgeGraph?.localModel);
  } catch {
    return resolveEmbeddingModel(undefined);
  }
}

function selectedAcceleration(context: IpcContext): KnowledgeGraphAcceleration {
  try {
    return context.configManager.load().knowledgeGraph?.acceleration ?? 'auto';
  } catch {
    return 'auto';
  }
}

/** Whether the shared client may stay around at all: semantic is enabled and
 *  a project is open. Off, the client is disposed outright (reconcile);
 *  on, it is the drain's pending work, not this gate, that holds it warm. */
function mayKeepClient(context: IpcContext, disposed: boolean): boolean {
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
  let activeAcceleration: KnowledgeGraphAcceleration | null = null;

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
  const drainRuns = new Map<string, {
    startedAt: number;
    chunks: number;
    batches: number;
    /** Chunks embedded that are not conversations: task records. */
    sideChunks: number;
    /** When this run last reported its records' progress. */
    reportedAt: number;
  }>();
  /**
   * Told when task records have been embedded: at most every
   * `RECORD_PROGRESS_INTERVAL_MS` while a run embeds them, and once when it has
   * nothing left. The Knowledge Graph re-reads its Index then: a corpus's
   * embedded share is read when the graph loads, and nothing else moves it, so
   * a row caught mid-embed (a task summary re-embeds its whole record) said
   * "98% embedded" until the graph was reopened.
   *
   * Only for a run that embedded something besides conversations. A
   * conversation-only run follows every agent turn, and a re-read after each
   * one recomputes the map's coverage on main (about 280 ms on a 92k-chunk
   * index) for every window showing the graph. A records-only re-read leaves
   * that coverage cached.
   */
  let onRecordsEmbedded: ((projectId: string) => void) | undefined;
  /**
   * Chunks this machine embeds a minute in the background, measured over the
   * latest drain run on wall time, duty-cycle sleeps and all. What a "minutes
   * left" estimate divides by, so it holds for this machine's device and
   * load, not a figure taken elsewhere. Null until a run has embedded
   * `RATE_MIN_BATCHES` batches this launch.
   */
  let measuredChunksPerMinute: number | null = null;

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
  function getClientFor(model: EmbeddingModelDef, acceleration: KnowledgeGraphAcceleration): EmbedWorkerClient {
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

  /** The client for the interactive paths (a search / MCP recall query, or a
   *  Knowledge Graph prewarm), or null for lexical-only. Non-null only when
   *  semantic is enabled, the model is present, and the worker has not
   *  crashed past its cap. Never holds the worker: a query's own embed()
   *  re-arms the idle timer, and a prewarm arms it on ready. */
  function resolveClient(context: IpcContext): EmbedWorkerClient | null {
    if (disposed || !isSemanticEnabled(context)) return null;
    const model = selectedModel(context);
    if (!isEmbeddingModelPresent(model)) return null;
    const resolved = getClientFor(model, selectedAcceleration(context));
    return resolved.crashed ? null : resolved;
  }

  /** Drop the client when it may no longer exist (semantic off, no project),
   *  and (when semantic just became viable) mark the current project dirty.
   *  This subsumes the old scheduleEmbedHeal: enabling semantic while the
   *  model is ALREADY on disk, or switching model/acceleration, would
   *  otherwise never fire a fresh embed trigger. */
  function reconcileClientAndDirty(context: IpcContext): void {
    if (client && !mayKeepClient(context, disposed)) {
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

    const resolvedClient = getClientFor(model, selectedAcceleration(context));

    if (resolvedClient.crashed) {
      // Terminal for this client instance (MAX_CRASHES reached): every
      // project shares the one client, so there is nothing project-specific
      // to retry here. runLoop parks the WHOLE loop on this result rather
      // than busy-spinning through every dirty project against a dead
      // worker. A model/acceleration change (via reconcile) creates a fresh
      // client and wakes the loop; an app restart gets one too.
      return 'crashed';
    }

    // The vec tables are put at the model's width first (a different width
    // resets them). Null: the project cannot hold vectors, lexical only.
    let batch: StoredChunk[] | null;
    try {
      batch = await deps.store.nextBatch(projectId, model, deps.drainBatchSize);
    } catch (error) {
      // The retrieval worker is restarting: keep the project for later.
      if (error instanceof RetrievalUnavailableError) {
        await deps.delay(deps.transientBackoffMs);
        return 'transient';
      }
      return 'drained';
    }
    if (batch === null) return 'drained';
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
        if (run.sideChunks > 0) onRecordsEmbedded?.(projectId);
      }
      return 'drained';
    }

    // There is a batch, so hold the worker resident until the dirty set is
    // empty again (runLoop releases it). Taken only now, AFTER the empty
    // check: getStatus re-marks the current project on every poll (the
    // Knowledge Graph tab polls every 1.5 s), and a hold taken on every such pass
    // would clear and re-arm the worker's idle countdown each time, so it
    // could never expire while that tab was open. Still ahead of the first
    // await, so no timer can fire between the wake and the hold.
    resolvedClient.setWarmHold(true);

    // Never let a background batch sit in front of a live interactive query.
    // Bounded so a continuous query stream slows, but never permanently
    // starves, the drain.
    await raceWithCap(resolvedClient.waitForInteractiveIdle(), deps.interactiveIdleWaitCapMs, deps.delay);

    if (!drainRuns.has(projectId)) {
      drainRuns.set(projectId, { startedAt: Date.now(), chunks: 0, batches: 0, sideChunks: 0, reportedAt: deps.now() });
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

    // Written by the retrieval worker. A batch lost to a worker restart is
    // still pending in the database and is embedded again.
    try {
      await deps.store.write(
        projectId,
        batch.map((chunk, index) => ({ chunkId: chunk.id, vector: vectors[index], contentHash: chunk.contentHash })),
        model.modelTag,
      );
    } catch (error) {
      if (!(error instanceof RetrievalUnavailableError)) throw error;
      await deps.delay(deps.transientBackoffMs);
      return 'transient';
    }

    const sleepMs = computeEmbedSleepMs(batchMs, deps.dutyCycle);
    const run = drainRuns.get(projectId);
    if (run) {
      run.chunks += batch.length;
      run.batches += 1;
      run.sideChunks += batch.filter((chunk) => !(CONVERSATION_CORPUS as ReadonlyArray<string>).includes(chunk.corpus)).length;
      // Progress on a long record run, so the Index's share moves while it runs.
      if (run.sideChunks > 0 && deps.now() - run.reportedAt >= RECORD_PROGRESS_INTERVAL_MS) {
        run.reportedAt = deps.now();
        onRecordsEmbedded?.(projectId);
      }
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
    // Taken after the sleep, so the rate counts the pacing a real drain pays.
    if (run && run.batches >= RATE_MIN_BATCHES) {
      measuredChunksPerMinute = (run.chunks / Math.max(1, Date.now() - run.startedAt)) * 60_000;
    }
    return 'more-pending';
  }

  async function runLoop(): Promise<void> {
    while (!disposed) {
      try {
        // Nothing pending anywhere: let the worker's idle recycle count down.
        // The one release point, at the top, so an iteration that threw (and
        // dropped its popped project) releases as surely as one that drained.
        // A no-op on a client whose hold was never taken.
        if (dirty.size === 0) client?.setWarmHold(false);
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

    /** Register the records-embedded listener. Last writer wins, like the graph's. */
    setOnRecordsEmbedded(listener: (projectId: string) => void): void {
      onRecordsEmbedded = listener;
    },

    getEmbedder(context: IpcContext): Embedder | null {
      return resolveClient(context);
    },

    reconcile(context: IpcContext): void {
      reconcileClientAndDirty(context);
    },

    /** Spawn + init the worker ahead of a query (Knowledge Graph open), embedding
     *  nothing. A no-op when there is nothing to warm. */
    prewarm(context: IpcContext): void {
      // Fired from an ipcMain.on handler, which has no promise to reject
      // into: an unhandled rejection here would be the whole main process's
      // problem. EmbedClient.prewarm resolves on every path today, so this
      // guards the contract rather than a known throw.
      void resolveClient(context)?.prewarm().catch(() => undefined);
    },

    get activeDevice(): string | null {
      return client?.activeDevice ?? null;
    },

    /** Background chunks a minute on this machine, or null before a run has measured it. */
    get chunksPerMinute(): number | null {
      return measuredChunksPerMinute;
    },

    get workerCrashed(): boolean {
      return client?.crashed ?? false;
    },

    get workerCrashReason(): string | null {
      return client?.crashReason ?? null;
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
