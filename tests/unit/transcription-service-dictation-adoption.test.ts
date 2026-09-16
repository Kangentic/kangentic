import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * TranscriptionService has no other unit coverage (it needs hardware
 * detection, model downloads, and the dictation worker, all mocked away
 * here), so the one behavior this file pins is the `dictation` adoption
 * signal `finalize()` fires: once per genuinely completed utterance, and
 * never on either of its two early returns (an unknown/already-finalized
 * session id, and a session cancelled while finalize was waiting for its
 * last frames to land).
 *
 * The engine itself lives in the kangentic-dictation utilityProcess worker
 * (DESKTOP-X), never in this process, so DictationClient - not the engines -
 * is what this test fakes: a minimal EventEmitter-based stand-in injected
 * through TranscriptionService's constructor, mirroring how
 * dictation-client.test.ts fakes the worker one layer further down.
 */

const mocks = vi.hoisted(() => ({
  trackFeatureUsed: vi.fn(),
}));

// transcription-service.ts imports dictation-client.ts for its default
// DictationClient parameter (dictationClient), so importing it always
// executes dictation-client.ts's module-level `import ... from 'electron'` -
// even though every test here injects a fake client and never touches the
// real one. Mock electron so that import does not fail; nothing here ever
// calls utilityProcess.fork.
vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: vi.fn() },
}));

vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: mocks.trackFeatureUsed,
}));

vi.mock('../../src/main/transcription/hardware/detect-hardware', () => ({
  detectHardware: vi.fn(async () => ({
    cpuModel: 'Test CPU',
    cpuCores: 8,
    totalRamGb: 16,
    hasAvx2: true,
    gpu: 'none',
    platform: 'linux',
    arch: 'x64',
  })),
  selectTier: vi.fn(() => 'accurate-base'),
}));

vi.mock('../../src/main/transcription/models/model-manager', () => ({
  ensureModel: vi.fn(),
  isModelInstalled: vi.fn(() => true),
  listInstalledModels: vi.fn(() => []),
}));

vi.mock('../../src/main/transcription/models/model-registry', () => ({
  finalCapableModels: vi.fn(() => []),
  isOfflineModel: vi.fn(() => false),
  liveCapableModels: vi.fn(() => []),
  modelLanguages: vi.fn(() => ['en']),
}));

vi.mock('../../src/main/transcription/engines/engine-selection', () => ({
  listEngineInfos: vi.fn(() => []),
  computeEngineKey: vi.fn(() => 'stub-key'),
  selectEngine: vi.fn(() => ({
    id: 'stub',
    info: { id: 'stub', displayName: 'Stub Engine', streaming: false, punctuation: true, license: 'MIT', requiresModelDownload: false },
    models: [],
    liveModelId: null,
    liveModelKind: null,
    finalModelId: null,
    isRemote: false,
    language: 'en',
  })),
}));

import type { DictationClient } from '../../src/main/transcription/dictation-client';
import type { DictationConfig, DictationModelProgress, DictationStartOptions } from '../../src/shared/types';
import { selectEngine, type EngineSelection } from '../../src/main/transcription/engines/engine-selection';
import { ensureModel } from '../../src/main/transcription/models/model-manager';
import type { ModelDef } from '../../src/main/transcription/models/model-registry';

/** The finalize() text the fake client hands back, so a positive test can
 *  confirm the committed text still reaches the caller alongside the signal. */
const FINALIZED_TEXT = 'the finalized utterance';

/** A minimal fake DictationClient: createSession/finalize always succeed;
 *  finalize() resolves FINALIZED_TEXT. Real behavior (rejection paths,
 *  warm-hold, idle recycle) is covered by dictation-client.test.ts.
 *  `overrides` lets the getInfo() worker-health tests below report the
 *  client as crashed; every other call site keeps the healthy default. */
function makeFakeClient(overrides: { crashed?: boolean; crashReason?: string | null } = {}): DictationClient {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    crashed: overrides.crashed ?? false,
    crashReason: overrides.crashReason ?? null,
    ensureWarm: vi.fn(async () => {}),
    createSession: vi.fn(async () => {}),
    push: vi.fn(),
    finalize: vi.fn(async () => FINALIZED_TEXT),
    cancel: vi.fn(),
    setWarmHold: vi.fn(),
    disposeWarm: vi.fn(),
    dispose: vi.fn(),
  }) as unknown as DictationClient;
}

import { TranscriptionService } from '../../src/main/transcription/transcription-service';

const START_OPTIONS: DictationStartOptions = {
  engineMode: 'auto',
  punctuation: true,
  language: 'en',
};

beforeEach(() => {
  mocks.trackFeatureUsed.mockClear();
});

