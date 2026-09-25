import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CreateSessionOptions, ResolvedModel } from '../../src/main/transcription/engines/transcription-engine';

/**
 * SherpaWhisperEngine, the accurate offline pass that produces the committed
 * text. Its whole contract is that push() only buffers and exactly one decode
 * happens, on finalize. It also owns buildOfflineConfig, the config builder the
 * chunked live engine shares, whose three model-kind branches are the thing most
 * likely to break silently when a model kind is added.
 *
 * sherpa-onnx-node is a native addon, so it is mocked.
 */

interface PendingDecode {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

const harness = vi.hoisted(() => ({
  state: {
    createdStreams: 0,
    decodeCalls: 0,
    /** Sample count handed to each decode. */
    sampleCounts: [] as number[],
    resultText: '',
    /** The config the recognizer was constructed with. */
    lastConfig: null as unknown,
    /** When true, a decode hangs until a test settles it by hand via `pending`,
     *  rather than resolving with `resultText` on the spot. This is what lets a
     *  test observe drain() while a decode is still on the threadpool. */
    manualDecode: false,
    pending: [] as PendingDecode[],
  },
}));

vi.mock('sherpa-onnx-node', () => {
  class OfflineStream {
    sampleCount = 0;
    acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void {
      this.sampleCount = waveform.samples.length;
    }
  }

  class OfflineRecognizer {
    static async createAsync(config: unknown): Promise<OfflineRecognizer> {
      harness.state.lastConfig = config;
      return new OfflineRecognizer();
    }
    createStream(): OfflineStream {
      harness.state.createdStreams += 1;
      return new OfflineStream();
    }
    async decodeAsync(stream: OfflineStream): Promise<{ text: string }> {
      harness.state.decodeCalls += 1;
      harness.state.sampleCounts.push(stream.sampleCount);
      if (harness.state.manualDecode) {
        return new Promise<{ text: string }>((resolve, reject) => {
          harness.state.pending.push({ resolve: (text) => resolve({ text }), reject });
        });
      }
      return { text: harness.state.resultText };
    }
  }

  return { OfflineRecognizer, OfflineStream };
});

const { SherpaWhisperEngine, buildOfflineConfig } = await import(
  '../../src/main/transcription/engines/sherpa-whisper-engine'
);

interface OfflineConfig {
  featConfig: { sampleRate: number; featureDim: number };
  decodingMethod?: string;
  modelConfig: {
    tokens: string;
    numThreads: number;
    modelType?: string;
    transducer?: { encoder: string; decoder: string; joiner: string };
    moonshine?: Record<string, string>;
    whisper?: { encoder: string; decoder: string; language: string; task: string };
  };
}

function model(kind: ResolvedModel['kind'], paths: Record<string, string>): ResolvedModel {
  return { id: `${kind}-model`, engineId: 'whisper-cpp', kind, paths };
}

const PARAKEET = model('offline-nemo-transducer', {
  encoder: 'encoder.onnx',
  decoder: 'decoder.onnx',
  joiner: 'joiner.onnx',
  tokens: 'tokens.txt',
});

function audioFrame(durationMs: number): Int16Array {
  return new Int16Array(16 * durationMs);
}

/** Flushes the microtask queue, so an async call started without an await (a
 *  finalize() or drain() the test wants to observe mid-flight) gets a chance to
 *  reach its first real await before an assertion runs. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SherpaWhisperEngine', () => {
  const state = harness.state;
  let options: CreateSessionOptions;

  async function loadedEngine(): Promise<InstanceType<typeof SherpaWhisperEngine>> {
    const engine = new SherpaWhisperEngine('en');
    await engine.load([PARAKEET]);
    return engine;
  }

  beforeEach(() => {
    state.createdStreams = 0;
    state.decodeCalls = 0;
    state.sampleCounts = [];
    state.resultText = '';
    state.lastConfig = null;
    state.manualDecode = false;
    state.pending = [];
    options = { sampleRate: 16000, language: 'en', punctuation: true, onPartial: vi.fn() };
  });

  it('buffers without decoding until finalize', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    session.push(audioFrame(100));
    session.push(audioFrame(100));
    expect(state.decodeCalls).toBe(0);

    state.resultText = '  the utterance  ';
    await expect(session.finalize()).resolves.toBe('the utterance');

    // Exactly one decode, over the whole buffer: 200ms at 16 samples per ms.
    expect(state.decodeCalls).toBe(1);
    expect(state.createdStreams).toBe(1);
    expect(state.sampleCounts).toEqual([3200]);
  });

  it('emits no partials at all', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    session.push(audioFrame(100));
    await session.finalize();

    expect(options.onPartial).not.toHaveBeenCalled();
  });

  it('finalizes an empty buffer without touching the recognizer', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    await expect(session.finalize()).resolves.toBe('');
    expect(state.createdStreams).toBe(0);
    expect(state.decodeCalls).toBe(0);
  });

  it('drops the buffer on cancel', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    session.push(audioFrame(100));
    session.cancel();

    await expect(session.finalize()).resolves.toBe('');
    expect(state.decodeCalls).toBe(0);
  });

  it('drain() waits out the final decode before resolving', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));
    state.manualDecode = true;

    const finalized = session.finalize();
    await flush();
    expect(state.pending).toHaveLength(1);

    let drained = false;
    void session.drain?.().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    state.pending[0].resolve('the final text');
    await flush();
    expect(drained).toBe(true);
    await expect(finalized).resolves.toBe('the final text');
  });

  it('drain() resolves immediately with nothing outstanding', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    await expect(session.drain?.()).resolves.toBeUndefined();

    session.push(audioFrame(100));
    session.cancel();
    await expect(session.drain?.()).resolves.toBeUndefined();
  });

  it('drain() swallows a rejected final decode rather than rejecting itself', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));
    state.manualDecode = true;

    const finalized = session.finalize();
    void finalized.catch(() => undefined);
    await flush();
    expect(state.pending).toHaveLength(1);

    const draining = session.drain?.();
    state.pending[0].reject(new Error('decode blew up'));

    await expect(draining).resolves.toBeUndefined();
    await expect(finalized).rejects.toThrow('decode blew up');
  });

  it('refuses to create a session before the model is loaded', () => {
    const engine = new SherpaWhisperEngine('en');
    expect(() => engine.createSession(options)).toThrow(/not loaded/);
  });

  it('rejects a model set with no usable model', async () => {
    const engine = new SherpaWhisperEngine('en');
    await expect(engine.load([])).rejects.toThrow(/requires a model/);
  });
});

describe('buildOfflineConfig', () => {
  it('builds a NeMo transducer config for Parakeet', () => {
    const config = buildOfflineConfig(PARAKEET) as OfflineConfig;

    expect(config.modelConfig.transducer).toEqual({
      encoder: 'encoder.onnx',
      decoder: 'decoder.onnx',
      joiner: 'joiner.onnx',
    });
    expect(config.modelConfig.modelType).toBe('nemo_transducer');
    expect(config.decodingMethod).toBe('greedy_search');
    expect(config.modelConfig.whisper).toBeUndefined();
  });

  it('builds a moonshine config from its four parts', () => {
    const config = buildOfflineConfig(
      model('offline-moonshine', {
        preprocessor: 'pre.onnx',
        encoder: 'enc.onnx',
        uncachedDecoder: 'uncached.onnx',
        cachedDecoder: 'cached.onnx',
        tokens: 'tokens.txt',
      }),
    ) as OfflineConfig;

    expect(config.modelConfig.moonshine).toEqual({
      preprocessor: 'pre.onnx',
      encoder: 'enc.onnx',
      uncachedDecoder: 'uncached.onnx',
      cachedDecoder: 'cached.onnx',
    });
    expect(config.modelConfig.transducer).toBeUndefined();
  });

  // The resolved spoken language is baked in at load, which is how a
  // multilingual build previews in the right language.
  it('bakes the language into a whisper config', () => {
    const config = buildOfflineConfig(
      model('offline-whisper', { encoder: 'enc.onnx', decoder: 'dec.onnx', tokens: 'tokens.txt' }),
      'fr',
    ) as OfflineConfig;

    expect(config.modelConfig.whisper).toEqual({
      encoder: 'enc.onnx',
      decoder: 'dec.onnx',
      language: 'fr',
      task: 'transcribe',
    });
  });

  it('defaults the language to English', () => {
    const config = buildOfflineConfig(
      model('offline-whisper', { encoder: 'enc.onnx', decoder: 'dec.onnx', tokens: 'tokens.txt' }),
    ) as OfflineConfig;

    expect(config.modelConfig.whisper?.language).toBe('en');
  });

  it('captures 16 kHz 80-dim features for every kind', () => {
    for (const resolved of [
      PARAKEET,
      model('offline-whisper', { encoder: 'e', decoder: 'd', tokens: 't' }),
      model('offline-moonshine', { preprocessor: 'p', encoder: 'e', uncachedDecoder: 'u', cachedDecoder: 'c', tokens: 't' }),
    ]) {
      const config = buildOfflineConfig(resolved) as OfflineConfig;
      expect(config.featConfig).toEqual({ sampleRate: 16000, featureDim: 80 });
      expect(config.modelConfig.tokens).toBeDefined();
    }
  });
});
