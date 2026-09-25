import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CreateSessionOptions, ResolvedModel } from '../../src/main/transcription/engines/transcription-engine';

/**
 * SherpaOnlineEngine, the streaming Zipformer transducer that drives the default
 * live preview. It is the one engine that decodes synchronously inside push(),
 * reuses a single OnlineStream for the whole utterance, and pads the tail on
 * finalize. None of that had coverage.
 *
 * sherpa-onnx-node is a native addon, so it is mocked. The fake recognizer
 * replays a scripted `isReady` sequence, which is what lets a test prove push()
 * drains the transducer to exhaustion rather than decoding once.
 */

const harness = vi.hoisted(() => ({
  state: {
    createdStreams: 0,
    decodeCalls: 0,
    /** Each entry is one acceptWaveform call's sample count. */
    acceptedLengths: [] as number[],
    inputFinishedCalls: 0,
    /** How many more times isReady() should return true. */
    readyRemaining: 0,
    resultText: '',
  },
}));

vi.mock('sherpa-onnx-node', () => {
  class OnlineStream {
    acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void {
      harness.state.acceptedLengths.push(waveform.samples.length);
    }
    inputFinished(): void {
      harness.state.inputFinishedCalls += 1;
    }
  }

  class OnlineRecognizer {
    createStream(): OnlineStream {
      harness.state.createdStreams += 1;
      return new OnlineStream();
    }
    isReady(): boolean {
      if (harness.state.readyRemaining <= 0) return false;
      harness.state.readyRemaining -= 1;
      return true;
    }
    decode(): void {
      harness.state.decodeCalls += 1;
    }
    getResult(): { text: string } {
      return { text: harness.state.resultText };
    }
  }

  return { OnlineRecognizer, OnlineStream };
});

const { SherpaOnlineEngine } = await import('../../src/main/transcription/engines/sherpa-online-engine');

const MODEL: ResolvedModel = {
  id: 'streaming-zipformer-en',
  engineId: 'sherpa-onnx',
  kind: 'online-transducer',
  paths: { encoder: 'encoder.onnx', decoder: 'decoder.onnx', joiner: 'joiner.onnx', tokens: 'tokens.txt' },
};

function audioFrame(durationMs: number): Int16Array {
  return new Int16Array(16 * durationMs);
}

describe('SherpaOnlineEngine', () => {
  const state = harness.state;
  let onPartial: ReturnType<typeof vi.fn>;
  let options: CreateSessionOptions;

  async function loadedEngine(): Promise<InstanceType<typeof SherpaOnlineEngine>> {
    const engine = new SherpaOnlineEngine();
    await engine.load([MODEL]);
    return engine;
  }

  beforeEach(() => {
    state.createdStreams = 0;
    state.decodeCalls = 0;
    state.acceptedLengths = [];
    state.inputFinishedCalls = 0;
    state.readyRemaining = 0;
    state.resultText = '';
    onPartial = vi.fn();
    options = { sampleRate: 16000, language: 'en', punctuation: false, onPartial };
  });

  it('creates one stream per session and reuses it across pushes', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    expect(state.createdStreams).toBe(1);
    session.push(audioFrame(100));
    session.push(audioFrame(100));
    expect(state.createdStreams).toBe(1);
  });

  it('drains the transducer to exhaustion on each push', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    state.readyRemaining = 3;
    session.push(audioFrame(100));

    expect(state.decodeCalls).toBe(3);
  });

  it('emits a partial when the hypothesis changes', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    state.resultText = 'hello';
    session.push(audioFrame(100));
    state.resultText = 'hello there';
    session.push(audioFrame(100));

    expect(onPartial).toHaveBeenNthCalledWith(1, 'hello');
    expect(onPartial).toHaveBeenNthCalledWith(2, 'hello there');
  });

  it('does not re-emit an unchanged hypothesis', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    state.resultText = 'hello';
    session.push(audioFrame(100));
    session.push(audioFrame(100));
    session.push(audioFrame(100));

    expect(onPartial).toHaveBeenCalledTimes(1);
  });

  it('does not emit an empty hypothesis', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    state.resultText = '';
    session.push(audioFrame(100));

    expect(onPartial).not.toHaveBeenCalled();
  });

  // The transducer holds its last words until more audio arrives, so finalize
  // feeds 0.5s of silence to flush them before reading the result.
  it('pads the tail with half a second of silence and closes the stream on finalize', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    session.push(audioFrame(100));
    state.resultText = '  the whole utterance  ';
    await expect(session.finalize()).resolves.toBe('the whole utterance');

    // 100ms of audio, then 8000 samples of padding (0.5s at 16 kHz).
    expect(state.acceptedLengths).toEqual([1600, 8000]);
    expect(state.inputFinishedCalls).toBe(1);
  });

  it('drains once more after the tail padding', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    state.readyRemaining = 2;
    await session.finalize();

    expect(state.decodeCalls).toBe(2);
  });

  it('refuses to create a session before the model is loaded', () => {
    const engine = new SherpaOnlineEngine();
    expect(() => engine.createSession(options)).toThrow(/not loaded/);
  });

  it('rejects a model set with no usable model', async () => {
    const engine = new SherpaOnlineEngine();
    await expect(engine.load([])).rejects.toThrow(/requires a model/);
  });
});
