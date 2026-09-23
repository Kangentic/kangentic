import { EventEmitter } from 'events';
import type {
  DictationConfig,
  DictationHardwareProfile,
  DictationInfo,
  DictationModelProgress,
  DictationStartOptions,
  DictationStartResult,
} from '../../shared/types';
import { detectHardware, selectTier } from './hardware/detect-hardware';
import { computeEngineKey, selectEngine, type EngineSelection } from './engines/engine-selection';
import { ensureModel, isModelInstalled, listInstalledModels } from './models/model-manager';
import type { ModelDef } from './models/model-registry';
import { buildDictationInfo, primaryModel } from './dictation-info';
import { trackFeatureUsed } from '../analytics/usage';
import type { ResolvedModel } from './engines/transcription-engine';
import { DictationClient, dictationClient } from './dictation-client';

interface ActiveDictation {
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

interface PreparedModels {
  resolved: ResolvedModel[];
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
 * The engine itself - sherpa-onnx-node, whose native module a C++ throw
 * inside can crash whatever process it runs in (DESKTOP-X) - runs in the
 * `kangentic-dictation` utilityProcess worker, never here. This service owns
 * only session bookkeeping (the active map, the frame-drain barrier) and
 * model download; `DictationClient` (dictation-client.ts) is the boundary to
 * the worker, and the warm-engine LRU that used to live on this class now
 * lives worker-side (dictation-worker.ts), since only the worker ever holds
 * a real engine object. See engines/transcription-engine.ts for the
 * engine-selection/engine-build split and .claude/rules/dictation-out-of-process.md.
 *
 * Engines are kept WARM (in the worker), but only as far as they are cheap.
 * The renderer pre-warms the selected engine the moment dictation is enabled
 * (and on every model change), which loads the small streaming live model so
 * the first press streams partials at once. The 631 MB accurate model loads
 * on the first press itself, overlapped with the utterance (see
 * engines/hybrid-engine.ts), and is then REUSED across presses - until the
 * worker has gone IDLE_SHUTDOWN_MS without a request, when DictationClient
 * recycles it (a process exit is the only thing that gives onnxruntime's
 * reservation back) and this service warms a fresh live-only one. So a user
 * who dictated once this morning pays for the live model for the rest of the
 * day, not for the accurate one. Turning dictation off releases the worker
 * outright.
 */
export class TranscriptionService extends EventEmitter {
  private readonly active = new Map<string, ActiveDictation>();
  /** The config of the last `prewarm(config)`, so a recycled worker can be
   *  warmed straight back to the live-only baseline. Null once dictation is
   *  turned off (or this service is disposed), so a late recycle warms nothing. */
  private warmConfig: DictationConfig | null = null;
  /** Bumped by every `prewarm()` call (null included) and `dispose()`. A
   *  prewarm that finds itself stale after its awaits stops before touching
   *  the worker: a disable landing mid-warm must not spawn a worker after the
   *  user turned dictation off, and a superseded config must not load a
   *  second engine. It also decides whose failure is worth reporting. */
  private prewarmGeneration = 0;
  // In-flight main-side prep (model download, keyed by engineKey) so a
  // prewarm racing the first press (or two near-simultaneous presses) share
  // one download instead of double-fetching the same model file. The
  // worker's own warm/warming maps separately dedupe the ENGINE LOAD half of
  // this; this one exists because the download half has no protection of
  // its own once it moved out of the single main-side buildAndLoad it used
  // to share with the load.
  private readonly warming = new Map<string, Promise<PreparedModels>>();
  private counter = 0;

  constructor(private readonly client: DictationClient = dictationClient) {
    super();
    this.client.on('partial', (dictationSessionId: string, text: string) => {
      if (this.active.has(dictationSessionId)) {
        this.emit('partial', dictationSessionId, text);
      }
    });
    // An idle recycle killed a worker that held the accurate model; bring the
    // baseline back so the next press still streams partials instantly.
    // Silent: a failure here would toast half an hour after the last press,
    // out of any context, and the next press reports its own failure anyway.
    this.client.on('recycled', () => {
      if (this.warmConfig) void this.prewarm(this.warmConfig, { silent: true });
    });
  }

