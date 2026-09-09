import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * TranscriptionService has no other unit coverage (it needs sherpa-onnx-node,
 * hardware detection, and model downloads, all mocked away here), so the one
 * behavior this file pins is the `dictation` adoption signal `finalize()`
 * fires: once per genuinely completed utterance, and never on either of its
 * two early returns (an unknown/already-finalized session id, and a session
 * cancelled while finalize was waiting for its last frames to land).
 *
 * Every dependency below is mocked to a minimal stub so `start()`/`finalize()`
 * run without touching real hardware detection, engine construction, or model
 * downloads - the goal is the call site's branching, not the transcription
 * engines themselves.
 */

const mocks = vi.hoisted(() => ({
  trackFeatureUsed: vi.fn(),
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

import type {
  TranscriptionEngine,
  TranscriptionEngineSession,
} from '../../src/main/transcription/engines/transcription-engine';
import type { SelectedEngine } from '../../src/main/transcription/engines/engine-registry';
import type { DictationStartOptions } from '../../src/shared/types';

/** The finalize() text the fake session hands back, so a positive test can
 *  confirm the committed text still reaches the caller alongside the signal. */
const FINALIZED_TEXT = 'the finalized utterance';

/** A session whose finalize() resolves immediately with FINALIZED_TEXT. */
function makeFakeSession(): TranscriptionEngineSession {
  return {
    push: vi.fn(),
    finalize: vi.fn(async () => FINALIZED_TEXT),
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeFakeEngine(session: TranscriptionEngineSession): TranscriptionEngine {
  return {
    info: {
      id: 'stub',
      displayName: 'Stub Engine',
      streaming: false,
      punctuation: true,
      license: 'MIT',
      requiresModelDownload: false,
    },
    load: vi.fn(async () => {}),
    createSession: vi.fn(() => session),
    dispose: vi.fn(async () => {}),
  };
}

let latestSession: TranscriptionEngineSession;

vi.mock('../../src/main/transcription/engines/engine-registry', () => ({
  listEngineInfos: vi.fn(() => []),
  selectEngine: vi.fn((): SelectedEngine => {
    latestSession = makeFakeSession();
    return {
      id: 'stub',
      info: {
        id: 'stub',
        displayName: 'Stub Engine',
        streaming: false,
        punctuation: true,
        license: 'MIT',
        requiresModelDownload: false,
      },
      build: () => makeFakeEngine(latestSession),
      models: [],
      liveModelId: null,
      finalModelId: null,
      language: 'en',
    };
  }),
}));

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
    const service = new TranscriptionService();
    const { dictationSessionId } = await service.start(START_OPTIONS);

    const text = await service.finalize(dictationSessionId);

    expect(text).toBe(FINALIZED_TEXT);
    expect(mocks.trackFeatureUsed).toHaveBeenCalledTimes(1);
    expect(mocks.trackFeatureUsed).toHaveBeenCalledWith('dictation');
  });

  it('never fires for an unknown session id (no session was ever started)', async () => {
    const service = new TranscriptionService();

    const text = await service.finalize('never-started');

    expect(text).toBe('');
    expect(mocks.trackFeatureUsed).not.toHaveBeenCalled();
  });

  it('never fires on a second finalize of the same session (already removed from `active`)', async () => {
    const service = new TranscriptionService();
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
      // before calling entry.session.finalize() or the analytics call - this
      // is the second of the two early returns in finalize(), and the one a
      // plain "unknown id" test cannot reach (the id IS known when finalize
      // starts; it stops being known while finalize is still awaiting).
      const service = new TranscriptionService();
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
