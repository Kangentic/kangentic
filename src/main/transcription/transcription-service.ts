import { EventEmitter } from 'events';
import type {
  DictationConfig,
  DictationHardwareProfile,
  DictationInfo,
  DictationModelOption,
  DictationModelProgress,
  DictationStartOptions,
  DictationStartResult,
} from '../../shared/types';
import { detectHardware, selectTier } from './hardware/detect-hardware';
import { listEngineInfos, selectEngine, type SelectedEngine } from './engines/engine-registry';
import { ensureModel, isModelInstalled, listInstalledModels } from './models/model-manager';
import { finalCapableModels, isOfflineModel, liveCapableModels, modelLanguages, type ModelDef } from './models/model-registry';
import type {
  ResolvedModel,
  TranscriptionEngine,
  TranscriptionEngineSession,
} from './engines/transcription-engine';

interface ActiveDictation {
  engine: TranscriptionEngine;
  session: TranscriptionEngineSession;
  /** How many PCM frames this session has ingested so far. The finalize drain
   *  barrier waits for this to reach the renderer's sent-frame count. */
  frameCount: number;
  /** Set by finalize while it waits for the last frames; ingest pokes it. */
  onFrame?: () => void;
}

/** Upper bound on the finalize drain wait. A frame that never arrives (genuine
 *  loss) must not hang the decode, so the barrier resolves after this regardless.
 *  In the normal case the frames are already in and the barrier is a no-op. */
const FRAME_DRAIN_TIMEOUT_MS = 500;

interface PendingBuild {
  promise: Promise<TranscriptionEngine>;
  needsDownload: boolean;
}

/**
 * The single transcription funnel and choke point. The renderer's local PCM
 * stream and a future mobile/network source both reach the active engine
 * through `ingest(dictationSessionId, pcm)` - the transport-agnostic boundary.
 * Emits `'partial'` (revising hypothesis) and `'final'` (committed text)
 * events, which the IPC handler forwards to the renderer popup. The handler
 * then writes only the finalized text into the focused PTY.
 *
 * Engines are kept WARM. Loading a model is expensive (the 631 MB Parakeet ONNX
 * takes seconds), so an engine is loaded once and REUSED across push-to-talk
 * sessions - a press starts instantly instead of paying the load. A small LRU
 * of warm engines, keyed by the resolved engine + model selection, keeps the
 * most-recently-used few around so A/B-switching back to a recently-used model
 * is instant too. The renderer pre-warms the selected engine the moment
 * dictation is enabled (and on every model change), so even the first press is
 * instant.
 */
export class TranscriptionService extends EventEmitter {
  private readonly active = new Map<string, ActiveDictation>();
  // LRU of warm (loaded) engines keyed by engineKey(); Map insertion order is
  // the LRU order (oldest first). A cache hit re-inserts to mark it MRU.
  private readonly warm = new Map<string, TranscriptionEngine>();
  // In-flight loads keyed by engineKey, so a prewarm racing the first press (or
  // two near-simultaneous presses) share one load instead of double-loading.
  private readonly warming = new Map<string, PendingBuild>();
  // Bumped by disposeWarm() so a load that completes after a disable/teardown is
  // discarded instead of cached (the in-flight build observes the change).
  private warmGeneration = 0;
  private counter = 0;

  /**
   * Begin a dictation session. Reuses a warm engine when the resolved engine +
   * model selection matches (instant), else loads it (and downloads the model
   * if missing, surfacing progress in the popup).
   */
  async start(options: DictationStartOptions): Promise<DictationStartResult> {
    const config = normalizeConfig(options);
    let prepared: { engine: TranscriptionEngine; selected: SelectedEngine; needsDownload: boolean };
    try {
      prepared = await this.ensureEngine(config);
    } catch (error) {
      throw error instanceof Error ? error : new Error('Failed to prepare the dictation engine');
    }
    const { engine, selected, needsDownload } = prepared;

    const dictationSessionId = `dictation-${++this.counter}`;
    const session = engine.createSession({
      sampleRate: 16000,
      language: config.language ?? 'en',
      punctuation: config.punctuation ?? true,
      onPartial: (text: string) => {
        if (this.active.has(dictationSessionId)) {
          this.emit('partial', dictationSessionId, text);
        }
      },
    });
    this.active.set(dictationSessionId, { engine, session, frameCount: 0 });

    return {
      dictationSessionId,
      engineId: selected.id,
      modelId: primaryModel(selected.models)?.id ?? null,
      needsDownload,
    };
  }

