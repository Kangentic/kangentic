import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * A multi-model download (the hybrid engine pulls a live model and a
 * refinement model) emits one 'model-progress' stream. Each event carries the
 * AGGREGATE bytes across the whole selection (what the popup's single bar
 * reads) plus the CURRENT model's own pair, `modelDownloadedBytes` /
 * `modelTotalBytes` (what the Dictation settings tab's per-model line reads).
 *
 * The UI specs inject these events through the mock bridge, so nothing else
 * proves the main-process service actually produces the per-model pair. This
 * file drives a real two-model `downloadModel` with only `ensureModel` mocked
 * and asserts on the emitted events, so dropping either field, or sending the
 * aggregate in its place, fails here.
 *
 * The same module-level mocks as transcription-service-dictation-adoption.test.ts
 * keep hardware detection, the worker client, and the model download off the
 * real machine.
 */

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: vi.fn() },
}));

vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: vi.fn(),
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

vi.mock('../../src/main/transcription/hardware/select-tier', () => ({
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
  selectEngine: vi.fn(),
}));

import type { DictationClient } from '../../src/main/transcription/dictation-client';
import type { DictationConfig, DictationModelProgress } from '../../src/shared/types';
import { selectEngine, type EngineSelection } from '../../src/main/transcription/engines/engine-selection';
import { ensureModel } from '../../src/main/transcription/models/model-manager';
import type { ModelDef } from '../../src/main/transcription/models/model-registry';
import { TranscriptionService } from '../../src/main/transcription/transcription-service';

const MEGABYTE = 1024 * 1024;

function makeModel(id: string, approxSizeMb: number): ModelDef {
  return {
    id,
    engineKind: 'online-transducer',
    displayName: id,
    license: 'MIT',
    tier: 'accurate-base',
    approxSizeMb,
    files: [],
    roles: {},
  };
}

const MODEL_ONE = makeModel('model-one', 10);
const MODEL_TWO = makeModel('model-two', 20);

const TWO_MODEL_SELECTION: EngineSelection = {
  id: 'stub',
  info: { id: 'stub', displayName: 'Stub Engine', streaming: false, punctuation: true, license: 'MIT', requiresModelDownload: true },
  models: [MODEL_ONE, MODEL_TWO],
  liveModelId: MODEL_ONE.id,
  liveModelKind: MODEL_ONE.engineKind,
  finalModelId: MODEL_TWO.id,
  isRemote: false,
  language: 'en',
};

/** The sum of both models' nominal sizes: the aggregate bar's denominator. */
const AGGREGATE_TOTAL_BYTES = (MODEL_ONE.approxSizeMb + MODEL_TWO.approxSizeMb) * MEGABYTE;
/** Where the aggregate stands once model one is fully counted. */
const MODEL_ONE_NOMINAL_BYTES = MODEL_ONE.approxSizeMb * MEGABYTE;

// What each model's download reports for itself. The real totals differ from
// the nominal approxSizeMb on purpose: the per-model total is the file size the
// download reported, not the registry's estimate, and the aggregate is built
// from the estimate.
const MODEL_ONE_FIRST_CHUNK_BYTES = 2_000_000;
const MODEL_ONE_REPORTED_TOTAL_BYTES = 10_400_000;
const MODEL_TWO_FIRST_CHUNK_BYTES = 5_000_000;
const MODEL_TWO_REPORTED_TOTAL_BYTES = 20_900_000;

const DOWNLOAD_CONFIG: DictationConfig = {
  enabled: true,
  engineMode: 'auto',
  modelId: null,
  liveModelId: null,
  language: 'en',
};

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

/**
 * Run a real two-model `downloadModel` where `ensureModel` reports two chunks
 * per model, and return the in-flight ('downloading') model-progress events in
 * the order they were emitted.
 *
 * `Date.now` is driven by hand so every chunk lands 200 ms after the last. That
 * clears the service's 150 ms emit throttle, so each chunk produces exactly one
 * event and the assertions never depend on wall-clock timing.
 */
