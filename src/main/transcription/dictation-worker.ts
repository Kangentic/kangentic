/**
 * Dictation worker - runs sherpa-onnx-node inference in an Electron
 * utilityProcess child, isolated from the main process so a native C++
 * throw inside the recognizer can never take down `CrBrowserMain`.
 *
 * DESKTOP-X: the crash this exists to contain was not a fault during normal
 * decode - it was a napi async-work completion callback (queued by
 * `OfflineRecognizer.createAsync` / `decodeAsync`) running during Node
 * environment teardown at app quit, inside sherpa-onnx.node, with nothing
 * between it and the CRT to catch the resulting C++ throw. Moving the whole
 * engine layer here means that throw now takes down this worker, which
 * `DictationClient`'s restart policy already knows how to recover from -
 * never the main process, and every PTY/session it owns.
 *
 * Owns the warm-engine LRU and the active-session map that used to live in
 * `TranscriptionService`; main only tracks session ids, downloads models,
 * and forwards audio - see `dictation-client.ts` for its side of the wire
 * protocol below and `engines/transcription-engine.ts` for the
 * engine-selection/engine-build split this worker sits on top of.
 *
 * Bundled by esbuild as its own entry (`.vite/build/dictation-worker.js`),
 * with `sherpa-onnx-node` external and asarUnpacked (electron-builder.yml)
 * so the native addon resolves to a real on-disk path when packaged.
 */

import type { DictationRemoteEndpoint } from '../../shared/types';
import { buildEngine } from './engines/engine-build';
import type { EngineSelection } from './engines/engine-selection';
import type { ResolvedModel, TranscriptionEngine, TranscriptionEngineSession } from './engines/transcription-engine';

/**
 * The wire protocol, exported so `dictation-client.ts` can `import type` it
 * rather than hand-typing a second copy of each shape - the two used to
 * agree only by construction, which meant a renamed/dropped field would
 * compile and pass every test while silently dropping the request on the
 * floor. Mirrors `line-count-client.ts`'s `import type { LineCountEntry }
 * from './line-count-worker'` convention.
 */

export interface EnsureEngineRequest {
  engineKey: string;
  selection: EngineSelection;
  models: ResolvedModel[];
  remote?: DictationRemoteEndpoint;
  /** Warm-engine cap for this request's hardware tier - computed main-side
   *  (detectHardware/selectTier need the `app` module, which this worker
   *  does not have) and passed through rather than re-derived here. */
  warmCap: number;
}
export interface CreateSessionMessage extends EnsureEngineRequest {
  type: 'createSession';
  id: number;
  dictationSessionId: string;
  sessionOptions: { language: string; punctuation: boolean };
}
export interface PushMessage {
  type: 'push';
  dictationSessionId: string;
  pcm: ArrayBuffer;
}
export interface FinalizeMessage {
  type: 'finalize';
  id: number;
  dictationSessionId: string;
}
export interface CancelMessage {
  type: 'cancel';
  dictationSessionId: string;
}
export interface PrewarmMessage extends EnsureEngineRequest {
  type: 'prewarm';
  id: number;
}
export interface DisposeWarmMessage {
  type: 'disposeWarm';
}
export interface ShutdownMessage {
  type: 'shutdown';
}
/** Every message main may send to this worker. */
export type WorkerRequest =
  | CreateSessionMessage
  | PushMessage
  | FinalizeMessage
  | CancelMessage
  | PrewarmMessage
  | DisposeWarmMessage
  | ShutdownMessage;

export interface ResultMessage {
  type: 'result';
  id: number;
  text?: string;
}
export interface ErrorMessage {
  type: 'error';
  id: number;
  message: string;
}
export interface PartialMessage {
  type: 'partial';
  dictationSessionId: string;
  text: string;
}
/** Every message this worker may post back to main. */
export type WorkerReply = ResultMessage | ErrorMessage | PartialMessage;

const parentPort = process.parentPort;

