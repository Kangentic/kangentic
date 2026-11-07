import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * A model the addon refused gets replaced: main deletes it, downloads it again, and warms the engine
 * back. `isModelInstalled` checks only that the files exist, so without this a corrupt model fails
 * every press for good. The models carry no checksum, so a load failure cannot be told from
 * corruption, and an out-of-memory failure reads the same. What keeps that from re-downloading
 * 600 MB in a loop is the once-per-model bound these tests pin.
 *
 * Tier: Unit. The real TranscriptionService against a fake DictationClient, with the model files
 * mocked, because the replacement must never touch the machine's shared model cache.
 */

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: vi.fn() },
}));
vi.mock('../../src/main/analytics/usage', () => ({ trackFeatureUsed: vi.fn() }));
vi.mock('../../src/main/transcription/hardware/detect-hardware', () => ({
  detectHardware: vi.fn(async () => ({ cpuModel: 'Test CPU', cpuCores: 8, totalRamGb: 16, hasAvx2: true, gpu: 'none', platform: 'win32', arch: 'x64' })),
  selectTier: vi.fn(() => 'accurate-base'),
}));
vi.mock('../../src/main/transcription/models/model-manager', () => ({
  deleteModel: vi.fn(),
  ensureModel: vi.fn(),
  isModelInstalled: vi.fn(() => true),
  listInstalledModels: vi.fn(() => []),
}));
vi.mock('../../src/main/transcription/models/model-registry', () => ({
  getModel: vi.fn(),
  finalCapableModels: vi.fn(() => []),
  isOfflineModel: vi.fn(() => false),
  liveCapableModels: vi.fn(() => []),
  modelLanguages: vi.fn(() => ['en']),
}));
vi.mock('../../src/main/transcription/engines/engine-selection', () => ({
  listEngineInfos: vi.fn(() => []),
  computeEngineKey: vi.fn(() => 'stub-key'),
  finalNeedsSentenceCase: vi.fn(() => false),
  selectEngine: vi.fn(),
}));

import type { DictationClient } from '../../src/main/transcription/dictation-client';
import type { DictationConfig, DictationModelProgress, DictationStartOptions } from '../../src/shared/types';
import { selectEngine, type EngineSelection } from '../../src/main/transcription/engines/engine-selection';
import { deleteModel, ensureModel, isModelInstalled } from '../../src/main/transcription/models/model-manager';
import { getModel, type ModelDef } from '../../src/main/transcription/models/model-registry';
import { TranscriptionService } from '../../src/main/transcription/transcription-service';

const MODEL: ModelDef = {
  id: 'parakeet-tdt-0.6b-v3',
  engineKind: 'offline-nemo-transducer',
  displayName: 'Parakeet',
  license: 'MIT',
  accuracy: { rank: 1, label: 'Basic accuracy' },
  approxSizeMb: 639,
  files: [],
  roles: {},
};

const SELECTION: EngineSelection = {
  id: 'hybrid',
  info: { id: 'hybrid', displayName: 'Hybrid', streaming: true, punctuation: true, license: 'MIT', requiresModelDownload: true },
  models: [MODEL],
  liveModelId: MODEL.id,
  liveModelKind: MODEL.engineKind,
  finalModelId: null,
  isRemote: false,
  language: 'en',
};

const CONFIG: DictationConfig = { enabled: true, engineMode: 'auto', modelId: null, liveModelId: null, language: 'en' };
const START_OPTIONS = { engineMode: 'auto', language: 'en' } as DictationStartOptions;

interface FakeClient extends EventEmitter {
  ensureWarm: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
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
  }) as unknown as FakeClient;
}

function makeService(client: FakeClient): { service: TranscriptionService; progress: DictationModelProgress[] } {
  const service = new TranscriptionService(client as unknown as DictationClient);
  const progress: DictationModelProgress[] = [];
  service.on('model-progress', (event: DictationModelProgress) => progress.push(event));
  return { service, progress };
}

