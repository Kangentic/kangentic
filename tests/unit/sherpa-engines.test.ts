import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// First unit coverage for the three sherpa-onnx engines. They had none: until now
// scripts/smoke-dictation.mjs was the only proof any of them worked, which made a
// sherpa version bump a leap of faith (this suite lands with the 1.13.3 to 1.13.8
// alignment). Four behaviors carry the risk and are what this pins:
//
//   1. the streaming drain loop (decode until isReady goes false)
//   2. the 0.5 s tail padding that flushes the transducer's last words
//   3. the defensive Int16Array copy in push(), since PCM frames are reused across
//      IPC messages and a retained reference decodes whatever arrived later
//   4. the chunked engine's overlap guard, which must never run two decodes at once
//
// sherpa-onnx-node is mocked, so nothing here loads the native addon. That also keeps
// the suite honest on CI, where the linux-x64 binary is installed and a real load
// would quietly turn a unit test into an integration test.

const harness = vi.hoisted(() => ({
  onlineConfigs: [] as Record<string, unknown>[],
  offlineConfigs: [] as Record<string, unknown>[],

  // Streaming recognizer
  readyCountdown: 0,
  onlineDecodeCalls: 0,
  onlineResultText: '',
  onlineWaveforms: [] as { sampleRate: number; samples: Float32Array }[],
  inputFinishedCalls: 0,

  // Offline recognizer
  offlineWaveforms: [] as { sampleRate: number; samples: Float32Array }[],
  offlineResultText: '',
  offlineDecodeCalls: 0,
  /** When set, decodeAsync parks here until the test releases it. */
  pendingDecodeRelease: null as (() => void) | null,
  holdDecode: false,

  reset(): void {
    this.onlineConfigs = [];
    this.offlineConfigs = [];
    this.readyCountdown = 0;
    this.onlineDecodeCalls = 0;
    this.onlineResultText = '';
    this.onlineWaveforms = [];
    this.inputFinishedCalls = 0;
    this.offlineWaveforms = [];
    this.offlineResultText = '';
    this.offlineDecodeCalls = 0;
    this.pendingDecodeRelease = null;
    this.holdDecode = false;
  },
}));

vi.mock('sherpa-onnx-node', () => {
  class OnlineStream {
    acceptWaveform(waveform: { sampleRate: number; samples: Float32Array }): void {
      harness.onlineWaveforms.push(waveform);
    }
    inputFinished(): void {
      harness.inputFinishedCalls++;
    }
  }

  class OnlineRecognizer {
    constructor(config: Record<string, unknown>) {
      harness.onlineConfigs.push(config);
    }
    createStream(): OnlineStream {
      return new OnlineStream();
    }
    isReady(): boolean {
      // Each poll consumes one unit of "work pending", so the engine's
      // `while (isReady) decode()` loop terminates after exactly that many decodes.
      if (harness.readyCountdown > 0) {
        harness.readyCountdown--;
        return true;
      }
      return false;
    }
    decode(): void {
      harness.onlineDecodeCalls++;
    }
    getResult(): { text: string } {
      return { text: harness.onlineResultText };
    }
  }

  class OfflineStream {
    acceptWaveform(waveform: { sampleRate: number; samples: Float32Array }): void {
      harness.offlineWaveforms.push(waveform);
    }
  }

  class OfflineRecognizer {
    static async createAsync(config: Record<string, unknown>): Promise<OfflineRecognizer> {
      harness.offlineConfigs.push(config);
      return new OfflineRecognizer();
    }
    createStream(): OfflineStream {
      return new OfflineStream();
    }
    async decodeAsync(): Promise<{ text: string }> {
      harness.offlineDecodeCalls++;
      if (harness.holdDecode) {
        await new Promise<void>((resolve) => {
          harness.pendingDecodeRelease = resolve;
        });
      }
      return { text: harness.offlineResultText };
    }
  }

  return { OnlineRecognizer, OnlineStream, OfflineRecognizer, OfflineStream };
});

const { SherpaOnlineEngine } = await import(
  '../../src/main/transcription/engines/sherpa-online-engine'
);
const { ChunkedOfflineEngine } = await import(
  '../../src/main/transcription/engines/chunked-offline-engine'
);
const { SherpaWhisperEngine, buildOfflineConfig } = await import(
  '../../src/main/transcription/engines/sherpa-whisper-engine'
);

type ResolvedModel = Parameters<InstanceType<typeof SherpaOnlineEngine>['load']>[0][number];

function transducerModel(): ResolvedModel {
  return {
    id: 'zipformer',
    engineId: 'sherpa-online',
    kind: 'online-transducer',
    paths: {
      encoder: '/models/encoder.onnx',
      decoder: '/models/decoder.onnx',
      joiner: '/models/joiner.onnx',
      tokens: '/models/tokens.txt',
    },
  };
}

