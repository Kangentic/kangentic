import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CreateSessionOptions, ResolvedModel } from '../../src/main/transcription/engines/transcription-engine';

/**
 * The real HybridEngine driving the real ChunkedOfflineEngine and the real
 * SherpaWhisperEngine, which is the composition `buildEngine` produces whenever
 * the live slot is an offline model.
 *
 * It exists because the other suites fake exactly this seam:
 * hybrid-engine.test.ts stubs both sub-engines, and chunked-offline-engine.test.ts
 * drives the chunked session directly with no hybrid above it. So nothing proved
 * that hybrid's finalize (which now CANCELS the live slot rather than finalizing
 * it) composes correctly with the chunked session's decode loop and drain.
 *
 * The two slots are told apart by their configs rather than by creation order,
 * because HybridEngine.load() runs both in a Promise.all and the resolution order
 * is not guaranteed. Live is a NeMo transducer, final is Whisper, which is a real
 * configuration and gives each recognizer a distinguishable config shape.
 */

type SlotName = 'live' | 'final';

const harness = vi.hoisted(() => ({
  state: {
    /** One entry per decode, in order, tagged with the slot that ran it. */
    decodes: [] as Array<{ slot: SlotName; sampleCount: number }>,
    /** Resolvers for decodes parked by the slot in `manual`. */
    pending: [] as Array<{ slot: SlotName; resolve: (text: string) => void }>,
    /** Which slot's decodes hang until the test resolves them. */
    manual: null as SlotName | null,
    concurrentBySlot: { live: 0, final: 0 } as Record<SlotName, number>,
    maxConcurrentBySlot: { live: 0, final: 0 } as Record<SlotName, number>,
    liveText: 'the live hypothesis',
    finalText: 'the committed text',
    finalThrows: false,
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
    slot: SlotName = 'final';

    static async createAsync(config: unknown): Promise<OfflineRecognizer> {
      const recognizer = new OfflineRecognizer();
      // The live slot is the NeMo transducer, the final slot is Whisper.
      const modelConfig = (config as { modelConfig?: { transducer?: unknown } }).modelConfig;
      recognizer.slot = modelConfig?.transducer ? 'live' : 'final';
      return recognizer;
    }

    createStream(): OfflineStream {
      return new OfflineStream();
    }

    decodeAsync(stream: OfflineStream): Promise<{ text: string }> {
      const { state } = harness;
      const slot = this.slot;
      state.decodes.push({ slot, sampleCount: stream.sampleCount });
      state.concurrentBySlot[slot] += 1;
      state.maxConcurrentBySlot[slot] = Math.max(state.maxConcurrentBySlot[slot], state.concurrentBySlot[slot]);

      const settle = (): void => {
        state.concurrentBySlot[slot] -= 1;
      };

      if (slot === 'final' && state.finalThrows) {
        settle();
        return Promise.reject(new Error('the final model failed'));
      }
      if (state.manual === slot) {
        return new Promise<{ text: string }>((resolve) => {
          state.pending.push({
            slot,
            resolve: (text) => {
              settle();
              resolve({ text });
            },
          });
        });
      }
      settle();
      return Promise.resolve({ text: slot === 'live' ? state.liveText : state.finalText });
    }
  }

  return { OfflineRecognizer, OfflineStream };
});

const { HybridEngine } = await import('../../src/main/transcription/engines/hybrid-engine');
const { ChunkedOfflineEngine } = await import('../../src/main/transcription/engines/chunked-offline-engine');
const { SherpaWhisperEngine } = await import('../../src/main/transcription/engines/sherpa-whisper-engine');

const LIVE_MODEL: ResolvedModel = {
  id: 'parakeet-tdt-0.6b-en',
  engineId: 'whisper-cpp',
  kind: 'offline-nemo-transducer',
  paths: { encoder: 'e.onnx', decoder: 'd.onnx', joiner: 'j.onnx', tokens: 't.txt' },
};

const FINAL_MODEL: ResolvedModel = {
  id: 'whisper-tiny-en',
  engineId: 'whisper-cpp',
  kind: 'offline-whisper',
  paths: { encoder: 'enc.onnx', decoder: 'dec.onnx', tokens: 'tok.txt' },
};

function audioFrame(durationMs: number): Int16Array {
  return new Int16Array(16 * durationMs);
}

describe('hybrid + chunked live slot (real engines)', () => {
  const state = harness.state;
  let onPartial: ReturnType<typeof vi.fn>;
  let options: CreateSessionOptions;

  async function loadedHybrid(): Promise<InstanceType<typeof HybridEngine>> {
    const engine = new HybridEngine({
      live: { factory: () => new ChunkedOfflineEngine('en'), modelId: LIVE_MODEL.id },
      final: { factory: () => new SherpaWhisperEngine('en'), modelId: FINAL_MODEL.id },
    });
    await engine.load([LIVE_MODEL, FINAL_MODEL]);
    return engine;
  }

  beforeEach(() => {
    state.decodes = [];
    state.pending = [];
    state.manual = null;
    state.concurrentBySlot = { live: 0, final: 0 };
    state.maxConcurrentBySlot = { live: 0, final: 0 };
    state.liveText = 'the live hypothesis';
    state.finalText = 'the committed text';
    state.finalThrows = false;
    onPartial = vi.fn();
    options = { sampleRate: 16000, language: 'en', punctuation: true, onPartial };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes each slot its own model and emits live partials through the hybrid', async () => {
    const engine = await loadedHybrid();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);

    expect(state.decodes).toEqual([{ slot: 'live', sampleCount: 1600 }]);
    expect(onPartial).toHaveBeenCalledWith('the live hypothesis');

    session.cancel();
  });

  // The release path: exactly ONE full-buffer decode, by the final slot. The live
  // slot's own finalize used to run here too and its text was thrown away.
  it('decodes once at release, from the final slot only', async () => {
    const engine = await loadedHybrid();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    expect(state.decodes).toHaveLength(1);

    const committed = await session.finalize();

    expect(committed).toBe('the committed text');
    // One live pass from the tick, then one final decode. No second live decode.
    expect(state.decodes.map((decode) => decode.slot)).toEqual(['live', 'final']);
  });

  it('stops the live decode loop on finalize', async () => {
    const engine = await loadedHybrid();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    await session.finalize();
    const afterFinalize = state.decodes.length;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.decodes).toHaveLength(afterFinalize);
  });

  // The orphaned live pass keeps running when finalize cancels it. drain() is what
  // the worker waits on before disposing the engine, so it has to reach through
  // the hybrid into the chunked session.
  it('drains a live pass that was still decoding when finalize cancelled it', async () => {
    state.manual = 'live';
    const engine = await loadedHybrid();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    expect(state.pending).toHaveLength(1);

    // The final slot decodes normally, so finalize resolves while the live pass
    // is still parked on the threadpool.
    await expect(session.finalize()).resolves.toBe('the committed text');

    let drained = false;
    void session.drain?.().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);

    state.pending[0].resolve('the orphaned live pass');
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(true);
    // That pass was still parked when finalize cancelled it, so its text arrives
    // after release. It must be dropped, not pushed as a partial.
    expect(onPartial).not.toHaveBeenCalled();
  });

  it('falls back to the last real live partial when the final slot throws', async () => {
    const engine = await loadedHybrid();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    state.finalThrows = true;

    await expect(session.finalize()).resolves.toBe('the live hypothesis');
  });

  it('never runs two decodes at once on either recognizer', async () => {
    const engine = await loadedHybrid();
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(350);
    await session.finalize();

    expect(state.maxConcurrentBySlot.live).toBe(1);
    expect(state.maxConcurrentBySlot.final).toBe(1);
  });

  it('commits a complete live decode when there is no final slot', async () => {
    const engine = new HybridEngine({
      live: { factory: () => new ChunkedOfflineEngine('en'), modelId: LIVE_MODEL.id },
      final: null,
    });
    await engine.load([LIVE_MODEL]);
    const session = engine.createSession(options);
    session.push(audioFrame(100));

    await vi.advanceTimersByTimeAsync(350);
    const committed = await session.finalize();

    expect(committed).toBe('the live hypothesis');
    // The tick, then the live slot's own finalize decode: with nothing behind it
    // the committed text must be a fresh full-buffer decode, not the last partial.
    expect(state.decodes.map((decode) => decode.slot)).toEqual(['live', 'live']);
  });
});
