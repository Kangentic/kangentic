/**
 * Singleton orchestrator for conversation-memory indexing and the semantic
 * layer. Mirrors `prRefreshScheduler`'s lifecycle contract (deferred off the IPC
 * critical path, project-switch guarded, explicitly torn down on
 * switch/delete/shutdown, all timers `.unref()`'d). Owns:
 *  - the live finalize hooks (SessionManager 'exit' + suspended 'session-changed'),
 *  - a live turn-boundary hook (SessionManager 'activity' -> idle/permission) that
 *    re-indexes the active session so an in-progress conversation is searchable,
 *  - the per-open backfill sweep,
 *  - the embedding pass (Phase 2): local model download + embedding of chunks
 *    into the vec index, gated on memory.semanticEnabled + sqlite-vec,
 *  - a serial job chain (one indexing/embedding job in flight at a time),
 *  - config gating and synchronous shutdown (also disposes the embed worker).
 *
 * It reuses the existing SessionManager events rather than patching the four
 * PTY-layer finalize call sites, keeping all agent knowledge behind the adapter
 * boundary.
 */

import { getProjectDb } from '../db/database';
import { RetrievalStore } from './retrieval-store';
import { hasVecSupport } from './vec-support';
import { lastVecLoadError } from './vec-extension';
import { ConversationIndexer } from './conversation/conversation-indexer';
import { EmbedClient } from './embedder/embed-client';
import { EMBEDDING_MAX_BATCH, resolveEmbeddingModel, type EmbeddingModelDef } from './embedder/embedding-config';
import { isEmbeddingModelPresent, downloadEmbeddingModel } from './embedder/embedding-model';
import { requiresUserInteraction } from '../../shared/activity-state';
import type { IpcContext } from '../ipc/ipc-context';
import type { Embedder } from './types';
import type { MemoryStatus, MemorySemanticState, MemoryModelState, MemoryAcceleration, Project, ActivityState } from '../../shared/types';

/** Grace period after a finalize event before indexing, so the agent CLI has
 *  flushed its native history file. */
const FINALIZE_DEBOUNCE_MS = 2000;
/** Grace period after a turn completes (session goes idle / awaits permission)
 *  before a live re-index, so a burst of activity transitions within a turn
 *  coalesces into one index and the CLI has flushed the new turn to disk. */
const LIVE_INDEX_DEBOUNCE_MS = 1500;
/** Chunks fetched per embedding batch pass (each embed call is <= MAX_BATCH). */
const EMBED_PASS_LIMIT = 128;

const indexer = new ConversationIndexer();

let attached = false;
let disposed = false;
let activeSweepProjectId: string | null = null;
/** Serial job chain: one indexing/embedding job runs at a time. */
let jobChain: Promise<void> = Promise.resolve();
const pendingTimers = new Set<NodeJS.Timeout>();
/** Per-session trailing-debounce timers for live (turn-boundary) re-indexing. */
const liveIndexTimers = new Map<string, NodeJS.Timeout>();

// Semantic layer state.
let embedClient: EmbedClient | null = null;
/** Which model id `embedClient` was created for (so a model switch recreates it). */
let activeModelId: string | null = null;
/** Which acceleration `embedClient` was created for (a change recreates it). */
let activeAcceleration: MemoryAcceleration | null = null;
let modelDownloadState: 'idle' | 'downloading' | 'error' = 'idle';
let modelDownloadProgress = 0;
/** Which model id is currently downloading (a switch mid-download retriggers). */
let downloadingModelId: string | null = null;

/**
 * True when the currently open project's DB has sqlite-vec loaded. Read LIVE from
 * the connection - the extension is loaded by the project-DB initializer on every
 * `getProjectDb` open (see `setProjectDbInitializer(loadVecExtension)` in
 * index.ts) - rather than from a cached flag. A cached flag was wrong: it was only
 * set by `startForProject`, which runs from the `project:open` IPC handler but NOT
 * from `openProjectByPath` (the lighter path used by cold start and the ephemeral
 * dev preview). On those paths the DB is vec-capable yet the flag stayed false, so
 * the status reported "unavailable" while the model downloaded fine. `embedPass`
 * and `resolveEmbedder` already gate on the live `hasVecSupport(db)`; this aligns
 * the status surface with them.
 */