function post(message: WorkerReply): void {
  parentPort.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to prepare the dictation engine';
}

/** A hold that never ends is a bug upstream: a finalize/cancel lost in flight, or
 *  main dying mid-dictation. Nothing else bounds a session, so without this its
 *  engine stays pinned out of the warm LRU and, for the chunked live engine, its
 *  decode loop keeps running for the life of the worker. Ten minutes is far past
 *  any real push-to-talk hold. */
const MAX_SESSION_MS = 10 * 60 * 1000;

/** Ids the expiry above closed. A finalize or cancel for one of them arrives
 *  after the entry is already gone, and without this it would be reported as a
 *  worker restart, which is the one cause it is not. Each id is dropped as soon
 *  as it is read, and main never reuses one. */
const expired = new Set<string>();

interface ActiveSession {
  engine: TranscriptionEngine;
  session: TranscriptionEngineSession;
  /** Fires MAX_SESSION_MS after createSession; cleared when the session ends. */
  expiry: ReturnType<typeof setTimeout>;
}

/** Live (loaded) sessions, keyed by the `dictationSessionId` main assigned -
 *  main owns that id space, so no separate worker-side handle is needed. */
const active = new Map<string, ActiveSession>();
// LRU of warm (loaded) engines keyed by engineKey (see engine-selection.ts's
// computeEngineKey); Map insertion order is the LRU order (oldest first). A
// cache hit re-inserts to mark it MRU. Mirrors TranscriptionService's old
// main-side warm map, moved here because only the worker ever holds a real
// engine object.
const warm = new Map<string, TranscriptionEngine>();
// In-flight loads keyed by engineKey, so two requests for the same selection
// (a prewarm racing a session create) share one load instead of double-loading.
const warming = new Map<string, Promise<TranscriptionEngine>>();
// Bumped by disposeWarm() so a load that completes after a disable/teardown
// ran mid-load is discarded instead of re-added to a cleared warm map.
let warmGeneration = 0;

interface EnsuredEngine {
  engine: TranscriptionEngine;
  /** disposeWarm() ran during the load, so this engine was never warm-cached
   *  and nothing else holds it. Whoever asked for it owns it: claim it into
   *  `active`, or dispose it. */
  superseded: boolean;
}

async function ensureEngine(request: EnsureEngineRequest): Promise<EnsuredEngine> {
  const { engineKey, warmCap } = request;

  const cached = warm.get(engineKey);
  if (cached) {
    warm.delete(engineKey);
    warm.set(engineKey, cached); // move to MRU
    return { engine: cached, superseded: false };
  }

  // Captured before joining an in-flight load as well as before starting one,
  // so a request that merely SHARES someone else's load still measures the
  // generation against its own arrival rather than the load's.
  const generation = warmGeneration;
  const pending = warming.get(engineKey);
  if (pending) return { engine: await pending, superseded: generation !== warmGeneration };

  const promise = buildAndLoad(request);
  warming.set(engineKey, promise);
  let engine: TranscriptionEngine;
  try {
    engine = await promise;
  } finally {
    warming.delete(engineKey);
  }

  if (generation !== warmGeneration) {
    // disposeWarm() ran during the load (dictation disabled mid-load), so the
    // engine must not be cached. Disposing it is the CALLER's decision, not
    // ours: on the createSession path it has not been claimed into `active`
    // yet, so disposing here would hand back an already-disposed engine and
    // the session would be built on it.
    return { engine, superseded: true };
  }
  warm.set(engineKey, engine);
  evictWarm(warmCap);
  return { engine, superseded: false };
}

async function buildAndLoad(request: EnsureEngineRequest): Promise<TranscriptionEngine> {
  const engine = buildEngine(request.selection, request.remote);
  try {
    await engine.load(request.models);
  } catch (error) {
    void engine.dispose();
    throw error;
  }
  return engine;
}

/** Drop least-recently-used warm engines beyond the cap, disposing any that
 *  are idle (an evicted engine still serving a session is disposed on
 *  finalize/cancel instead). */
