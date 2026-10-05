import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * `DictationStartOptions.mode` (the preset a user saved: Best, Balanced, Light, or Custom)
 * has to survive `normalizeConfig` on its way into `selectEngine`. If it were dropped, a
 * user saved on Balanced or Light with no model ids would resolve through `effectiveMode`
 * to the machine's default preset (Best on a capable machine), and the service would
 * download and run the wrong models without any error.
 *
 * This lives apart from transcription-service-dictation-adoption.test.ts and
 * transcription-service-model-progress.test.ts on purpose. Both of those mock
 * `engine-selection` and `model-registry` at module scope (the registry mock has no
 * `getModel`), so a real `selectEngine` cannot run in either of them. Here `select-tier`,
 * `engine-selection`, `model-registry` and `dictation-info` are all real, and only the
 * edges that touch the machine are faked: electron, the hardware probe, the model
 * download, and the dictation worker client.
 */

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: vi.fn() },
}));

vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: vi.fn(),
}));

// transcription-service.ts reads both detectHardware and selectTier from this module
// (selectTier only for the warm-engine cap), so the mock supplies both. The profile is
// an accurate-tier machine: 8 cores and 16 GB, so the machine default preset is Best.
vi.mock('../../src/main/transcription/hardware/detect-hardware', async () => {
  const { selectTier } = await vi.importActual<typeof import('../../src/main/transcription/hardware/select-tier')>(
    '../../src/main/transcription/hardware/select-tier',
  );
  return {
    detectHardware: vi.fn(async () => ({
      cpuModel: 'Test CPU',
      cpuCores: 8,
      totalRamGb: 16,
      hasAvx2: true,
      gpu: 'none',
      platform: 'linux',
      arch: 'x64',
    })),
    selectTier,
  };
});

vi.mock('../../src/main/transcription/models/model-manager', () => ({
  ensureModel: vi.fn(async (model: { id: string; engineKind: string }) => ({
    modelId: model.id,
    kind: model.engineKind,
    dir: '/mock/dir',
    paths: {},
  })),
  isModelInstalled: vi.fn(() => true),
  listInstalledModels: vi.fn(() => []),
}));

import type { DictationClient } from '../../src/main/transcription/dictation-client';
import type { DictationConfig, DictationStartOptions } from '../../src/shared/types';
import { TranscriptionService } from '../../src/main/transcription/transcription-service';

const PARAKEET_V3_ID = 'parakeet-tdt-0.6b-v3';
const NEMOTRON_ENGLISH_ID = 'nemotron-streaming-0.6b-en';
const ZIPFORMER_ID = 'streaming-zipformer-en';

function makeFakeClient(): DictationClient {
  return Object.assign(new EventEmitter(), {
    crashed: false,
    crashReason: null,
    ensureWarm: vi.fn(async () => {}),
    createSession: vi.fn(async () => {}),
    push: vi.fn(),
    finalize: vi.fn(async () => ''),
    cancel: vi.fn(),
    release: vi.fn(),
    dispose: vi.fn(),
  }) as unknown as DictationClient;
}

/** The request `start` sent to the worker client: the selection and the models it resolved. */
function createSessionRequestOf(client: DictationClient) {
  const createSession = vi.mocked(client.createSession);
  expect(createSession).toHaveBeenCalledTimes(1);
  return createSession.mock.calls[0][0];
}

/** The request `prewarm` sent to the worker client. */
function ensureWarmRequestOf(client: DictationClient) {
  const ensureWarm = vi.mocked(client.ensureWarm);
  expect(ensureWarm).toHaveBeenCalledTimes(1);
  return ensureWarm.mock.calls[0][0];
}

/** A config as the renderer saves it for a preset: a mode and no model ids. */
function startOptionsFor(mode: DictationStartOptions['mode']): DictationStartOptions {
  return { engineMode: 'auto', mode, modelId: null, liveModelId: null, language: 'en' };
}