function currentProjectHasVec(context: IpcContext): boolean {
  const projectId = context.currentProjectId;
  if (!projectId) return false;
  try {
    return hasVecSupport(getProjectDb(projectId));
  } catch {
    return false;
  }
}

function isIndexingEnabled(context: IpcContext): boolean {
  try {
    return context.configManager.load().memory?.indexingEnabled !== false;
  } catch {
    return true;
  }
}

function isSemanticEnabled(context: IpcContext): boolean {
  try {
    return context.configManager.load().memory?.semanticEnabled === true;
  } catch {
    return false;
  }
}

/** The user-selected embedding model (or the default). */
function selectedModel(context: IpcContext): EmbeddingModelDef {
  try {
    return resolveEmbeddingModel(context.configManager.load().memory?.embeddingModel);
  } catch {
    return resolveEmbeddingModel(undefined);
  }
}

/** The user-selected embedding acceleration (or the default 'auto'). */
function selectedAcceleration(context: IpcContext): MemoryAcceleration {
  try {
    return context.configManager.load().memory?.acceleration ?? 'auto';
  } catch {
    return 'auto';
  }
}

/** Human-readable name for the execution provider the worker reported ready on. */
function humanizeBackend(device: string | null | undefined): string | undefined {
  switch (device) {
    case 'dml': return 'DirectML (GPU)';
    case 'webgpu': return 'WebGPU (GPU)';
    case 'cpu': return 'CPU';
    default: return device ?? undefined;
  }
}

/** The embed client for `model` + `acceleration`, recreating it when either the
 *  selected model or the acceleration preference changed. */
function getEmbedClientFor(model: EmbeddingModelDef, acceleration: MemoryAcceleration): EmbedClient {
  if (embedClient && (activeModelId !== model.id || activeAcceleration !== acceleration)) {
    embedClient.dispose();
    embedClient = null;
  }
  if (!embedClient) {
    embedClient = new EmbedClient(model, acceleration);
    activeModelId = model.id;
    activeAcceleration = acceleration;
  }
  return embedClient;
}

function chain(job: () => Promise<unknown>): void {
  jobChain = jobChain.then(() => job()).then(
    () => undefined,
    (error) => {
      console.warn('[retrieval] job failed:', error);
    },
  );
}

/** The embedder the search path should use, or null for lexical-only. Non-null
 *  only when semantic is enabled, the selected model is present, and the worker
 *  has not crashed past its cap. */
function resolveEmbedder(context: IpcContext): Embedder | null {
  if (disposed || !isSemanticEnabled(context)) return null;
  const model = selectedModel(context);
  if (!isEmbeddingModelPresent(model)) return null;
  const client = getEmbedClientFor(model, selectedAcceleration(context));
  return client.crashed ? null : client;
}

function scheduleFinalizeIndex(context: IpcContext, sessionId: string): void {
  if (disposed || !isIndexingEnabled(context)) return;
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    if (disposed || !isIndexingEnabled(context)) return;
    // Transient (command-terminal) sessions have no DB row; skip them.
    if (context.sessionManager.getSession(sessionId)?.transient) return;
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!projectId) return;
    chain(async () => {
      await indexer.indexSession(projectId, sessionId);
      // Embed the freshly indexed chunks when the semantic layer is active.
      if (isSemanticEnabled(context)) await embedPass(context, projectId);
    });
  }, FINALIZE_DEBOUNCE_MS);
  timer.unref();
  pendingTimers.add(timer);
}

/**
 * Debounced live re-index at a turn boundary. Fired when a session transitions
 * to "requires user interaction" (idle / permission) - i.e. the agent finished a
 * message and paused - so the current conversation becomes searchable within
 * ~1.5s instead of only after the session finalizes. This is a per-session
 * TRAILING debounce: rapid transitions within one turn reset the timer, so an
 * active session is indexed once per settled turn, never per event. It stays
 * cheap because `indexSession` diff-upserts (an unchanged transcript is a no-op)
 * and `embedPass` only embeds the new chunks (off the main thread, in the worker).
 */