function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('TranscriptionService: a model the addon refused', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeFakeClient();
    vi.mocked(getModel).mockImplementation((id: string) => (id === MODEL.id ? MODEL : undefined));
    vi.mocked(selectEngine).mockReturnValue(SELECTION);
    vi.mocked(isModelInstalled).mockReturnValue(true);
    vi.mocked(deleteModel).mockReset();
    vi.mocked(ensureModel).mockReset();
    vi.mocked(ensureModel).mockImplementation(async (model) => ({ modelId: model.id, kind: model.engineKind, dir: '/mock/dir', paths: {} }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes it, then downloads it, and says so on the progress stream', async () => {
    const { progress } = makeService(client);
    const order: string[] = [];
    vi.mocked(deleteModel).mockImplementation(() => { order.push('delete'); });
    vi.mocked(ensureModel).mockImplementation(async (model) => {
      order.push('download');
      return { modelId: model.id, kind: model.engineKind, dir: '/mock/dir', paths: {} };
    });

    client.emit('model-load-failed', MODEL.id);
    await flush();

    expect(order).toEqual(['delete', 'download']);
    expect(deleteModel).toHaveBeenCalledWith(MODEL.id);
    expect(progress.at(-1)).toMatchObject({ modelId: MODEL.id, status: 'done' });
  });

  it('warms the engine back afterwards, when dictation is on', async () => {
    const { service } = makeService(client);
    await service.prewarm(CONFIG);
    expect(client.ensureWarm).toHaveBeenCalledTimes(1);

    client.emit('model-load-failed', MODEL.id);
    await flush();
    await flush();

    expect(client.ensureWarm).toHaveBeenCalledTimes(2);
  });

  it('warms nothing when dictation was turned off, so a replacement never starts a worker', async () => {
    makeService(client);
    client.emit('model-load-failed', MODEL.id);
    await flush();
    await flush();
    expect(client.ensureWarm).not.toHaveBeenCalled();
  });

  it('replaces a model once per run: a load failure that was never corruption costs one download, not a loop', async () => {
    makeService(client);
    client.emit('model-load-failed', MODEL.id);
    await flush();
    client.emit('model-load-failed', MODEL.id);
    await flush();
    expect(deleteModel).toHaveBeenCalledTimes(1);
    expect(ensureModel).toHaveBeenCalledTimes(1);
  });

  it('ignores a model id the registry does not know, deleting nothing', async () => {
    makeService(client);
    client.emit('model-load-failed', 'not-a-model');
    await flush();
    expect(deleteModel).not.toHaveBeenCalled();
  });

  it('downloads nothing when the delete fails, and the event never rejects', async () => {
    makeService(client);
    vi.mocked(deleteModel).mockImplementation(() => { throw new Error('EBUSY: resource busy or locked'); });
    client.emit('model-load-failed', MODEL.id);
    await flush();
    expect(ensureModel).not.toHaveBeenCalled();
  });

  it('puts a failed download on the progress stream against the model, like any other', async () => {
    const { progress } = makeService(client);
    vi.mocked(ensureModel).mockRejectedValue(new Error('Download failed (503)'));
    client.emit('model-load-failed', MODEL.id);
    await flush();
    expect(progress.at(-1)).toMatchObject({ modelId: MODEL.id, status: 'error', error: 'Download failed (503)' });
  });

  it('makes a press wait for the replacement, so two downloads never write one .part file', async () => {
    const { service } = makeService(client);
    let finishDownload!: () => void;
    const download = new Promise<void>((resolve) => { finishDownload = resolve; });
    vi.mocked(ensureModel).mockImplementation(async (model) => {
      await download;
      return { modelId: model.id, kind: model.engineKind, dir: '/mock/dir', paths: {} };
    });

    client.emit('model-load-failed', MODEL.id);
    await flush();
    expect(ensureModel).toHaveBeenCalledTimes(1);

    const press = service.start(START_OPTIONS);
    await flush();
    expect(ensureModel).toHaveBeenCalledTimes(1);
    expect(client.createSession).not.toHaveBeenCalled();

    finishDownload();
    await press;
    expect(client.createSession).toHaveBeenCalledTimes(1);
  });
});