describe('TranscriptionService.start: the saved mode reaches the engine selection', () => {
  it('Balanced with no model ids runs Parakeet v3 alone, not the Best pair of Nemotron plus Parakeet', async () => {
    const client = makeFakeClient();
    const service = new TranscriptionService(client);

    const result = await service.start(startOptionsFor('balanced'));

    const request = createSessionRequestOf(client);
    expect(request.selection.liveModelId).toBe(PARAKEET_V3_ID);
    expect(request.selection.finalModelId).toBeNull();
    expect(request.selection.models.map((model) => model.id)).toEqual([PARAKEET_V3_ID]);
    expect(request.models.map((model) => model.id)).toEqual([PARAKEET_V3_ID]);
    expect(result.modelId).toBe(PARAKEET_V3_ID);
  });

  it('Light with no model ids runs the Zipformer alone, not the Best pair', async () => {
    const client = makeFakeClient();
    const service = new TranscriptionService(client);

    await service.start(startOptionsFor('fast'));

    const request = createSessionRequestOf(client);
    expect(request.selection.liveModelId).toBe(ZIPFORMER_ID);
    expect(request.selection.finalModelId).toBeNull();
    expect(request.selection.models.map((model) => model.id)).toEqual([ZIPFORMER_ID]);
  });

  // The control. With no mode and no ids the machine default applies, which on this
  // accurate-tier machine is Best. The two cases above can only pass if the mode
  // changed that outcome, so this is what makes them prove the mode got through.
  it('with no mode and no model ids the machine default (Best) applies: Nemotron live plus Parakeet v3 final', async () => {
    const client = makeFakeClient();
    const service = new TranscriptionService(client);

    await service.start(startOptionsFor(undefined));

    const request = createSessionRequestOf(client);
    expect(request.selection.liveModelId).toBe(NEMOTRON_ENGLISH_ID);
    expect(request.selection.finalModelId).toBe(PARAKEET_V3_ID);
    expect(request.selection.models.map((model) => model.id)).toEqual([NEMOTRON_ENGLISH_ID, PARAKEET_V3_ID]);
  });
});

describe('TranscriptionService.start: sentenceCaseFinal tells the renderer which finals to recase', () => {
  // The renderer sentence-cases a committed final only when this is true. It used
  // to recase every final with no lowercase letter, which typed a bare "GPU" from
  // Nemotron as "Gpu". toBe(false), not toBeFalsy(): a result that leaves the
  // field out must fail the Balanced case too.
  it('is true for Light with no model ids: the Zipformer alone writes all caps', async () => {
    const client = makeFakeClient();
    const service = new TranscriptionService(client);

    const result = await service.start(startOptionsFor('fast'));

    expect(createSessionRequestOf(client).selection.liveModelId).toBe(ZIPFORMER_ID);
    expect(result.sentenceCaseFinal).toBe(true);
  });

  it('is false for Balanced with no model ids: Parakeet v3 writes its own case', async () => {
    const client = makeFakeClient();
    const service = new TranscriptionService(client);

    const result = await service.start(startOptionsFor('balanced'));

    expect(createSessionRequestOf(client).selection.liveModelId).toBe(PARAKEET_V3_ID);
    expect(result.sentenceCaseFinal).toBe(false);
  });
});

describe('TranscriptionService: prewarm and start agree on the engine for the same saved mode', () => {
  // A warm engine is reused only when the press computes the same engine key the
  // prewarm warmed. `prewarm` takes the config as saved while `start` rebuilds it
  // through normalizeConfig, so a mode lost in that rebuild makes the press ask for
  // Best while the prewarm loaded Balanced: the warm engine is never reused.
  it('Balanced: the engine key prewarm warms is the one start asks for', async () => {
    const client = makeFakeClient();
    const service = new TranscriptionService(client);
    const savedConfig: DictationConfig = { enabled: true, ...startOptionsFor('balanced') };

    await service.prewarm(savedConfig);
    await service.start(startOptionsFor('balanced'));

    const warmed = ensureWarmRequestOf(client);
    const started = createSessionRequestOf(client);
    expect(warmed.selection.liveModelId).toBe(PARAKEET_V3_ID);
    expect(started.engineKey).toBe(warmed.engineKey);
  });
});