describe('TranscriptionService.finalize: dictation adoption signal', () => {
  it('fires once for a genuinely completed utterance, alongside the committed text', async () => {
    const service = new TranscriptionService(makeFakeClient());
    const { dictationSessionId } = await service.start(START_OPTIONS);

    const text = await service.finalize(dictationSessionId);

    expect(text).toBe(FINALIZED_TEXT);
    expect(mocks.trackFeatureUsed).toHaveBeenCalledTimes(1);
    expect(mocks.trackFeatureUsed).toHaveBeenCalledWith('dictation');
  });

  it('never fires for an unknown session id (no session was ever started)', async () => {
    const service = new TranscriptionService(makeFakeClient());

    const text = await service.finalize('never-started');

    expect(text).toBe('');
    expect(mocks.trackFeatureUsed).not.toHaveBeenCalled();
  });

  it('never fires on a second finalize of the same session (already removed from `active`)', async () => {
    const service = new TranscriptionService(makeFakeClient());
    const { dictationSessionId } = await service.start(START_OPTIONS);
    await service.finalize(dictationSessionId);
    mocks.trackFeatureUsed.mockClear();

    const secondText = await service.finalize(dictationSessionId);

    expect(secondText).toBe('');
    expect(mocks.trackFeatureUsed).not.toHaveBeenCalled();
  });

  describe('a session cancelled while finalize awaits its last frames', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('never fires: the drain-wait safety timeout resolves into a session finalize() already cancelled out from under it', async () => {
      // finalize(id, expectedFrames) waits (bounded) for the renderer's
      // reported frame count before decoding. If cancel() removes the session
      // from `active` during that wait, finalize's post-wait guard bails
      // before calling client.finalize() or the analytics call - this is the
      // second of the two early returns in finalize(), and the one a plain
      // "unknown id" test cannot reach (the id IS known when finalize
      // starts; it stops being known while finalize is still awaiting).
      const service = new TranscriptionService(makeFakeClient());
      const { dictationSessionId } = await service.start(START_OPTIONS);

      const finalizePromise = service.finalize(dictationSessionId, 5);
      service.cancel(dictationSessionId);
      // The frame-drain safety net is a private, unexported constant
      // (FRAME_DRAIN_TIMEOUT_MS = 500 today); advance well past any
      // reasonable value for it rather than pinning the exact number here.
      await vi.advanceTimersByTimeAsync(5_000);
      const text = await finalizePromise;

      expect(text).toBe('');
      expect(mocks.trackFeatureUsed).not.toHaveBeenCalled();
    });
  });
});

describe('TranscriptionService: a failed client request cancels the worker-side session it may have left behind', () => {
  // A REJECT from the client does not prove the worker never created (or
  // finished creating) the session - a TIMEOUT specifically means the
  // client gave up while the worker was still working, and the worker's own
  // completion (success or failure) can still land afterward and leave a
  // live session in the worker's `active` map that nothing will ever
  // finalize or cancel: its buffered frames leak, and maybeDisposeEngine
  // refuses to dispose its engine forever. finalize()/start() must send an
  // explicit cancel() on any client failure so the worker forgets it either
  // way, not only reason about the timeout case specially.

  it('finalize() cancels the worker-side session on a client rejection, then rethrows', async () => {
    const client = makeFakeClient();
    (client.finalize as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('did not respond in time'));
    const service = new TranscriptionService(client);
    const { dictationSessionId } = await service.start(START_OPTIONS);

    await expect(service.finalize(dictationSessionId)).rejects.toThrow('did not respond in time');

    expect(client.cancel).toHaveBeenCalledWith(dictationSessionId);
    // Cleaned up main-side too, matching the non-failure path.
    await expect(service.finalize(dictationSessionId)).resolves.toBe('');
  });

  it('start() cancels the worker-side session on a createSession rejection, then rethrows', async () => {
    const client = makeFakeClient();
    (client.createSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('did not respond in time'));
    const service = new TranscriptionService(client);

    await expect(service.start(START_OPTIONS)).rejects.toThrow();

    expect(client.cancel).toHaveBeenCalledWith(expect.stringMatching(/^dictation-/));
  });
});

describe('TranscriptionService: DictationClient wiring', () => {
  it('forwards a partial from the client only while the session is still active', async () => {
    const client = makeFakeClient();
    const service = new TranscriptionService(client);
    const partials: Array<[string, string]> = [];
    service.on('partial', (id: string, text: string) => partials.push([id, text]));

    const { dictationSessionId } = await service.start(START_OPTIONS);
    (client as unknown as EventEmitter).emit('partial', dictationSessionId, 'hel');
    await service.finalize(dictationSessionId);
    (client as unknown as EventEmitter).emit('partial', dictationSessionId, 'a late one after finalize');

    expect(partials).toEqual([[dictationSessionId, 'hel']]);
  });

  it('prewarm(config) holds the client warm and asks it to ensure the engine; prewarm(null) releases the hold and disposes warm state', async () => {
    const client = makeFakeClient();
    const service = new TranscriptionService(client);

    await service.prewarm({ enabled: true, engineMode: 'auto', modelId: null, liveModelId: null, punctuation: true, language: 'en' });
    expect(client.setWarmHold).toHaveBeenCalledWith(true);
    expect(client.ensureWarm).toHaveBeenCalledTimes(1);

    await service.prewarm(null);
    expect(client.setWarmHold).toHaveBeenCalledWith(false);
    expect(client.disposeWarm).toHaveBeenCalledTimes(1);
  });

  it('dispose() cancels every active session and tears down the client synchronously', async () => {
    const client = makeFakeClient();
    const service = new TranscriptionService(client);
    const { dictationSessionId } = await service.start(START_OPTIONS);

    service.dispose();

    expect(client.cancel).toHaveBeenCalledWith(dictationSessionId);
    expect(client.setWarmHold).toHaveBeenCalledWith(false);
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });
});