function nemoModel(): ResolvedModel {
  return {
    id: 'parakeet',
    engineId: 'whisper-cpp',
    kind: 'offline-nemo-transducer',
    paths: {
      encoder: '/models/nemo-encoder.onnx',
      decoder: '/models/nemo-decoder.onnx',
      joiner: '/models/nemo-joiner.onnx',
      tokens: '/models/nemo-tokens.txt',
    },
  };
}

function sessionOptions(onPartial: (text: string) => void = () => {}) {
  return { sampleRate: 16000 as const, language: 'en', punctuation: true, onPartial };
}

beforeEach(() => {
  harness.reset();
});

describe('SherpaOnlineEngine', () => {
  it('refuses to load with no model', async () => {
    await expect(new SherpaOnlineEngine().load([])).rejects.toThrow(/requires a model/i);
  });

  it('builds the streaming transducer config from the resolved model paths', async () => {
    const engine = new SherpaOnlineEngine();
    await engine.load([transducerModel()]);

    expect(harness.onlineConfigs).toHaveLength(1);
    expect(harness.onlineConfigs[0]).toMatchObject({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      decodingMethod: 'greedy_search',
      // The streaming path does its own finalize via tail padding, so sherpa's
      // endpointing must stay off or it would cut utterances early.
      enableEndpoint: false,
      modelConfig: {
        transducer: {
          encoder: '/models/encoder.onnx',
          decoder: '/models/decoder.onnx',
          joiner: '/models/joiner.onnx',
        },
        tokens: '/models/tokens.txt',
        numThreads: 2,
        provider: 'cpu',
      },
    });
  });

  it('refuses to create a session before load', () => {
    expect(() => new SherpaOnlineEngine().createSession(sessionOptions())).toThrow(/not loaded/i);
  });

  it('drains the recognizer until isReady goes false', async () => {
    const engine = new SherpaOnlineEngine();
    await engine.load([transducerModel()]);
    const session = engine.createSession(sessionOptions());

    harness.readyCountdown = 3;
    session.push(new Int16Array([1, 2, 3]));

    expect(harness.onlineDecodeCalls).toBe(3);
  });

  it('emits a partial only when the hypothesis actually changes', async () => {
    const onPartial = vi.fn();
    const engine = new SherpaOnlineEngine();
    await engine.load([transducerModel()]);
    const session = engine.createSession(sessionOptions(onPartial));

    harness.onlineResultText = 'hello';
    session.push(new Int16Array([1]));
    session.push(new Int16Array([2]));
    harness.onlineResultText = 'hello there';
    session.push(new Int16Array([3]));

    expect(onPartial.mock.calls.map(([text]) => text)).toEqual(['hello', 'hello there']);
  });

  it('converts Int16 PCM to Float32 in [-1, 1]', async () => {
    const engine = new SherpaOnlineEngine();
    await engine.load([transducerModel()]);
    const session = engine.createSession(sessionOptions());

    session.push(new Int16Array([32768 / 2, -32768]));

    expect(harness.onlineWaveforms[0].sampleRate).toBe(16000);
    expect(Array.from(harness.onlineWaveforms[0].samples)).toEqual([0.5, -1]);
  });

  it('flushes with half a second of tail padding before finishing input', async () => {
    const engine = new SherpaOnlineEngine();
    await engine.load([transducerModel()]);
    const session = engine.createSession(sessionOptions());

    harness.onlineResultText = '  trailing words  ';
    const text = await session.finalize();

    // 8000 samples at 16 kHz is the 0.5 s of silence that makes the transducer
    // emit its last words instead of holding them.
    const tail = harness.onlineWaveforms.at(-1);
    expect(tail?.samples).toHaveLength(8000);
    expect(tail?.samples.every((sample) => sample === 0)).toBe(true);
    expect(harness.inputFinishedCalls).toBe(1);
    expect(text).toBe('trailing words');
  });
});