  /**
   * Begin a dictation session. Reuses a warm engine when the resolved engine +
   * model selection matches (instant), else loads it (and downloads the model
   * if missing, surfacing progress in the popup).
   */
  async start(options: DictationStartOptions): Promise<DictationStartResult> {
    const config = normalizeConfig(options);
    const profile = await detectHardware();
    const selected = selectEngine(profile, config);
    const engineKey = computeEngineKey(selected, config);

    let prepared: PreparedModels;
    try {
      prepared = await this.prepareModels(selected, engineKey);
    } catch (error) {
      throw this.reportPrepareFailure(selected, error);
    }

    const dictationSessionId = `dictation-${++this.counter}`;
    this.active.set(dictationSessionId, { frameCount: 0 });
    try {
      await this.client.createSession({
        dictationSessionId,
        engineKey,
        selection: selected,
        models: prepared.resolved,
        remote: config.remote,
        warmCap: this.warmCap(profile),
        sessionOptions: { language: config.language ?? 'en', punctuation: config.punctuation ?? true },
      });
    } catch (error) {
      this.active.delete(dictationSessionId);
      // A REJECT here does not prove the worker never created the session -
      // a timeout means the client gave up while the worker was still
      // building/loading, and that createSession may still land and
      // active.set() a live session in the worker nobody will ever
      // finalize/cancel. cancel() is a safe no-op everywhere else (crash: no
      // child to send to; a worker-reported error: never got as far as
      // active.set), so send it unconditionally rather than only in the
      // timeout case.
      this.client.cancel(dictationSessionId);
      throw this.reportPrepareFailure(selected, error);
    }

    return {
      dictationSessionId,
      engineId: selected.id,
      modelId: primaryModel(selected.models)?.id ?? null,
      needsDownload: prepared.needsDownload,
    };
  }

  /**
   * Pre-load the live engine for the given config so the next press streams
   * partials at once (the accurate model waits for the press itself). A
   * best-effort background call (errors are swallowed; a download still
   * surfaces via the popup's model-progress phase, unless `silent`). Passing
   * `null` (dictation was disabled) releases the worker outright.
   */
  async prewarm(config: DictationConfig | null, options?: { silent?: boolean }): Promise<void> {
    const generation = ++this.prewarmGeneration;
    if (!config) {
      this.warmConfig = null;
      for (const dictationSessionId of [...this.active.keys()]) {
        this.cancel(dictationSessionId);
      }
      this.client.release();
      return;
    }
    this.warmConfig = config;
    let selected: EngineSelection | undefined;
    try {
      const profile = await detectHardware();
      selected = selectEngine(profile, config);
      const engineKey = computeEngineKey(selected, config);
      const prepared = await this.prepareModels(selected, engineKey);
      // Superseded during the awaits: by a disable (the worker must stay
      // dead) or by a newer config (whose own prewarm carries the load).
      if (generation !== this.prewarmGeneration) return;
      await this.client.ensureWarm({
        engineKey,
        selection: selected,
        models: prepared.resolved,
        remote: config.remote,
        warmCap: this.warmCap(profile),
      });
    } catch (error) {
      // Best-effort: a failed prewarm just means the first press pays the
      // load, but still surface it via the popup's model-progress phase when
      // we got far enough to know which model to blame (mirrors the
      // pre-split buildAndLoad, whose failure reporting fired the same way
      // whether the caller was start() or prewarm()). Not when this prewarm
      // was superseded - a release() rejects the request it was waiting on,
      // and that is the user turning dictation off, not a failure.
      if (selected && generation === this.prewarmGeneration && !options?.silent) {
        this.reportPrepareFailure(selected, error);
      }
    }
  }

  /**
   * Download (if missing) every model the selection needs and resolve their
   * on-disk paths, deduped by engineKey. Does NOT touch the worker - the
   * caller sends the result on to createSession/ensureWarm for that half.
   */
  private async prepareModels(selected: EngineSelection, engineKey: string): Promise<PreparedModels> {
    const pending = this.warming.get(engineKey);
    if (pending) return pending;

    const needsDownload = selected.models.some((model) => !isModelInstalled(model));
    const promise = this.downloadAndResolve(selected, needsDownload);
    this.warming.set(engineKey, promise);
    try {
      return await promise;
    } finally {
      this.warming.delete(engineKey);
    }
  }