const INFO_CONFIG: DictationConfig = {
  enabled: true,
  engineMode: 'auto',
  modelId: null,
  liveModelId: null,
  punctuation: true,
  language: 'en',
};

describe('TranscriptionService.getInfo: worker crash health', () => {
  // getInfo() is the ONLY producer of workerUnavailable/workerError anywhere
  // in the app (the settings panel's sole source for them), and nothing
  // called getInfo() before this describe block - a revert to hardcoded
  // `false`/`undefined` passed the whole suite.
  it('surfaces a crashed client as workerUnavailable: true with its crashReason as workerError', async () => {
    const client = makeFakeClient({ crashed: true, crashReason: 'exit code 3221226505: sherpa-onnx native fault' });
    const service = new TranscriptionService(client);

    const info = await service.getInfo(INFO_CONFIG);

    expect(info.workerUnavailable).toBe(true);
    expect(info.workerError).toBe('exit code 3221226505: sherpa-onnx native fault');
  });

  it('surfaces a healthy client as workerUnavailable: false with workerError undefined (never the string "null")', async () => {
    const client = makeFakeClient({ crashed: false, crashReason: null });
    const service = new TranscriptionService(client);

    const info = await service.getInfo(INFO_CONFIG);

    expect(info.workerUnavailable).toBe(false);
    expect(info.workerError).toBeUndefined();
  });
});

describe('TranscriptionService.prewarm: failure reporting is a behavior change, not a refactor', () => {
  // A failed prewarm used to be swallowed entirely (`catch { /* best-effort */ }`).
  // It now reports through the same model-progress 'error' channel a failed
  // download/start already uses, but ONLY when selectEngine got far enough to
  // name a model (`selected` assigned) before the failure - see the second
  // test below for the guard that gates on that.
  const STUB_MODEL: ModelDef = {
    id: 'stub-model',
    engineKind: 'online-transducer',
    displayName: 'Stub Model',
    license: 'MIT',
    tier: 'accurate-base',
    approxSizeMb: 1,
    files: [],
    roles: {},
  };

  const SELECTION_WITH_MODEL: EngineSelection = {
    id: 'stub',
    info: { id: 'stub', displayName: 'Stub Engine', streaming: false, punctuation: true, license: 'MIT', requiresModelDownload: false },
    models: [STUB_MODEL],
    liveModelId: STUB_MODEL.id,
    liveModelKind: STUB_MODEL.engineKind,
    finalModelId: null,
    isRemote: false,
    language: 'en',
  };

  it('reports a model-progress error when the worker load fails after selectEngine already named a model', async () => {
    vi.mocked(selectEngine).mockReturnValueOnce(SELECTION_WITH_MODEL);
    vi.mocked(ensureModel).mockResolvedValueOnce({
      modelId: STUB_MODEL.id,
      kind: STUB_MODEL.engineKind,
      dir: '/mock/dir',
      paths: {},
    });
    const client = makeFakeClient();
    (client.ensureWarm as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('worker did not respond'));
    const service = new TranscriptionService(client);
    const progressEvents: DictationModelProgress[] = [];
    service.on('model-progress', (progress: DictationModelProgress) => progressEvents.push(progress));

    await service.prewarm(INFO_CONFIG);

    expect(progressEvents).toEqual([
      { modelId: STUB_MODEL.id, status: 'error', downloadedBytes: 0, totalBytes: 0, error: 'worker did not respond' },
    ]);
  });

  it('reports nothing and still resolves when selectEngine itself throws (selected is never assigned)', async () => {
    vi.mocked(selectEngine).mockImplementationOnce(() => {
      throw new Error('hardware detection produced an unusable profile');
    });
    const client = makeFakeClient();
    const service = new TranscriptionService(client);
    const progressEvents: DictationModelProgress[] = [];
    service.on('model-progress', (progress: DictationModelProgress) => progressEvents.push(progress));

    await expect(service.prewarm(INFO_CONFIG)).resolves.toBeUndefined();

    expect(progressEvents).toEqual([]);
    expect(client.ensureWarm).not.toHaveBeenCalled();
  });
});