function scheduleLiveIndex(context: IpcContext, sessionId: string): void {
  if (disposed || !isIndexingEnabled(context)) return;
  const existing = liveIndexTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    liveIndexTimers.delete(sessionId);
    if (disposed || !isIndexingEnabled(context)) return;
    // Transient (command-terminal) sessions have no DB row; skip them.
    if (context.sessionManager.getSession(sessionId)?.transient) return;
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!projectId) return;
    chain(async () => {
      await indexer.indexSession(projectId, sessionId);
      if (isSemanticEnabled(context)) await embedPass(context, projectId);
    });
  }, LIVE_INDEX_DEBOUNCE_MS);
  timer.unref();
  liveIndexTimers.set(sessionId, timer);
}

/** Embed any chunks in a project that still need an embedding for the selected
 *  model. Recreates the vec table at the model's dimension on a model switch.
 *  No-op unless semantic is enabled, the model is present, sqlite-vec loaded for
 *  this DB, and the worker is healthy. Passages embed WITHOUT a query prefix. */
async function embedPass(context: IpcContext, projectId: string): Promise<void> {
  if (disposed || !isSemanticEnabled(context)) return;
  const model = selectedModel(context);
  if (!isEmbeddingModelPresent(model)) return;
  let db;
  try {
    db = getProjectDb(projectId);
  } catch {
    return;
  }
  if (!hasVecSupport(db)) return;
  const store = new RetrievalStore(db);

  // Sync the vec table to the selected model's dimension. A dimension change
  // (e.g. bge-base's 768 vs 384) needs a full reset; same-dimension model
  // switches are handled by the model-tag re-embed below.
  const storedDims = store.getMeta('vec_dims');
  if (storedDims !== String(model.dimensions)) {
    store.resetVec(model.dimensions);
    store.setMeta('vec_dims', String(model.dimensions));
  } else {
    store.ensureVecTable(model.dimensions);
  }
  if (!store.hasVec) return;

  const client = getEmbedClientFor(model, selectedAcceleration(context));
  for (;;) {
    if (disposed || client.crashed) return;
    const chunks = store.chunksNeedingEmbedding(model.modelTag, EMBED_PASS_LIMIT);
    if (chunks.length === 0) return;
    for (let offset = 0; offset < chunks.length; offset += EMBEDDING_MAX_BATCH) {
      if (disposed || client.crashed) return;
      const batch = chunks.slice(offset, offset + EMBEDDING_MAX_BATCH);
      const vectors = await client.embed(batch.map((chunk) => chunk.text), { isQuery: false });
      if (!vectors) return; // embedder unavailable: retried on a later pass
      store.writeEmbeddings(
        batch.map((chunk, index) => ({ chunkId: chunk.id, vector: vectors[index] })),
        model.modelTag,
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

/** Ensure the selected model is downloaded when semantic is enabled. Runs the
 *  download once per model; progress is exposed via getStatus(). */
function ensureModelDownload(context: IpcContext): void {
  if (disposed || !isSemanticEnabled(context)) return;
  const model = selectedModel(context);
  if (isEmbeddingModelPresent(model)) return;
  if (modelDownloadState === 'downloading' && downloadingModelId === model.id) return;
  modelDownloadState = 'downloading';
  downloadingModelId = model.id;
  modelDownloadProgress = 0;
  downloadEmbeddingModel(model, (progress) => {
    modelDownloadProgress = progress.totalBytes > 0 ? progress.downloadedBytes / progress.totalBytes : 0;
  }).then(
    () => {
      modelDownloadState = 'idle';
      modelDownloadProgress = 1;
      // The model just landed - embed the already-indexed chunks now so
      // semantic search lights up without waiting for the next project open.
      const projectId = context.currentProjectId;
      if (projectId) chain(() => embedPass(context, projectId));
    },
    (error) => {
      console.warn('[retrieval] embedding model download failed:', error);
      modelDownloadState = 'error';
    },
  );
}

let embedHealPending = false;

/** Embed any already-indexed-but-unembedded chunks for the current project. This
 *  self-heals the case where semantic was enabled while the model was ALREADY on
 *  disk: the download-complete embed trigger never fires, so existing
 *  conversations would stay indexed-but-unembedded and semantic would find
 *  nothing. Polled from getStatus. embedPass no-ops once everything is embedded;
 *  a single pass runs at a time, and the next poll re-schedules if more remain. */
function scheduleEmbedHeal(context: IpcContext): void {
  if (embedHealPending || disposed) return;
  const projectId = context.currentProjectId;
  if (!projectId) return;
  embedHealPending = true;
  chain(async () => {
    try {
      await embedPass(context, projectId);
    } finally {
      embedHealPending = false;
    }
  });
}

export const retrievalService = {
  /** Subscribe to session lifecycle + turn-boundary events. Idempotent; call
   *  once at startup. */
  attach(context: IpcContext): void {
    if (attached) return;
    attached = true;
    context.sessionManager.on('exit', (sessionId: string) => {
      scheduleFinalizeIndex(context, sessionId);
    });
    context.sessionManager.on('session-changed', (sessionId: string, session: { status: string }) => {
      // Suspend flushes the agent's native history just like a clean exit.
      if (session.status === 'suspended') scheduleFinalizeIndex(context, sessionId);
    });
    context.sessionManager.on('activity', (sessionId: string, activity: ActivityState) => {
      // A turn just completed: the agent produced a message and is now idle
      // (waiting for the user) or paused for permission. Live-index that session
      // so the ongoing conversation is searchable without waiting for it to end.
      if (requiresUserInteraction(activity)) scheduleLiveIndex(context, sessionId);
    });
  },

  /** Run a deferred, project-switch-guarded backfill sweep for a project, then
   *  (when semantic is enabled) ensure the model and embed its chunks. Called on
   *  every PROJECT_OPEN and after a memory-config change. */
  startForProject(context: IpcContext, project: Project): void {
    if (disposed) return;
    this.attach(context);
    activeSweepProjectId = project.id;
    setImmediate(() => {
      if (disposed) return;
      if (context.currentProjectId !== project.id) return;
      if (!isIndexingEnabled(context)) return;

      // Reconcile any vec rows orphaned while the extension was unavailable.
      try {
        const db = getProjectDb(project.id);
        if (hasVecSupport(db)) new RetrievalStore(db).reconcileVecOrphans();
      } catch {
        // sqlite-vec unavailable for this DB; the engine runs lexical-only.
      }

      if (isSemanticEnabled(context)) ensureModelDownload(context);

      chain(async () => {
        await indexer.sweepProject(
          project.id,
          () => !disposed && context.currentProjectId === project.id && activeSweepProjectId === project.id,
        );
        if (isSemanticEnabled(context)) await embedPass(context, project.id);
      });
    });
  },

  /** The embedder for the search path, or null for lexical-only. Consulted by
   *  the search IPC handler / MCP recall tool when the caller asks for semantic
   *  or hybrid results. */
  getEmbedder(context: IpcContext): Embedder | null {
    return resolveEmbedder(context);
  },

  /** Current conversation-memory status for the renderer's Smart-mode UI and
   *  the settings model card. */
  getStatus(context: IpcContext): MemoryStatus {
    const indexingEnabled = isIndexingEnabled(context);
    const semanticOn = isSemanticEnabled(context);
    const model = selectedModel(context);

    // Self-heal: when semantic is enabled but the model isn't present, make sure
    // its download is running. This is what actually kicks the download after
    // the user flips the toggle, since both the Memory tab and the palette poll
    // getStatus. Skipped while already downloading (guarded inside) and after an
    // error (no retry spam - the user re-toggles to retry).
    if (indexingEnabled && semanticOn && !isEmbeddingModelPresent(model) && modelDownloadState !== 'error') {
      ensureModelDownload(context);
    } else if (indexingEnabled && semanticOn && isEmbeddingModelPresent(model) && !embedClient?.crashed) {
      // Model already on disk: self-heal the embeddings too, so enabling semantic
      // (or switching model / acceleration) embeds the already-indexed chunks
      // without waiting for a project re-open or a rebuild.
      scheduleEmbedHeal(context);
    }

    const modelPresent = isEmbeddingModelPresent(model);
    const isDownloadingThis = modelDownloadState === 'downloading' && downloadingModelId === model.id;

    let semantic: MemorySemanticState;
    if (!indexingEnabled || !semanticOn) {
      // Genuinely off: the user has not enabled semantic search.
      semantic = 'disabled';
    } else if (modelDownloadState === 'error') {
      semantic = 'error';
    } else if (isDownloadingThis || !modelPresent) {
      // Enabled, but the model is still downloading / not ready yet.
      semantic = 'downloading';
    } else if (embedClient?.crashed) {
      semantic = 'error';
    } else if (!currentProjectHasVec(context)) {
      semantic = 'lexical';
    } else {
      semantic = 'hybrid';
    }

    let modelState: MemoryModelState;
    if (modelDownloadState === 'error') modelState = 'error';
    else if (modelPresent) modelState = 'ready';
    else if (isDownloadingThis || semanticOn) modelState = 'downloading';
    else modelState = 'absent';

    const showProgress = isDownloadingThis;
    return {
      indexingEnabled,
      semantic,
      activeBackend: humanizeBackend(embedClient?.activeDevice),
      modelProgress: showProgress ? modelDownloadProgress : undefined,
      vecError: semantic === 'lexical' ? lastVecLoadError() ?? undefined : undefined,
      model: {
        id: model.id,
        displayName: model.displayName,
        tier: model.tier,
        approxSizeMb: model.approxSizeMb,
        dimensions: model.dimensions,
        state: modelState,
        progress: showProgress ? modelDownloadProgress : undefined,
      },
    };
  },

  /** Stop the active sweep for a project (or unconditionally with no arg).
   *  The in-flight sweep observes the guard and returns promptly. */
  stop(projectId?: string): void {
    if (projectId != null && projectId !== activeSweepProjectId) return;
    activeSweepProjectId = null;
  },

  /** Clear one project's entire conversation index (Privacy "clear index"). */
  purgeProjectIndex(projectId: string): void {
    try {
      new RetrievalStore(getProjectDb(projectId)).purgeAll();
    } catch (error) {
      console.warn('[retrieval] purge failed:', error);
    }
  },

  /** Non-destructively rebuild a project's index (the Memory settings "Rebuild
   *  index" recovery action). Clears ONLY the per-session index-state signatures -
   *  never the chunks - so the fresh sweep re-indexes every session from its
   *  transcript while keeping the existing chunks as a fallback. A session whose
   *  transcript is gone or unparseable keeps its chunks (indexSession replaces a
   *  session's chunks only on a successful parse), so a rebuild can never drop a
   *  past conversation. The re-sweep and, when semantic is on, the embed pass run
   *  in the background via `startForProject`. */
  rebuildProjectIndex(context: IpcContext, project: Project): void {
    if (disposed) return;
    this.stop(project.id);
    try {
      new RetrievalStore(getProjectDb(project.id)).resetIndexState();
    } catch (error) {
      console.warn('[retrieval] rebuild index-state reset failed:', error);
    }
    this.startForProject(context, project);
  },

  /** Synchronous shutdown: stop scheduling, drop pending timers, kill the embed
   *  worker, mark disposed. In-flight work is abandoned; the next open recovers it. */
  dispose(): void {
    disposed = true;
    activeSweepProjectId = null;
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    for (const timer of liveIndexTimers.values()) clearTimeout(timer);
    liveIndexTimers.clear();
    embedClient?.dispose();
    embedClient = null;
    activeModelId = null;
  },
};