  private async downloadAndResolve(selected: EngineSelection, needsDownload: boolean): Promise<PreparedModels> {
    const resolved = await this.ensureModels(selected.models, selected.id);
    if (needsDownload && selected.models.length > 0) {
      const totalBytes = totalModelBytes(selected.models);
      this.emitModelProgress({ modelId: selected.models[0].id, status: 'done', downloadedBytes: totalBytes, totalBytes });
    }
    return { resolved, needsDownload };
  }

  /** Emit a model-progress 'error' (if there is a model to name) and return
   *  the Error to throw. Shared by a failed download and a failed worker
   *  load - both dead-end the same way from the caller's perspective. */
  private reportPrepareFailure(selected: EngineSelection, error: unknown): Error {
    const message = error instanceof Error ? error.message : 'Failed to prepare the dictation engine';
    if (selected.models.length > 0) {
      this.emitModelProgress({ modelId: selected.models[0].id, status: 'error', downloadedBytes: 0, totalBytes: 0, error: message });
    }
    return new Error(message);
  }

  /**
   * Warm-engine cap: 2 on the accurate tier (hold the previously-used model so
   * an A/B switch back to it is instant), 1 on the low-resource tier (do not pin
   * two large models on a weak machine). Computed here (the profile comes from
   * detectHardware, which needs the `app` module) and passed to the worker
   * rather than re-derived there.
   */
  private warmCap(profile: DictationHardwareProfile): number {
    return selectTier(profile) === 'streaming-tiny' ? 1 : 2;
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
      throw new Error(message, { cause: error });
    }
  }

  /**
   * Feed one PCM frame (16 kHz mono Int16) into the active session. This is
   * the transport-agnostic ingest boundary (local IPC today, a future
   * remote client later). Unknown ids are ignored (a late frame after stop).
   * Fire-and-forget to the worker, mirroring the original direct
   * `session.push()` call - see dictation-client.ts's push() for the
   * ordering argument that keeps this safe against the finalize drain.
   */
  ingest(dictationSessionId: string, pcm: Int16Array): void {
    const entry = this.active.get(dictationSessionId);
    if (!entry) return;
    this.client.push(dictationSessionId, pcm);
    entry.frameCount += 1;
    entry.onFrame?.();
  }

  /** Flush the session and return the finalized, committed text. The engine
   *  itself stays warm in the worker for the next press; only the session
   *  is disposed there.
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
    let text: string;
    try {
      text = await this.client.finalize(dictationSessionId);
    } catch (error) {
      // A worker CRASH or a worker-REPORTED error already cleans up the
      // worker-side session as part of that failure. A request TIMEOUT does
      // not - the worker may still be decoding - so cancel() is sent
      // unconditionally rather than only on that one path; it is a safe
      // no-op wherever the worker has already forgotten this session.
      this.client.cancel(dictationSessionId);
      throw error;
    } finally {
      entry.onFrame = undefined;
      this.active.delete(dictationSessionId);
    }
    this.emit('final', dictationSessionId, text);
    // Adoption signal for a completed utterance; the two early returns above
    // (no session, cancelled mid-drain) never count. Main dedups to once per
    // day.
    trackFeatureUsed('dictation');
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
    this.client.cancel(dictationSessionId);
    this.active.delete(dictationSessionId);
  }

  /** Hardware profile + available engines for the settings panel. */
  async getInfo(config: DictationConfig): Promise<DictationInfo> {
    return {
      ...buildDictationInfo(await detectHardware(), config, listInstalledModels()),
      // The dictation worker gave up after repeated crashes: name why, so the
      // settings panel can say so instead of leaving push-to-talk a silent
      // dead end. Mirrors EmbedClient.crashReason surfaced in the Memory tab.
      workerUnavailable: this.client.crashed,
      workerError: this.client.crashReason ?? undefined,
    };
  }

  /** Release in-flight sessions and the worker (synchronous-shutdown safe). */
  dispose(): void {
    this.warmConfig = null;
    this.prewarmGeneration += 1;
    for (const dictationSessionId of [...this.active.keys()]) {
      this.cancel(dictationSessionId);
    }
    this.client.dispose();
  }
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