function evictWarm(cap: number): void {
  while (warm.size > cap) {
    const oldestKey = warm.keys().next().value as string;
    const engine = warm.get(oldestKey);
    warm.delete(oldestKey);
    if (engine) maybeDisposeEngine(engine);
  }
}

/** Dispose an engine only when it is neither warm-cached nor serving a session. */
function maybeDisposeEngine(engine: TranscriptionEngine): void {
  for (const warmEngine of warm.values()) if (warmEngine === engine) return;
  for (const entry of active.values()) if (entry.engine === engine) return;
  void engine.dispose();
}

/**
 * End a session and release what it held. Removal from `active` is synchronous,
 * so no later push can route into a closed session, but the ENGINE is only
 * released once the session's outstanding threadpool work has settled: tearing a
 * recognizer down under a running decode is the DESKTOP-X shape. Sessions with
 * nothing outstanding do not implement `drain`, and resolve immediately.
 */
function closeSession(dictationSessionId: string, entry: ActiveSession): void {
  clearTimeout(entry.expiry);
  active.delete(dictationSessionId);
  entry.session.dispose();
  void (async () => {
    try {
      await entry.session.drain?.();
    } catch {
      // drain() is documented never to reject, but nothing enforces that on a
      // composed session (HybridEngine fans out through Promise.all), and a
      // violation must not cost the engine. Swallowing it here is what keeps
      // the disposal below on every path: otherwise the engine stays pinned out
      // of the warm LRU for the life of the worker, which is the leak this
      // function closes, and the rejection goes unhandled, which by Node's
      // default takes the worker down. The await also catches a synchronous
      // throw from drain() itself, which on the MAX_SESSION_MS timer path has
      // no caller to land in.
    }
    maybeDisposeEngine(entry.engine);
  })();
}

/** Abort a session without committing. Used by the cancel message and by the
 *  MAX_SESSION_MS expiry. */
function cancelSession(dictationSessionId: string): void {
  const entry = active.get(dictationSessionId);
  if (!entry) return;
  entry.session.cancel();
  closeSession(dictationSessionId, entry);
}

/** Release every warm engine (dictation disabled main-side, or shutdown). */
function disposeWarm(): void {
  warmGeneration += 1; // supersede any in-flight load so it is not re-cached
  const engines = [...warm.values()];
  warm.clear();
  warming.clear();
  for (const engine of engines) maybeDisposeEngine(engine);
}

async function handleEnsureWarm(message: PrewarmMessage): Promise<void> {
  try {
    const { engine, superseded } = await ensureEngine(message);
    // A bare prewarm never claims the engine, so a superseded one is an
    // orphan this handler has to release. Deferred a tick because a
    // createSession for the same key can be sharing this very load, and its
    // claim into `active` runs on a later continuation of the same promise -
    // disposing inline would race ahead of it. maybeDisposeEngine then sees
    // the settled truth and leaves a claimed engine alone.
    if (superseded) setImmediate(() => maybeDisposeEngine(engine));
    post({ type: 'result', id: message.id });
  } catch (error) {
    post({ type: 'error', id: message.id, message: errorMessage(error) });
  }
}