  /**
   * Pre-load the engine for the given config so the next press is instant. A
   * best-effort background call (errors are swallowed; a download still surfaces
   * via the popup's model-progress phase). Passing `null` releases every warm
   * engine (dictation was disabled).
   */
  async prewarm(config: DictationConfig | null): Promise<void> {
    if (!config) {
      this.disposeWarm();
      return;
    }
    try {
      await this.ensureEngine(config);
    } catch {
      // Best-effort: a failed prewarm just means the first press pays the load.
    }
  }

  /**
   * Resolve a loaded engine for the config, reusing a warm one when the resolved
   * engine + model selection matches. Model-agnostic: the key covers the engine
   * id, every selected model id, and the remote endpoint, so every model
   * (Parakeet, any Whisper size, streaming-only, cloud) warms identically.
   */
  private async ensureEngine(
    config: DictationConfig,
  ): Promise<{ engine: TranscriptionEngine; selected: SelectedEngine; needsDownload: boolean }> {
    const profile = await detectHardware();
    const selected = selectEngine(profile, config);
    const key = this.engineKey(selected, config);

    const cached = this.warm.get(key);
    if (cached) {
      this.warm.delete(key);
      this.warm.set(key, cached); // move to MRU
      return { engine: cached, selected, needsDownload: false };
    }

    const pending = this.warming.get(key);
    if (pending) {
      const engine = await pending.promise;
      return { engine, selected, needsDownload: pending.needsDownload };
    }

    const generation = this.warmGeneration;
    const needsDownload = selected.models.some((model) => !isModelInstalled(model));
    const promise = this.buildAndLoad(selected, config);
    this.warming.set(key, { promise, needsDownload });
    let engine: TranscriptionEngine;
    try {
      engine = await promise;
    } finally {
      this.warming.delete(key);
    }

    if (generation !== this.warmGeneration) {
      // disposeWarm() ran during the load (e.g. dictation disabled). Do not
      // cache; a caller's session, if any, keeps it alive until finalize.
      this.maybeDisposeEngine(engine);
      return { engine, selected, needsDownload };
    }
    this.warm.set(key, engine);
    this.evictWarm(this.warmCap(profile));
    return { engine, selected, needsDownload };
  }

  /** Build + load an engine for the selection, emitting download progress. */
  private async buildAndLoad(selected: SelectedEngine, config: DictationConfig): Promise<TranscriptionEngine> {
    const needsDownload = selected.models.some((model) => !isModelInstalled(model));
    const engine = selected.build(config);
    try {
      const resolved = await this.ensureModels(selected.models, selected.id);
      if (needsDownload && selected.models.length > 0) {
        const totalBytes = totalModelBytes(selected.models);
        this.emitModelProgress({ modelId: selected.models[0].id, status: 'done', downloadedBytes: totalBytes, totalBytes });
      }
      await engine.load(resolved);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to prepare the dictation engine';
      if (selected.models.length > 0) {
        this.emitModelProgress({ modelId: selected.models[0].id, status: 'error', downloadedBytes: 0, totalBytes: 0, error: message });
      }
      void engine.dispose();
      throw new Error(message);
    }
    return engine;
  }

  /**
   * A stable cache key for the resolved engine + model + remote selection. No
   * engine-name branching (the remote fields are simply empty for on-device), so
   * the boundary that keeps engine-id mapping in engine-registry stays intact.
   */
  private engineKey(selected: SelectedEngine, config: DictationConfig): string {
    return [
      selected.id,
      // Both slots, not the deduped model set: live=Parakeet/final=none and
      // live=none/final=Parakeet share one model id but are different engines.
      selected.liveModelId ?? 'none',
      selected.finalModelId ?? 'none',
      // The Whisper recognizer bakes the language in at creation, so each language
      // is a distinct warm engine (the model files are shared/cached on disk).
      selected.language,
      config.remote?.url ?? '',
      config.remote?.apiKey ?? '',
      config.remote?.model ?? '',
    ].join('|');
  }

  /**
   * Warm-engine cap: 2 on the accurate tier (hold the previously-used model so
   * an A/B switch back to it is instant), 1 on the low-resource tier (do not pin
   * two large models on a weak machine).
   */
  private warmCap(profile: DictationHardwareProfile): number {
    return selectTier(profile) === 'streaming-tiny' ? 1 : 2;
  }

