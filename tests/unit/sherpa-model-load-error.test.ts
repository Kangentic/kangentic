import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * What each sherpa engine does when the addon refuses a model's files. Since sherpa-onnx 2.0 a
 * corrupt model rejects or throws instead of aborting the worker (measured on the real addon with
 * truncated and garbage files, through both load paths), and that failure has to reach main with
 * the model's id, or the same file fails every press. A missing model is not one of these: it is
 * a bug in the caller, and must never read as a file to delete.
 *
 * Tier: Unit. The addon is mocked, since a native load cannot be driven from here.
 */

const harness = vi.hoisted(() => ({ refuseLoad: false }));

vi.mock('sherpa-onnx-node', () => {
  class OnlineRecognizer {
    constructor() {
      if (harness.refuseLoad) throw new Error('Please check your config!');
    }
  }
  class OfflineRecognizer {
    static async createAsync(): Promise<OfflineRecognizer> {
      if (harness.refuseLoad) throw new Error('Failed to create offline recognizer');
      return new OfflineRecognizer();
    }
  }
  return { OnlineRecognizer, OfflineRecognizer };
});

const { ModelLoadError } = await import('../../src/main/transcription/engines/transcription-engine');
const { SherpaOnlineEngine } = await import('../../src/main/transcription/engines/sherpa-online-engine');
const { SherpaWhisperEngine } = await import('../../src/main/transcription/engines/sherpa-whisper-engine');
const { ChunkedOfflineEngine } = await import('../../src/main/transcription/engines/chunked-offline-engine');

type ResolvedModel = Parameters<InstanceType<typeof SherpaOnlineEngine>['load']>[0][number];

const ONLINE_MODEL: ResolvedModel = {
  id: 'nemotron',
  engineId: 'hybrid',
  kind: 'online-transducer',
  paths: { encoder: 'e.onnx', decoder: 'd.onnx', joiner: 'j.onnx', tokens: 't.txt' },
};
const OFFLINE_MODEL: ResolvedModel = {
  id: 'parakeet',
  engineId: 'hybrid',
  kind: 'offline-nemo-transducer',
  paths: { encoder: 'e.onnx', decoder: 'd.onnx', joiner: 'j.onnx', tokens: 't.txt' },
};

const ENGINES = [
  ['the streaming engine, whose constructor throws', () => new SherpaOnlineEngine(), ONLINE_MODEL, 'Please check your config!'],
  ['the offline engine, whose createAsync rejects', () => new SherpaWhisperEngine(), OFFLINE_MODEL, 'Failed to create offline recognizer'],
  ['the chunked engine, whose createAsync rejects', () => new ChunkedOfflineEngine(), OFFLINE_MODEL, 'Failed to create offline recognizer'],
] as const;

describe('a model the addon refuses', () => {
  beforeEach(() => {
    harness.refuseLoad = false;
  });

  it.each(ENGINES)('%s names the model and keeps the addon\'s message', async (_label, build, model, message) => {
    harness.refuseLoad = true;
    const failure = await build().load([model]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelLoadError);
    expect((failure as InstanceType<typeof ModelLoadError>).modelId).toBe(model.id);
    expect((failure as Error).message).toBe(message);
  });

  it.each(ENGINES)('%s loads a good model with no error', async (_label, build, model) => {
    await expect(build().load([model])).resolves.toBeUndefined();
  });

  it.each(ENGINES)('%s throws a plain error when it is given no model, which names nothing to delete', async (_label, build) => {
    const failure = await build().load([]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ModelLoadError);
  });
});