async function downloadTwoModels(): Promise<DictationModelProgress[]> {
  let nowMs = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

  vi.mocked(selectEngine).mockReturnValueOnce(TWO_MODEL_SELECTION);
  vi.mocked(ensureModel).mockImplementation(async (model, onProgress) => {
    const chunks = model.id === MODEL_ONE.id
      ? [MODEL_ONE_FIRST_CHUNK_BYTES, MODEL_ONE_REPORTED_TOTAL_BYTES]
      : [MODEL_TWO_FIRST_CHUNK_BYTES, MODEL_TWO_REPORTED_TOTAL_BYTES];
    const reportedTotalBytes = model.id === MODEL_ONE.id ? MODEL_ONE_REPORTED_TOTAL_BYTES : MODEL_TWO_REPORTED_TOTAL_BYTES;
    for (const downloadedBytes of chunks) {
      nowMs += 200;
      onProgress({ downloadedBytes, totalBytes: reportedTotalBytes });
    }
    return { modelId: model.id, kind: model.engineKind, dir: '/mock/dir', paths: {} };
  });

  const service = new TranscriptionService(makeFakeClient());
  const progressEvents: DictationModelProgress[] = [];
  service.on('model-progress', (progress: DictationModelProgress) => progressEvents.push(progress));

  await service.downloadModel(DOWNLOAD_CONFIG);

  return progressEvents.filter((progress) => progress.status === 'downloading');
}

afterEach(() => {
  vi.mocked(Date.now).mockRestore();
  vi.mocked(ensureModel).mockReset();
});

describe('TranscriptionService model-progress: per-model byte counts beside the aggregate', () => {
  it('while model one downloads, each event names model one and carries its own per-model pair next to the aggregate', async () => {
    const downloading = await downloadTwoModels();

    const modelOneEvents = downloading.filter((progress) => progress.modelId === MODEL_ONE.id);
    expect(modelOneEvents).toEqual([
      {
        modelId: MODEL_ONE.id,
        status: 'downloading',
        downloadedBytes: MODEL_ONE_FIRST_CHUNK_BYTES,
        totalBytes: AGGREGATE_TOTAL_BYTES,
        modelDownloadedBytes: MODEL_ONE_FIRST_CHUNK_BYTES,
        modelTotalBytes: MODEL_ONE_REPORTED_TOTAL_BYTES,
      },
      {
        modelId: MODEL_ONE.id,
        status: 'downloading',
        downloadedBytes: MODEL_ONE_REPORTED_TOTAL_BYTES,
        totalBytes: AGGREGATE_TOTAL_BYTES,
        modelDownloadedBytes: MODEL_ONE_REPORTED_TOTAL_BYTES,
        modelTotalBytes: MODEL_ONE_REPORTED_TOTAL_BYTES,
      },
    ]);
  });

  it('when model two starts, its events name model two and restart the per-model count while the aggregate keeps rising', async () => {
    const downloading = await downloadTwoModels();

    const modelOneEvents = downloading.filter((progress) => progress.modelId === MODEL_ONE.id);
    const modelTwoEvents = downloading.filter((progress) => progress.modelId === MODEL_TWO.id);
    expect(modelTwoEvents).toEqual([
      {
        modelId: MODEL_TWO.id,
        status: 'downloading',
        // Aggregate: model one's nominal size, then model two's own progress on top.
        downloadedBytes: MODEL_ONE_NOMINAL_BYTES + MODEL_TWO_FIRST_CHUNK_BYTES,
        totalBytes: AGGREGATE_TOTAL_BYTES,
        // Per-model pair: model two's own count, not offset by model one.
        modelDownloadedBytes: MODEL_TWO_FIRST_CHUNK_BYTES,
        modelTotalBytes: MODEL_TWO_REPORTED_TOTAL_BYTES,
      },
      {
        modelId: MODEL_TWO.id,
        status: 'downloading',
        downloadedBytes: MODEL_ONE_NOMINAL_BYTES + MODEL_TWO_REPORTED_TOTAL_BYTES,
        totalBytes: AGGREGATE_TOTAL_BYTES,
        modelDownloadedBytes: MODEL_TWO_REPORTED_TOTAL_BYTES,
        modelTotalBytes: MODEL_TWO_REPORTED_TOTAL_BYTES,
      },
    ]);

    // The restart itself: model two's first per-model count is below where model
    // one finished, while the aggregate has kept climbing past model one's size.
    const lastModelOneEvent = modelOneEvents[modelOneEvents.length - 1];
    const firstModelTwoEvent = modelTwoEvents[0];
    expect(firstModelTwoEvent.modelDownloadedBytes).toBeLessThan(lastModelOneEvent.modelDownloadedBytes as number);
    expect(firstModelTwoEvent.downloadedBytes).toBeGreaterThan(lastModelOneEvent.downloadedBytes);
    expect(firstModelTwoEvent.downloadedBytes).toBeGreaterThan(MODEL_ONE_NOMINAL_BYTES);
  });
});