  /** Drop least-recently-used warm engines beyond the cap, disposing any that
   *  are idle (an evicted engine still serving a session is disposed on finalize). */
  private evictWarm(cap: number): void {
    while (this.warm.size > cap) {
      const oldestKey = this.warm.keys().next().value as string;
      const engine = this.warm.get(oldestKey);
      this.warm.delete(oldestKey);
      if (engine) this.maybeDisposeEngine(engine);
    }
  }

  /** Dispose an engine only when it is neither warm-cached nor serving a session. */
  private maybeDisposeEngine(engine: TranscriptionEngine): void {
    for (const warmEngine of this.warm.values()) if (warmEngine === engine) return;
    for (const entry of this.active.values()) if (entry.engine === engine) return;
    void engine.dispose();
  }

  /**
   * Release every warm engine (dictation disabled, or shutdown). Synchronous-
   * shutdown safe: the async `engine.dispose()` is fired without awaiting, and
   * the generation bump discards any load still in flight.
   */
  private disposeWarm(): void {
    this.warmGeneration += 1; // supersede any in-flight load so it is not cached
    const engines = [...this.warm.values()];
    this.warm.clear();
    this.warming.clear();
    for (const engine of engines) this.maybeDisposeEngine(engine);
  }

  private emitModelProgress(progress: DictationModelProgress): void {
    this.emit('model-progress', progress);
  }

  /**
   * Download (if missing) and resolve every model in the set, emitting a single
   * aggregate progress bar across the whole set (the hybrid pulls two models).
   */
  private async ensureModels(models: ModelDef[], engineId: string): Promise<ResolvedModel[]> {
    const resolved: ResolvedModel[] = [];
    const totalBytes = totalModelBytes(models);
    let priorBytes = 0;
    // Throttle: the file download fires onProgress per network chunk (~11k times
    // for a 730 MB model). Emit at most every 150 ms so the popup bar animates
    // smoothly without flooding IPC, but always emit the final byte so it hits 100%.
    let lastEmitMs = 0;
    for (const model of models) {
      const resolvedPaths = await ensureModel(model, (progress) => {
        const downloadedBytes = priorBytes + progress.downloadedBytes;
        const now = Date.now();
        if (now - lastEmitMs < 150 && downloadedBytes < totalBytes) return;
        lastEmitMs = now;
        this.emitModelProgress({ modelId: model.id, status: 'downloading', downloadedBytes, totalBytes });
      });
      priorBytes += Math.round(model.approxSizeMb * 1024 * 1024);
      resolved.push({ id: model.id, engineId, kind: resolvedPaths.kind, paths: resolvedPaths.paths });
    }
    return resolved;
  }

  /**
   * Pre-download the model for the given config (the settings "Download" button),
   * emitting progress. Resolves when the model is present; a no-op for the
   * remote/stub engines that carry no model.
   */
  async downloadModel(config: DictationConfig): Promise<void> {
    const profile = await detectHardware();
    const selected = selectEngine(profile, config);
    if (selected.models.length === 0) return;
    try {
      await this.ensureModels(selected.models, selected.id);
      const totalBytes = totalModelBytes(selected.models);
      this.emitModelProgress({ modelId: selected.models[0].id, status: 'done', downloadedBytes: totalBytes, totalBytes });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model download failed';
      this.emitModelProgress({ modelId: selected.models[0].id, status: 'error', downloadedBytes: 0, totalBytes: 0, error: message });
      throw new Error(message);
    }
  }

  /**
   * Feed one PCM frame (16 kHz mono Int16) into the active engine session.
   * This is the transport-agnostic ingest boundary (local IPC today, a future
   * remote client later). Unknown ids are ignored (a late frame after stop).
   */
  ingest(dictationSessionId: string, pcm: Int16Array): void {
    const entry = this.active.get(dictationSessionId);
    if (!entry) return;
    entry.session.push(pcm);
    entry.frameCount += 1;
    entry.onFrame?.();
  }