describe('ChunkedOfflineEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies each pushed frame, since PCM buffers are reused across IPC messages', async () => {
    const engine = new ChunkedOfflineEngine('en');
    await engine.load([nemoModel()]);
    const session = engine.createSession(sessionOptions());

    const frame = new Int16Array([32768 / 2, 32768 / 2]);
    session.push(frame);
    // The renderer hands the same backing buffer back for the next frame. Without the
    // copy in push(), finalize would decode this later audio instead of what was said.
    frame[0] = 0;
    frame[1] = 0;

    await session.finalize();

    expect(Array.from(harness.offlineWaveforms[0].samples)).toEqual([0.5, 0.5]);
  });

  it('skips a tick while a decode is still running so passes never overlap', async () => {
    const engine = new ChunkedOfflineEngine('en');
    await engine.load([nemoModel()]);
    const session = engine.createSession(sessionOptions());
    session.push(new Int16Array([1, 2, 3]));

    harness.holdDecode = true;
    await vi.advanceTimersByTimeAsync(350);
    expect(harness.offlineDecodeCalls).toBe(1);

    // Two more intervals elapse with the first decode still in flight.
    await vi.advanceTimersByTimeAsync(700);
    expect(harness.offlineDecodeCalls).toBe(1);

    harness.pendingDecodeRelease?.();
    harness.holdDecode = false;
    await vi.advanceTimersByTimeAsync(350);
    expect(harness.offlineDecodeCalls).toBe(2);
  });

  it('stops the preview timer on finalize', async () => {
    const engine = new ChunkedOfflineEngine('en');
    await engine.load([nemoModel()]);
    const session = engine.createSession(sessionOptions());
    session.push(new Int16Array([1, 2, 3]));

    harness.offlineResultText = '  done  ';
    expect(await session.finalize()).toBe('done');
    const callsAtFinalize = harness.offlineDecodeCalls;

    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.offlineDecodeCalls).toBe(callsAtFinalize);
  });

  it('drops buffered audio on cancel', async () => {
    const engine = new ChunkedOfflineEngine('en');
    await engine.load([nemoModel()]);
    const session = engine.createSession(sessionOptions());
    session.push(new Int16Array([1, 2, 3]));

    session.cancel();
    const decodeCallsAfterCancel = harness.offlineDecodeCalls;

    // Nothing buffered means nothing to decode, so finalize short-circuits.
    expect(await session.finalize()).toBe('');
    expect(harness.offlineDecodeCalls).toBe(decodeCallsAfterCancel);
  });
});

describe('SherpaWhisperEngine', () => {
  it('returns empty text without touching the recognizer when no audio arrived', async () => {
    const engine = new SherpaWhisperEngine('en');
    await engine.load([nemoModel()]);
    const session = engine.createSession(sessionOptions());

    expect(await session.finalize()).toBe('');
    expect(harness.offlineDecodeCalls).toBe(0);
  });
});

describe('buildOfflineConfig', () => {
  it('routes a NeMo transducer through modelConfig.transducer with the nemo model type', () => {
    const config = buildOfflineConfig(nemoModel()) as {
      modelConfig: Record<string, unknown>;
      decodingMethod: string;
    };

    expect(config.modelConfig).toMatchObject({
      transducer: {
        encoder: '/models/nemo-encoder.onnx',
        decoder: '/models/nemo-decoder.onnx',
        joiner: '/models/nemo-joiner.onnx',
      },
      tokens: '/models/nemo-tokens.txt',
      modelType: 'nemo_transducer',
      numThreads: 4,
    });
    expect(config.decodingMethod).toBe('greedy_search');
    expect(config.modelConfig).not.toHaveProperty('whisper');
  });

  it('routes Moonshine through modelConfig.moonshine with all four model files', () => {
    const config = buildOfflineConfig({
      id: 'moonshine',
      engineId: 'whisper-cpp',
      kind: 'offline-moonshine',
      paths: {
        preprocessor: '/models/pre.onnx',
        encoder: '/models/enc.onnx',
        uncachedDecoder: '/models/uncached.onnx',
        cachedDecoder: '/models/cached.onnx',
        tokens: '/models/tokens.txt',
      },
    }) as { modelConfig: Record<string, unknown> };

    expect(config.modelConfig).toMatchObject({
      moonshine: {
        preprocessor: '/models/pre.onnx',
        encoder: '/models/enc.onnx',
        uncachedDecoder: '/models/uncached.onnx',
        cachedDecoder: '/models/cached.onnx',
      },
      tokens: '/models/tokens.txt',
    });
    expect(config.modelConfig).not.toHaveProperty('transducer');
  });

  it('bakes the resolved spoken language into a Whisper config', () => {
    const whisperModel: ResolvedModel = {
      id: 'whisper-small',
      engineId: 'whisper-cpp',
      kind: 'offline-whisper',
      paths: {
        encoder: '/models/whisper-encoder.onnx',
        decoder: '/models/whisper-decoder.onnx',
        tokens: '/models/whisper-tokens.txt',
      },
    };

    expect(
      (buildOfflineConfig(whisperModel, 'de') as { modelConfig: { whisper: unknown } }).modelConfig
        .whisper,
    ).toEqual({
      encoder: '/models/whisper-encoder.onnx',
      decoder: '/models/whisper-decoder.onnx',
      language: 'de',
      task: 'transcribe',
    });

    // Callers that omit the language get English, matching the .en-only builds.
    expect(
      (buildOfflineConfig(whisperModel) as { modelConfig: { whisper: { language: string } } })
        .modelConfig.whisper.language,
    ).toBe('en');
  });
});
