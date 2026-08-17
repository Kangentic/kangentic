/**
 * Singleton orchestrator for conversation-memory indexing and the semantic
 * layer. Mirrors `prRefreshScheduler`'s lifecycle contract (deferred off the IPC
 * critical path, project-switch guarded, explicitly torn down on
 * switch/delete/shutdown, all timers `.unref()`'d). Owns:
 *  - the live finalize hooks (SessionManager 'exit' + suspended 'session-changed'),
 *  - a live turn-boundary hook (SessionManager 'activity' -> idle/permission) that
 *    re-indexes the active session so an in-progress conversation is searchable,
 *  - the per-open backfill sweep,
 *  - local model-file download orchestration,
 *  - a serial job chain (one indexing job in flight at a time - INDEXING only;
 *    embedding is owned entirely by `embedEngine`, see embedder/embed-engine.ts),
 *  - config gating and synchronous shutdown (also disposes the embed worker,
 *    via embedEngine.dispose()).
 *
 * Indexing (this file) and embedding (embed-engine.ts) are deliberately split:
 * lifecycle/navigation events here only INDEX (a cheap diff-upsert) and flag a
 * project dirty via `embedEngine.markDirty()`. They never embed inline, so a
 * project switch performs zero synchronous embedding work - the felt hardware
 * spike on switching back to a churning project is impossible by construction.
 * The central engine alone drains pending embeddings, duty-cycle throttled.
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
import { embedEngine } from './embedder/embed-engine';
import { resolveEmbeddingModel, type EmbeddingModelDef } from './embedder/embedding-config';
import { isEmbeddingModelPresent, downloadEmbeddingModel } from './embedder/embedding-model';
import { requiresUserInteraction } from '../../shared/activity-state';
import type { IpcContext } from '../ipc/ipc-context';
import type { Embedder } from './types';
import type { MemoryStatus, MemorySemanticState, MemoryModelState, Project, ActivityState } from '../../shared/types';

/** Grace period after a finalize event before indexing, so the agent CLI has
 *  flushed its native history file. */
const FINALIZE_DEBOUNCE_MS = 2000;
/** Grace period after a turn completes (session goes idle / awaits permission)
 *  before a live re-index, so a burst of activity transitions within a turn
 *  coalesces into one index and the CLI has flushed the new turn to disk. */
const LIVE_INDEX_DEBOUNCE_MS = 1500;

const indexer = new ConversationIndexer();

let attached = false;
let disposed = false;
let activeSweepProjectId: string | null = null;
/** Serial job chain: one INDEXING job runs at a time. Embedding is no longer
 *  chained here - it is owned entirely by embedEngine's own drain loop. */
let jobChain: Promise<void> = Promise.resolve();
const pendingTimers = new Set<NodeJS.Timeout>();
/** Per-session trailing-debounce timers for live (turn-boundary) re-indexing. */
const liveIndexTimers = new Map<string, NodeJS.Timeout>();
/** Per-session trailing-debounce timers for finalize (suspend / exit) indexing. */
const finalizeIndexTimers = new Map<string, NodeJS.Timeout>();

// Model-file download state (downloading the local embedding model to disk).
// The embed WORKER and its warm-hold / crash / device state live in
// embedEngine, not here.
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
 * the status reported "unavailable" while the model downloaded fine. embedEngine's
 * drain and query paths already gate on the live `hasVecSupport(db)`; this aligns
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

/** Human-readable name for the execution provider the worker reported ready on. */
function humanizeBackend(device: string | null | undefined): string | undefined {
  switch (device) {
    case 'dml': return 'DirectML (GPU)';
    case 'webgpu': return 'WebGPU (GPU)';
    case 'cpu': return 'CPU';
    default: return device ?? undefined;
  }
}

function chain(job: () => Promise<unknown>): void {
  jobChain = jobChain.then(() => job()).then(
    () => undefined,
    (error) => {
      console.warn('[retrieval] job failed:', error);
    },
  );
}

function scheduleFinalizeIndex(context: IpcContext, sessionId: string): void {
  if (disposed || !isIndexingEnabled(context)) return;
  // Per-session TRAILING debounce, like scheduleLiveIndex below. One suspend
  // now reports twice - once when the status is marked, once after the graceful
  // PTY shutdown, so the UI does not wait seconds to drop the session - and a
  // suspend followed by an exit already reported twice before that. Without a
  // per-session timer each report booked its own indexing pass over the same
  // transcript. Keeping only the LAST one is also the more correct read: the
  // later a finalize runs, the more of the agent's final flush it sees.
  const existing = finalizeIndexTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    pendingTimers.delete(existing);
  }
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    finalizeIndexTimers.delete(sessionId);
    if (disposed || !isIndexingEnabled(context)) return;
    // Transient (command-terminal) sessions have no DB row; skip them.
    if (context.sessionManager.getSession(sessionId)?.transient) return;
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!projectId) return;
    chain(async () => {
      await indexer.indexSession(projectId, sessionId);
      // Flag the project dirty; embedEngine's own drain loop embeds the
      // freshly indexed chunks in the background, duty-cycle throttled. This
      // does NOT embed inline - that is the whole point of the split.
      embedEngine.markDirty(projectId);
    });
  }, FINALIZE_DEBOUNCE_MS);
  timer.unref();
  pendingTimers.add(timer);
  finalizeIndexTimers.set(sessionId, timer);
}