  /** Flush the engine session and return the finalized, committed text. The
   *  engine itself stays warm for the next press; only the session is disposed.
   *
   *  Drain barrier: PCM frames arrive over a fire-and-forget channel while this
   *  `stop` arrives over a separate invoke channel, so the last few frames can
   *  still be in flight when finalize runs. When the renderer reports how many
   *  frames it sent (`expectedFrames`), wait (bounded) until they have all been
   *  ingested before decoding, so the refinement always sees the COMPLETE
   *  utterance and the tail is never cut off. */
  async finalize(dictationSessionId: string, expectedFrames?: number): Promise<string> {
    const entry = this.active.get(dictationSessionId);
    if (!entry) return '';
    if (typeof expectedFrames === 'number' && expectedFrames > 0) {
      await this.waitForFrames(entry, expectedFrames, FRAME_DRAIN_TIMEOUT_MS);
      // A concurrent cancel() during the drain wait disposes this session and
      // removes it from `active`. Bail rather than finalize a disposed session
      // (which would double-dispose and emit a spurious empty 'final').
      if (!this.active.has(dictationSessionId)) return '';
    }
    let text = '';
    try {
      text = await entry.session.finalize();
    } finally {
      entry.onFrame = undefined;
      entry.session.dispose();
      this.active.delete(dictationSessionId);
      this.maybeDisposeEngine(entry.engine);
    }
    this.emit('final', dictationSessionId, text);
    return text;
  }

  /** Resolve once the session has ingested `expectedFrames` frames, or after
   *  `timeoutMs` (a lost frame must never hang finalize). Event-driven via
   *  `entry.onFrame`, so it resolves the instant the final frame lands. */
  private waitForFrames(
    entry: ActiveDictation,
    expectedFrames: number,
    timeoutMs: number,
  ): Promise<void> {
    if (entry.frameCount >= expectedFrames) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        entry.onFrame = undefined;
        resolve();
      };
      entry.onFrame = () => {
        if (entry.frameCount >= expectedFrames) finish();
      };
      // Safety net: a genuinely lost frame must not hang finalize. The timer is
      // idempotent with the frame-count path, so whichever fires first wins.
      setTimeout(finish, timeoutMs);
    });
  }

  /** Abort a dictation session without committing any text (engine stays warm). */
  cancel(dictationSessionId: string): void {
    const entry = this.active.get(dictationSessionId);
    if (!entry) return;
    entry.session.cancel();
    entry.session.dispose();
    this.active.delete(dictationSessionId);
    this.maybeDisposeEngine(entry.engine);
  }

  /** Hardware profile + available engines for the settings panel. */
  async getInfo(config: DictationConfig): Promise<DictationInfo> {
    const profile = await detectHardware();
    const selected = selectEngine(profile, config);
    // For the on-device hybrid the set is [streaming Zipformer, accurate model];
    // the accurate model is the one the user picks, so surface it (not models[0],
    // which is the always-present live model). Streaming-only / cloud have no
    // offline model and fall back to the first (the Zipformer live model).
    const primary = primaryModel(selected.models);
    const finals = finalCapableModels().map(toModelOption);
    return {
      hardware: profile,
      tier: selectTier(profile),
      selectedEngineId: selected.id,
      engines: listEngineInfos(),
      installedModels: listInstalledModels(),
      selectedModelId: primary?.id ?? null,
      selectedModelSizeMb: selected.models.length > 0
        ? selected.models.reduce((sum, model) => sum + model.approxSizeMb, 0)
        : null,
      availableModels: finals,
      liveModels: liveCapableModels().map(toModelOption),
      finalModels: finals,
      selectedLiveModelId: selected.liveModelId,
      selectedFinalModelId: selected.finalModelId,
    };
  }

  /** Release in-flight sessions and warm engines (synchronous-shutdown safe). */
  dispose(): void {
    for (const dictationSessionId of [...this.active.keys()]) {
      this.cancel(dictationSessionId);
    }
    this.disposeWarm();
  }
}

/** The accurate (offline) model when present, else the first model in the set
 *  (the streaming Zipformer for streaming-only / cloud). The user-meaningful one. */
function primaryModel(models: ModelDef[]): ModelDef | undefined {
  return models.find(isOfflineModel) ?? models[0];
}

function toModelOption(model: ModelDef): DictationModelOption {
  return {
    id: model.id,
    displayName: model.displayName,
    sizeMb: model.approxSizeMb,
    engineKind: model.engineKind,
    languages: modelLanguages(model),
  };
}

function normalizeConfig(options: DictationStartOptions): DictationConfig {
  return {
    enabled: true,
    engineMode: options.engineMode,
    modelId: options.modelId ?? null,
    liveModelId: options.liveModelId ?? null,
    punctuation: options.punctuation,
    language: options.language,
  };
}

/** Aggregate approximate download size of a model set, in bytes (floored at 1). */
function totalModelBytes(models: ModelDef[]): number {
  return Math.max(1, Math.round(models.reduce((sum, model) => sum + model.approxSizeMb, 0) * 1024 * 1024));
}
