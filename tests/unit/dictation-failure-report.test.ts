/**
 * What a failed dictation prepare reports to Sentry (`reportDictationFailure` in
 * transcription-service.ts, module-private, so driven through `start`).
 *
 * Left out of the report: the worker going away or being turned off, a remote
 * engine's own failure (its text names the user's server), and a download the
 * network failed. A download that failed some other way reports by its cause,
 * tagged `download`. Anything else reports tagged `prepare`.
 *
 * Only the chokepoint reporter is replaced (`createChokepointReporter` returns a
 * spy); `isNetworkFailure` is the real one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { reportMock } = vi.hoisted(() => ({ reportMock: vi.fn() }));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: vi.fn() },
}));

vi.mock('../../src/main/analytics/usage', () => ({ trackFeatureUsed: vi.fn() }));

vi.mock('../../src/main/analytics/handled-report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/analytics/handled-report')>();
  return { ...actual, createChokepointReporter: () => ({ report: reportMock, reset: vi.fn() }) };
});

vi.mock('../../src/main/transcription/hardware/detect-hardware', () => ({
  detectHardware: vi.fn(async () => ({
    cpuModel: 'Test CPU', cpuCores: 8, totalRamGb: 16, hasAvx2: true, gpu: 'none', platform: 'linux', arch: 'x64',
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
  finalNeedsSentenceCase: vi.fn(() => false),
  selectEngine: vi.fn(),
}));

import type { DictationClient } from '../../src/main/transcription/dictation-client';
import { selectEngine, type EngineSelection } from '../../src/main/transcription/engines/engine-selection';
import { ensureModel } from '../../src/main/transcription/models/model-manager';
import type { ModelDef } from '../../src/main/transcription/models/model-registry';
import { TranscriptionService } from '../../src/main/transcription/transcription-service';

const MODEL: ModelDef = {
  id: 'model-one',
  engineKind: 'online-transducer',
  displayName: 'model-one',
  license: 'MIT',
  accuracy: { rank: 1, label: 'Basic accuracy' },
  approxSizeMb: 10,
  files: [],
  roles: {},
};

function selectionFor(isRemote: boolean): EngineSelection {
  return {
    id: 'stub',
    info: { id: 'stub', displayName: 'Stub Engine', streaming: false, punctuation: true, license: 'MIT', requiresModelDownload: true },
    models: [MODEL],
    liveModelId: MODEL.id,
    liveModelKind: MODEL.engineKind,
    finalModelId: null,
    isRemote,
    language: 'en',
  } as EngineSelection;
}

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

function namedError(name: string, message = 'boom', code?: string): Error {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.name = name;
  if (code) error.code = code;
  return error;
}

/** Run `start` so that the worker's createSession rejects with `error`. */
async function startFailingWith(error: Error, isRemote: boolean): Promise<void> {
  vi.mocked(selectEngine).mockReturnValueOnce(selectionFor(isRemote));
  vi.mocked(ensureModel).mockImplementation(async (model) => ({ modelId: model.id, kind: model.engineKind, dir: '/mock/dir', paths: {} }));
  const client = makeFakeClient();
  (client.createSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);
  const service = new TranscriptionService(client);
  await expect(service.start({ engineMode: 'auto', language: 'en' })).rejects.toThrow();
}

/** Run `start` so that the model download itself rejects with `cause`. */
async function startWithDownloadFailing(cause: Error): Promise<void> {
  vi.mocked(selectEngine).mockReturnValueOnce(selectionFor(false));
  vi.mocked(ensureModel).mockRejectedValue(cause);
  const service = new TranscriptionService(makeFakeClient());
  await expect(service.start({ engineMode: 'auto', language: 'en' })).rejects.toThrow();
}

beforeEach(() => {
  reportMock.mockReset();
  vi.mocked(ensureModel).mockReset();
});

describe('dictation failure report', () => {
  it.each([
    ['DictationUnavailableError'],
    ['DictationWorkerLostError'],
    ['DictationTurnedOffError'],
  ])('does not report %s, a worker that went away or was turned off', async (name) => {
    await startFailingWith(namedError(name), false);
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('does not report a remote engine\'s DictationWorkerError, whose text names the user\'s server', async () => {
    await startFailingWith(namedError('DictationWorkerError', 'could not reach https://example.invalid'), true);
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('reports the same DictationWorkerError for a local engine, tagged prepare', async () => {
    const error = namedError('DictationWorkerError');
    await startFailingWith(error, false);
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock).toHaveBeenCalledWith(error, { tags: { stage: 'prepare' } });
  });

  it('does not report a download the network failed', async () => {
    await startWithDownloadFailing(namedError('Error', 'connection reset', 'ECONNRESET'));
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('reports a download that failed another way by its cause, tagged download', async () => {
    const cause = namedError('Error', 'no space left on device', 'ENOSPC');
    await startWithDownloadFailing(cause);
    expect(reportMock).toHaveBeenCalledTimes(1);
    const [reported, options] = reportMock.mock.calls[0];
    expect(reported).toBe(cause);
    expect(options).toEqual({ tags: { stage: 'download' } });
  });

  it('reports any other prepare failure as itself, tagged prepare', async () => {
    const error = namedError('TypeError', 'x is not a function');
    await startFailingWith(error, false);
    expect(reportMock).toHaveBeenCalledWith(error, { tags: { stage: 'prepare' } });
  });
});