/**
 * Debounced live re-index at a turn boundary. Fired when a session transitions
 * to "requires user interaction" (idle / permission) - i.e. the agent finished a
 * message and paused - so the current conversation becomes searchable within
 * ~1.5s instead of only after the session finalizes. This is a per-session
 * TRAILING debounce: rapid transitions within one turn reset the timer, so an
 * active session is indexed once per settled turn, never per event. It stays
 * cheap because `indexSession` diff-upserts (an unchanged transcript is a
 * no-op) and embedding the new chunks happens later, in the background, via
 * embedEngine's own duty-cycle-throttled drain loop - never inline here.
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
      embedEngine.markDirty(projectId);
    });
  }, LIVE_INDEX_DEBOUNCE_MS);
  timer.unref();
  liveIndexTimers.set(sessionId, timer);
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
      // The model just landed - flag the current project dirty so embedEngine's
      // background drain embeds the already-indexed chunks without waiting for
      // the next project open. This is a markDirty, not an inline embed: the
      // drain is duty-cycle throttled, so even this one-time backfill is paced.
      const projectId = context.currentProjectId;
      if (projectId) embedEngine.markDirty(projectId);
    },
    (error) => {
      console.warn('[retrieval] embedding model download failed:', error);
      modelDownloadState = 'error';
    },
  );
}

export const retrievalService = {
  /** Subscribe to session lifecycle + turn-boundary events, and start the
   *  central embedding engine's drain loop. Idempotent; call once at startup. */
  attach(context: IpcContext): void {
    embedEngine.attach(context);
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
   *  flag it dirty so embedEngine's background drain embeds its chunks. Called
   *  on every PROJECT_OPEN and after a memory-config change. Never embeds
   *  inline - a project open performs zero synchronous embedding work. */
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
        // Covers project open, the startup backlog, AND crash-resume: the
        // sweep re-indexed whatever changed, and this flags it for the
        // background drain regardless of whether anything actually changed
        // (markDirty is cheap and idempotent).
        embedEngine.markDirty(project.id);
      });
    });
  },

  /** The embedder for the search path, or null for lexical-only. Consulted by
   *  the search IPC handler / MCP recall tool when the caller asks for semantic
   *  or hybrid results. Interactive queries through this path always preempt
   *  the background drain in the shared worker. */
  getEmbedder(context: IpcContext): Embedder | null {
    return embedEngine.getEmbedder(context);
  },

  /** Re-evaluate the embed-worker warm-hold, and (when semantic just became
   *  viable) flag the current project dirty. Call after a change to
   *  `memory.semanticEnabled`/model/acceleration or to the current project
   *  (open/close), since those paths have no embed() call of their own to
   *  piggyback the gate on. */
  reconcileEmbedWorker(context: IpcContext): void {
    embedEngine.reconcile(context);
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
    } else if (indexingEnabled && semanticOn && isEmbeddingModelPresent(model) && !embedEngine.workerCrashed) {
      // Model already on disk: flag the current project dirty too, so enabling
      // semantic (or switching model / acceleration) drains the already-indexed
      // chunks in the background without waiting for a project re-open or a
      // rebuild. Cheap and idempotent - the engine self-clears a project from
      // its dirty set once nothing remains, so this is a no-op safety net once
      // caught up, continuously re-armed by every getStatus poll.
      const projectId = context.currentProjectId;
      if (projectId) embedEngine.markDirty(projectId);
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
    } else if (embedEngine.workerCrashed) {
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
      activeBackend: humanizeBackend(embedEngine.activeDevice),
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
   *  past conversation. The re-sweep runs via `startForProject`, which flags the
   *  project dirty so embedEngine's background drain embeds it afterward. */
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

  /** Synchronous shutdown: stop scheduling, drop pending timers, dispose the
   *  embedding engine (which synchronously kills the embed worker), mark
   *  disposed. In-flight work is abandoned; the next open recovers it. */
  dispose(): void {
    disposed = true;
    activeSweepProjectId = null;
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    for (const timer of liveIndexTimers.values()) clearTimeout(timer);
    liveIndexTimers.clear();
    for (const timer of finalizeIndexTimers.values()) clearTimeout(timer);
    finalizeIndexTimers.clear();
    embedEngine.dispose();
  },
};
