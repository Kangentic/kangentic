import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CreateSessionOptions, ResolvedModel } from '../../src/main/transcription/engines/transcription-engine';

/**
 * ChunkedOfflineEngine's session loop. Nothing else in tests/ ever enters
 * createSession on a sherpa engine (engine-build.test.ts mocks every engine class
 * to a spy, dictation-worker.test.ts mocks engine-build wholesale), so the decode
 * loop, its cadence, and finalize's serialization had no coverage at all.
 *
 * sherpa-onnx-node is a native addon, so it is mocked here. That also covers
 * sherpa-whisper-engine.ts, which the engine imports buildOfflineConfig from and
 * which imports sherpa itself. dictation-out-of-process-boundary.test.ts scans
 * source text for the import, so mocking does not trip it.
 *
 * The fake recognizer runs in one of two modes. By default a decode hangs until
 * the test resolves it by hand (state.pending), which is what lets a test park a
 * decode in flight and then call finalize on top of it. Set state.decodeDurationMs
 * and decodes instead settle after that much FAKE time, which is how the long-hold
 * test models a real-time factor.
 */

interface PendingDecode {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

const harness = vi.hoisted(() => ({
  state: {
    createdStreams: 0,
    decodeCalls: 0,
    concurrent: 0,
    maxConcurrent: 0,
    pending: [] as PendingDecode[],
    /** Sample count handed to each decode, so a test can prove a pass decodes the
     *  whole buffer rather than a trailing window. */
    sampleCounts: [] as number[],
    decodeDurationMs: null as null | ((sampleCount: number) => number),
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
    static async createAsync(): Promise<OfflineRecognizer> {
      return new OfflineRecognizer();
    }

    createStream(): OfflineStream {
      harness.state.createdStreams += 1;
      return new OfflineStream();
    }

    decodeAsync(stream: OfflineStream): Promise<{ text: string }> {
      const { state } = harness;
      state.decodeCalls += 1;
      state.sampleCounts.push(stream.sampleCount);
      state.concurrent += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);

      const duration = state.decodeDurationMs;
      if (!duration) {
        return new Promise<{ text: string }>((resolve, reject) => {
          state.pending.push({
            resolve: (text) => {
              state.concurrent -= 1;
              resolve({ text });
            },
            reject: (error) => {
              state.concurrent -= 1;
              reject(error);
            },
          });
        });
      }
      return new Promise<{ text: string }>((resolve) => {
        setTimeout(
          () => {
            state.concurrent -= 1;
            resolve({ text: 'partial' });
          },
          Math.max(1, Math.round(duration(stream.sampleCount))),
        );
      });
    }
  }

  return { OfflineRecognizer, OfflineStream };
});

const { ChunkedOfflineEngine } = await import('../../src/main/transcription/engines/chunked-offline-engine');

const MODEL: ResolvedModel = {
  id: 'parakeet-tdt-en',
  engineId: 'whisper-cpp',
  kind: 'offline-nemo-transducer',
  paths: { encoder: 'encoder.onnx', decoder: 'decoder.onnx', joiner: 'joiner.onnx', tokens: 'tokens.txt' },
};

/** 16 kHz mono, so 16 samples per millisecond. */
function audioFrame(durationMs: number): Int16Array {
  return new Int16Array(16 * durationMs);
}

describe('ChunkedOfflineEngine', () => {
  const state = harness.state;
  let onPartial: ReturnType<typeof vi.fn>;
  let options: CreateSessionOptions;

  async function loadedEngine(): Promise<InstanceType<typeof ChunkedOfflineEngine>> {
    const engine = new ChunkedOfflineEngine('en');
    await engine.load([MODEL]);
    return engine;
  }

  beforeEach(() => {
    state.createdStreams = 0;
    state.decodeCalls = 0;
    state.concurrent = 0;
    state.maxConcurrent = 0;
    state.pending = [];
    state.sampleCounts = [];
    state.decodeDurationMs = null;
    onPartial = vi.fn();
    options = { sampleRate: 16000, language: 'en', punctuation: true, onPartial };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('decodes on a timer and emits each pass as a partial', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    expect(state.decodeCalls).toBe(1);

    state.pending[0].resolve('  hello there  ');
    await vi.advanceTimersByTimeAsync(0);
    expect(onPartial).toHaveBeenCalledWith('hello there');

    session.cancel();
  });

  it('allocates exactly one stream per decode', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    state.pending[0].resolve('one');
    await vi.advanceTimersByTimeAsync(350);
    state.pending[1].resolve('two');
    await vi.advanceTimersByTimeAsync(0);

    expect(state.decodeCalls).toBe(2);
    expect(state.createdStreams).toBe(2);

    session.cancel();
  });

  it('decodes the whole buffer each pass, never a trailing window', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    session.push(audioFrame(100));
    await vi.advanceTimersByTimeAsync(350);
    state.pending[0].resolve('one');
    await vi.advanceTimersByTimeAsync(0);

    session.push(audioFrame(100));
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    // 100ms then 200ms of audio, at 16 samples per ms.
    expect(state.sampleCounts).toEqual([1600, 3200]);

    session.cancel();
  });

  // The red-green for the bug this change exists to fix. On the previous
  // implementation stop() cleared the interval but never consulted the in-flight
  // decode, so finalize started a second decodeAsync on the same recognizer while
  // the first was still on the threadpool.
  it('never runs two decodes at once, even when finalize lands mid-pass', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    expect(state.decodeCalls).toBe(1);

    const finalized = session.finalize();
    await vi.advanceTimersByTimeAsync(0);

    // finalize must wait the running pass out rather than decode alongside it.
    expect(state.decodeCalls).toBe(1);

    state.pending[0].resolve('live partial');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.decodeCalls).toBe(2);

    state.pending[1].resolve('the committed text');
    await expect(finalized).resolves.toBe('the committed text');
    expect(state.maxConcurrent).toBe(1);
    // The pass that landed after finalize must not revise the live transcript.
    expect(onPartial).not.toHaveBeenCalled();
  });

  it('waits out a failed in-flight pass before the final decode', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    const finalized = session.finalize();
    await vi.advanceTimersByTimeAsync(0);

    state.pending[0].reject(new Error('decode blew up'));
    await vi.advanceTimersByTimeAsync(0);
    state.pending[1].resolve('recovered');

    await expect(finalized).resolves.toBe('recovered');
    expect(state.maxConcurrent).toBe(1);
  });

  // The red-green for the bug finalize()'s own decode used to have: the final
  // pass was never assigned to decodeInFlight, so drain() resolved early even
  // while the longest decode of the utterance was still on the threadpool.
  it('makes the final decode of finalize() drainable, not just a live pass', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    const finalized = session.finalize();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.pending).toHaveLength(1);

    let drained = false;
    void session.drain?.().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);

    state.pending[0].resolve('the committed text');
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(true);

    await expect(finalized).resolves.toBe('the committed text');
  });

  // Ordering matters here. vi.useFakeTimers() fakes Date too, so the fake time
  // has to advance BEFORE the decode resolves. Resolve first and the engine's
  // Date.now() - startedAt is 0, the gap collapses to the floor, and this passes
  // without testing the backoff at all.
  it('scales the gap to how long the last decode took', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(1000);
    state.pending[0].resolve('slow one');
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(999);
    expect(state.decodeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.decodeCalls).toBe(2);

    session.cancel();
  });

  it('keeps the floor when a decode finishes faster than it', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(50);
    state.pending[0].resolve('quick one');
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(349);
    expect(state.decodeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.decodeCalls).toBe(2);

    session.cancel();
  });

  // The duty-cycle regression guard. A fixed 350ms interval saturates once a
  // decode outlasts it: the loop then runs one pass per decode, back to back.
  it('spaces passes out over a long hold instead of saturating', async () => {
    // Measured real-time factor for int8 Parakeet at numThreads 4 on a dev box:
    // a 30s buffer decodes in 563ms. Modelling the real device matters, because
    // the gap only starts stretching once a decode outgrows the 350ms floor, which
    // at this factor happens around 21s of held audio.
    state.decodeDurationMs = (sampleCount) => (sampleCount / 16) * 0.0188;
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    for (let elapsedMs = 0; elapsedMs < 30_000; elapsedMs += 100) {
      session.push(audioFrame(100));
      await vi.advanceTimersByTimeAsync(100);
    }

    // Here that is 69 passes under the fixed interval this replaced and 50 under
    // the adaptive gap. Replaying the same curve outside the harness agrees (72
    // and 51) and puts decode CPU at 16.5s -> 11.2s, duty 55% -> 37%. Fake timers
    // make the count exact, so the band only needs to clear both sides: it fails
    // if the backoff is removed, and its lower bound fails if the loop dies.
    expect(state.decodeCalls).toBeGreaterThan(30);
    expect(state.decodeCalls).toBeLessThan(60);
    expect(state.maxConcurrent).toBe(1);

    session.cancel();
  });

  it('stops decoding after cancel', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    state.pending[0].resolve('one');
    await vi.advanceTimersByTimeAsync(0);

    session.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.decodeCalls).toBe(1);
  });

  // cancel() and dispose() are void in the TranscriptionEngineSession contract,
  // so neither can await. What they can guarantee is that they never ADD to the
  // outstanding napi async work, which is what DESKTOP-X was about: at most the
  // one pass already running, never a second started on the way out.
  it('adds no decode when cancelled mid-pass', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    expect(state.decodeCalls).toBe(1);

    session.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.decodeCalls).toBe(1);

    // Let the orphaned pass land; it must not revise the transcript or reschedule.
    state.pending[0].resolve('a pass that outlived its session');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.decodeCalls).toBe(1);
    expect(state.maxConcurrent).toBe(1);
    expect(onPartial).not.toHaveBeenCalled();
  });

  it('stops decoding after dispose', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    state.pending[0].resolve('one');
    await vi.advanceTimersByTimeAsync(0);

    session.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.decodeCalls).toBe(1);
  });

  it('finalizes an empty buffer without decoding', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    await expect(session.finalize()).resolves.toBe('');
    expect(state.decodeCalls).toBe(0);
    expect(state.createdStreams).toBe(0);
  });

  it('returns the final decode rather than the last partial', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    state.pending[0].resolve('a stale partial');
    await vi.advanceTimersByTimeAsync(0);
    expect(onPartial).toHaveBeenCalledWith('a stale partial');

    session.push(audioFrame(100));
    const finalized = session.finalize();
    await vi.advanceTimersByTimeAsync(0);
    state.pending[1].resolve('the committed text');

    await expect(finalized).resolves.toBe('the committed text');
  });

  // Without this, engine.dispose() only dropped the recognizer reference, and the
  // session closure had already captured it: the loop kept decoding for the life
  // of the worker with nothing able to reach it.
  it('stops a still-running session when the engine is disposed', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    state.pending[0].resolve('one');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.decodeCalls).toBe(1);

    // Note the session is never finalized or cancelled, which is the case that
    // used to leak the loop.
    await engine.dispose();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.decodeCalls).toBe(1);
    expect(onPartial).toHaveBeenCalledTimes(1);
  });

  // Two sessions on one warm engine is reachable in production: main tracks
  // dictation sessions in a Map (TranscriptionService), so two overlapping
  // holds with the same engine config share this engine's warm cache. The
  // single-session dispose test above cannot tell a Set-based `dispose()`
  // (stops every running session) from a naive single-pointer one (only the
  // most recently created session is stoppable) - they only diverge at N>1.
  it('stops every running session when the engine is disposed, not just the most recent one', async () => {
    const engine = await loadedEngine();
    const onPartialA = vi.fn();
    const onPartialB = vi.fn();
    const sessionA = engine.createSession({ ...options, onPartial: onPartialA });
    sessionA.push(audioFrame(100));

    // Stagger session B's start so the two loops are not in lockstep.
    await vi.advanceTimersByTimeAsync(100);
    const sessionB = engine.createSession({ ...options, onPartial: onPartialB });
    sessionB.push(audioFrame(100));

    // Session A's first pass fires 350ms after ITS creation (t=350).
    await vi.advanceTimersByTimeAsync(250);
    expect(state.decodeCalls).toBe(1);
    state.pending[0].resolve('a first');
    await vi.advanceTimersByTimeAsync(0);
    expect(onPartialA).toHaveBeenCalledTimes(1);

    // Session B's first pass fires 350ms after ITS creation (t=450).
    await vi.advanceTimersByTimeAsync(100);
    expect(state.decodeCalls).toBe(2);
    state.pending[1].resolve('b first');
    await vi.advanceTimersByTimeAsync(0);
    expect(onPartialB).toHaveBeenCalledTimes(1);

    await engine.dispose();

    // Both sessions have a pass already scheduled (A at t=700, B at t=800).
    // Neither must fire.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.decodeCalls).toBe(2);
    expect(onPartialA).toHaveBeenCalledTimes(1);
    expect(onPartialB).toHaveBeenCalledTimes(1);
  });

  it('drains the in-flight pass so the engine is never disposed mid-decode', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    session.cancel();

    let drained = false;
    void session.drain?.().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);

    state.pending[0].resolve('the orphaned pass');
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(true);
  });

  it('drain() swallows a rejected live pass rather than rejecting itself', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    expect(state.pending).toHaveLength(1);

    session.cancel();
    const draining = session.drain?.();
    state.pending[0].reject(new Error('decode blew up'));

    await expect(draining).resolves.toBeUndefined();
  });

  it('drains immediately when no pass is running', async () => {
    const engine = await loadedEngine();
    const session = engine.createSession(options);

    await expect(session.drain?.()).resolves.toBeUndefined();
  });

  it('refuses to create a session before the model is loaded', () => {
    const engine = new ChunkedOfflineEngine('en');
    expect(() => engine.createSession(options)).toThrow(/not loaded/);
  });
});