async function handleCreateSession(message: CreateSessionMessage): Promise<void> {
  let ensured: EnsuredEngine | null = null;
  try {
    ensured = await ensureEngine(message);
    const engine = ensured.engine;
    const session = engine.createSession({
      sampleRate: 16000,
      language: message.sessionOptions.language,
      punctuation: message.sessionOptions.punctuation,
      onPartial: (text: string) => {
        // Only forward if the session is still active - a partial firing
        // after finalize/cancel already removed the entry must not
        // resurrect a closed dictation for the renderer. Mirrors the
        // `this.active.has(id)` guard TranscriptionService used to apply
        // main-side, kept here too since a partial can arrive between
        // main's cancel() and this worker processing that cancel message.
        if (active.has(message.dictationSessionId)) {
          post({ type: 'partial', dictationSessionId: message.dictationSessionId, text });
        }
      },
    });
    // The claim, which is what keeps a superseded engine alive: from here on
    // maybeDisposeEngine sees it in `active`, and finalize/cancel is what
    // finally disposes it.
    const expiry = setTimeout(() => {
      expired.add(message.dictationSessionId);
      cancelSession(message.dictationSessionId);
    }, MAX_SESSION_MS);
    active.set(message.dictationSessionId, { engine, session, expiry });
    post({ type: 'result', id: message.id });
  } catch (error) {
    // The engine loaded but the session did not, so nothing will ever claim
    // it. Warm-cached engines are left alone by maybeDisposeEngine; only the
    // orphan is released.
    if (ensured) maybeDisposeEngine(ensured.engine);
    post({ type: 'error', id: message.id, message: errorMessage(error) });
  }
}

function handlePush(message: PushMessage): void {
  const entry = active.get(message.dictationSessionId);
  if (!entry) return; // late frame after finalize/cancel, or a crash-recovered session id
  entry.session.push(new Int16Array(message.pcm));
}

async function handleFinalize(message: FinalizeMessage): Promise<void> {
  const entry = active.get(message.dictationSessionId);
  if (!entry) {
    // Main only ever sends `finalize` for a session id its own `active` map
    // still holds, so a miss here has two causes: the MAX_SESSION_MS expiry
    // closed the session, or THIS worker instance never created it - the
    // worker restarted (a crash) between createSession and this finalize.
    // Report either as a failure rather than silently returning '': dictation
    // has no fallback engine, and useDictation.ts's "never fail SILENTLY"
    // contract depends on a lost session surfacing as an error, not as an
    // empty committed transcript. Naming the right cause matters as much,
    // since "the worker restarted" sends anyone reading it to the crash logs.
    post({
      type: 'error',
      id: message.id,
      message: expired.delete(message.dictationSessionId)
        ? 'The dictation session was closed after ten minutes without a finalize'
        : 'The dictation worker restarted before this session finished',
    });
    return;
  }
  try {
    const text = await entry.session.finalize();
    post({ type: 'result', id: message.id, text });
  } catch (error) {
    post({ type: 'error', id: message.id, message: errorMessage(error) });
  } finally {
    closeSession(message.dictationSessionId, entry);
  }
}

function handleCancel(message: CancelMessage): void {
  // Main cancelling an already-expired session is the other way that id leaves
  // `expired`, so the set cannot outlive the sessions it describes.
  expired.delete(message.dictationSessionId);
  cancelSession(message.dictationSessionId);
}

parentPort.on('message', (event: Electron.MessageEvent) => {
  const message = event.data as WorkerRequest;
  // Defensive parse boundary (mirrors DictationClient.onWorkerMessage): a
  // malformed payload must be ignored, not throw inside the handler.
  if (typeof message !== 'object' || message === null) return;

  switch (message.type) {
    case 'shutdown':
      // process.exit(), never a natural return to the event loop: this is
      // the fix for DESKTOP-X reproducing one process over. A graceful
      // return would let this worker's OWN Node environment tear down
      // normally, which is exactly the sequence (FreeEnvironment ->
      // RunCleanup -> one more uv_run pass draining the threadpool) whose
      // napi async-work completion callback crashed the main process in the
      // first place. process.exit() terminates without waiting for that
      // pass, so a still-outstanding recognizer callback never gets the
      // chance to run against a torn-down environment. Mirrors
      // embed-worker.ts / line-count-worker.ts.
      process.exit(0);
      return;
    case 'disposeWarm':
      disposeWarm();
      return;
    case 'push':
      handlePush(message);
      return;
    case 'cancel':
      handleCancel(message);
      return;
    case 'prewarm':
      void handleEnsureWarm(message);
      return;
    case 'createSession':
      void handleCreateSession(message);
      return;
    case 'finalize':
      void handleFinalize(message);
      return;
    default:
      return;
  }
});
