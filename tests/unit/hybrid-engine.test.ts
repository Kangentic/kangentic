import { describe, it, expect, vi } from 'vitest';
import { HybridEngine } from '../../src/main/transcription/engines/hybrid-engine';
import type {
  CreateSessionOptions,
  ResolvedModel,
  TranscriptionEngine,
  TranscriptionEngineSession,
} from '../../src/main/transcription/engines/transcription-engine';

/**
 * HybridEngine's slot composition. It imports no sherpa, so nothing is mocked
 * here; the sub-engines are plain fakes.
 *
 * The load-bearing cases are the lazy final slot (#706): `load()` warms only
 * the live slot, the accurate model loads on the first session and is fed
 * from a buffer at finalize, and a release that arrives before it is ready
 * commits a full live decode instead of waiting on the client's timeout.
 */

// Mirrors the private FINAL_LOAD_WAIT_MS in hybrid-engine.ts.
const FINAL_LOAD_WAIT_MS = 15_000;

interface FakeSession extends TranscriptionEngineSession {
  push: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

interface FakeEngine extends TranscriptionEngine {
  session: FakeSession;
  loadedWith: ResolvedModel[] | null;
  /** Captured from the most recent createSession, so a test can fire a live
   *  partial the way a real streaming sub-engine would. */
  emitPartial: (text: string) => void;
}

function makeFakeEngine(finalizeText: string): FakeEngine {
  const session: FakeSession = {
    push: vi.fn(),
    finalize: vi.fn(async () => finalizeText),
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
  const engine = {
    info: { id: 'stub', displayName: 'fake', streaming: false, punctuation: false, license: 'MIT', requiresModelDownload: false },
    session,
    loadedWith: null as ResolvedModel[] | null,
    emitPartial: () => undefined,
    load: vi.fn(async (models: ResolvedModel[]) => {
      engine.loadedWith = models;
    }),
    createSession: vi.fn((options: CreateSessionOptions) => {
      engine.emitPartial = options.onPartial;
      return session;
    }),
    dispose: vi.fn(async () => undefined),
  } as unknown as FakeEngine;
  return engine;
}

/** A load the test settles by hand, for the still-loading cases. */
function deferredLoad(engine: FakeEngine): { resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  engine.load = vi.fn(() => gate);
  return { resolve, reject };
}

function makeOptions(): CreateSessionOptions {
  return { sampleRate: 16000, language: 'en', punctuation: true, onPartial: vi.fn() };
}

function model(id: string): ResolvedModel {
  return { id, engineId: 'whisper-cpp', kind: 'offline-nemo-transducer', paths: {} };
}

const BOTH_MODELS = [model('live-model'), model('final-model')];

function makeHybrid(live: FakeEngine | null, final: FakeEngine | null): HybridEngine {
  return new HybridEngine({
    live: live ? { factory: () => live, modelId: 'live-model' } : null,
    final: final ? { factory: () => final, modelId: 'final-model' } : null,
  });
}

/** Flush pending microtasks (a settled load reaching its continuation). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('HybridEngine', () => {
  describe('lazy final slot', () => {
    it('load() loads only the live slot; the final slot loads on the first createSession, once across sessions', async () => {
      const live = makeFakeEngine('live text');
      const final = makeFakeEngine('final text');
      const engine = makeHybrid(live, final);

      await engine.load(BOTH_MODELS);
      expect(live.loadedWith).toEqual([model('live-model')]);
      expect(final.load).not.toHaveBeenCalled();

      engine.createSession(makeOptions());
      expect(final.load).toHaveBeenCalledTimes(1);
      expect(final.loadedWith).toEqual([model('final-model')]);

      engine.createSession(makeOptions());
      expect(final.load).toHaveBeenCalledTimes(1);
    });

    it('buffers pushed frames as copies and replays them into the final sub-session at finalize, in order', async () => {
      const live = makeFakeEngine('live text');
      const final = makeFakeEngine('final text');
      const engine = makeHybrid(live, final);
      await engine.load(BOTH_MODELS);

      const session = engine.createSession(makeOptions());
      const first = new Int16Array([1, 2, 3]);
      const second = new Int16Array([4, 5]);
      session.push(first);
      session.push(second);

      // The live slot sees every frame at once; the final slot sees none yet.
      expect(live.session.push).toHaveBeenCalledTimes(2);
      expect(final.createSession).not.toHaveBeenCalled();
      expect(final.session.push).not.toHaveBeenCalled();

      // A caller that reuses its buffer after push must not corrupt the copy.
      first.fill(0);

      await expect(session.finalize()).resolves.toBe('final text');
      expect(final.createSession).toHaveBeenCalledTimes(1);
      expect(final.session.push.mock.calls.map(([frame]) => Array.from(frame as Int16Array))).toEqual([
        [1, 2, 3],
        [4, 5],
      ]);
    });

    it('creates and feeds the final sub-session before cancelling the live one, so a final createSession throw falls back to a full live decode', async () => {
      const live = makeFakeEngine('live text');
      const final = makeFakeEngine('final text');
      final.createSession = vi.fn(() => {
        throw new Error('the final model was evicted');
      });
      const engine = makeHybrid(live, final);
      await engine.load(BOTH_MODELS);

      const session = engine.createSession(makeOptions());
      session.push(new Int16Array([1]));

      await expect(session.finalize()).resolves.toBe('live text');
      // A chunked live engine's cancel() drops its frames, so the cancel must
      // not have run before the final sub-session was known to exist.
      expect(live.session.cancel).not.toHaveBeenCalled();
      expect(live.session.finalize).toHaveBeenCalledTimes(1);
    });

    it('falls back to a full live decode when the final load is not ready within the wait bound', async () => {
      vi.useFakeTimers();
      try {
        const live = makeFakeEngine('live text');
        const final = makeFakeEngine('final text');
        deferredLoad(final);
        const engine = makeHybrid(live, final);
        await engine.load(BOTH_MODELS);

        const session = engine.createSession(makeOptions());
        const finalizePromise = session.finalize();

        await vi.advanceTimersByTimeAsync(FINAL_LOAD_WAIT_MS - 1);
        expect(live.session.finalize).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await expect(finalizePromise).resolves.toBe('live text');
        expect(final.createSession).not.toHaveBeenCalled();
        expect(live.session.cancel).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('falls back to live when the load the press started already failed, without starting a retry; the next press retries', async () => {
      const live = makeFakeEngine('live text');
      const final = makeFakeEngine('final text');
      final.load = vi.fn(async () => {
        throw new Error('model file missing');
      });
      const engine = makeHybrid(live, final);
      await engine.load(BOTH_MODELS);

      const first = engine.createSession(makeOptions());
      await flush();
      await expect(first.finalize()).resolves.toBe('live text');
      // The release waited on the press's load; it did not kick a second one.
      expect(final.load).toHaveBeenCalledTimes(1);

      const second = engine.createSession(makeOptions());
      expect(final.load).toHaveBeenCalledTimes(2);
      await flush();
      await expect(second.finalize()).resolves.toBe('live text');
    });

    it('with no live slot, waits for the final load past the bound and then commits the accurate text', async () => {
      vi.useFakeTimers();
      try {
        const final = makeFakeEngine('final text');
        const gate = deferredLoad(final);
        const engine = makeHybrid(null, final);
        await engine.load([model('final-model')]);

        const session = engine.createSession(makeOptions());
        session.push(new Int16Array([7]));
        let settled = false;
        const finalizePromise = session.finalize().then((text) => {
          settled = true;
          return text;
        });

        await vi.advanceTimersByTimeAsync(FINAL_LOAD_WAIT_MS * 2);
        expect(settled).toBe(false);

        gate.resolve();
        await expect(finalizePromise).resolves.toBe('final text');
        expect(final.session.push).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('with no live slot, a failed final load is the failure', async () => {
      const final = makeFakeEngine('final text');
      final.load = vi.fn(async () => {
        throw new Error('model file missing');
      });
      const engine = makeHybrid(null, final);
      await engine.load([model('final-model')]);

      const session = engine.createSession(makeOptions());
      await expect(session.finalize()).rejects.toThrow('model file missing');
    });

    it('cancel drops the buffer and never creates the final sub-session', async () => {
      const live = makeFakeEngine('live text');
      const final = makeFakeEngine('final text');
      const engine = makeHybrid(live, final);
      await engine.load(BOTH_MODELS);

      const session = engine.createSession(makeOptions());
      session.push(new Int16Array([1]));
      session.cancel();

      expect(live.session.cancel).toHaveBeenCalledTimes(1);
      expect(final.createSession).not.toHaveBeenCalled();
    });

    it('dispose waits for a pending final load before disposing the final engine, and swallows its rejection', async () => {
      const live = makeFakeEngine('live text');
      const final = makeFakeEngine('final text');
      const gate = deferredLoad(final);
      const engine = makeHybrid(live, final);
      await engine.load(BOTH_MODELS);
      engine.createSession(makeOptions());

      let disposed = false;
      const disposing = engine.dispose().then(() => {
        disposed = true;
      });
      await flush();
      expect(disposed).toBe(false);
      expect(final.dispose).not.toHaveBeenCalled();

      gate.reject(new Error('model file missing'));
      await expect(disposing).resolves.toBeUndefined();
      expect(final.dispose).toHaveBeenCalledTimes(1);
      expect(live.dispose).toHaveBeenCalledTimes(1);
    });
  });

  // The live slot's finalize is a full-buffer decode whose text is read only on
  // the error path below, so paying for it on every release is waste. With the
  // chunked live engine that is about 0.6s of release-to-insert latency after a
  // 30s hold.
  it('cancels the live slot rather than finalizing it once the final sub-session is up', async () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    const engine = makeHybrid(live, final);
    await engine.load(BOTH_MODELS);

    const session = engine.createSession(makeOptions());
    await expect(session.finalize()).resolves.toBe('final text');

    expect(live.session.cancel).toHaveBeenCalledTimes(1);
    expect(live.session.finalize).not.toHaveBeenCalled();
  });

  // With nothing behind it the live text IS the committed text, so here it has to
  // be a complete decode and not the last partial.
  it('finalizes the live slot when there is no final slot', async () => {
    const live = makeFakeEngine('live text');
    const engine = makeHybrid(live, null);

    const session = engine.createSession(makeOptions());
    await expect(session.finalize()).resolves.toBe('live text');
    expect(live.session.finalize).toHaveBeenCalledTimes(1);
    expect(live.session.cancel).not.toHaveBeenCalled();
  });

  // With no final slot there is nothing behind the live decode, so a live
  // finalize that throws used to commit the empty string. The last partial the
  // user watched is closer to a result than nothing.
  it('falls back to the last live partial when the live slot throws and there is no final slot', async () => {
    const live = makeFakeEngine('live text');
    live.session.finalize = vi.fn(async () => {
      throw new Error('the live decode failed');
    });
    const engine = makeHybrid(live, null);

    const session = engine.createSession(makeOptions());
    live.emitPartial('what the user was watching');

    await expect(session.finalize()).resolves.toBe('what the user was watching');
  });

  it('falls back to the last live partial when the final slot throws', async () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    final.session.finalize = vi.fn(async () => {
      throw new Error('the cloud endpoint is not configured');
    });
    const engine = makeHybrid(live, final);
    await engine.load(BOTH_MODELS);

    const session = engine.createSession(makeOptions());
    live.emitPartial('what the user was watching');

    await expect(session.finalize()).resolves.toBe('what the user was watching');
  });

  it('forwards live partials to the caller as well as keeping them', () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    const engine = makeHybrid(live, final);

    const options = makeOptions();
    engine.createSession(options);
    live.emitPartial('a revising hypothesis');

    expect(options.onPartial).toHaveBeenCalledWith('a revising hypothesis');
  });

  it('rethrows when the final slot throws and no live partial ever landed', async () => {
    const live = makeFakeEngine('');
    const final = makeFakeEngine('final text');
    const failure = new Error('the cloud endpoint is not configured');
    final.session.finalize = vi.fn(async () => {
      throw failure;
    });
    const engine = makeHybrid(live, final);
    await engine.load(BOTH_MODELS);

    const session = engine.createSession(makeOptions());
    await expect(session.finalize()).rejects.toThrow(failure);
  });

  // The worker drains a session after its finalize (closeSession), which is
  // when the final sub-session exists to be drained.
  it('drains both sub-sessions once the final one exists', async () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    live.session.drain = vi.fn(async () => undefined);
    final.session.drain = vi.fn(async () => undefined);
    const engine = makeHybrid(live, final);
    await engine.load(BOTH_MODELS);

    const session = engine.createSession(makeOptions());
    await session.finalize();
    await session.drain?.();

    expect(live.session.drain).toHaveBeenCalledTimes(1);
    expect(final.session.drain).toHaveBeenCalledTimes(1);
  });

  it('drains cleanly before the final sub-session exists (a cancelled session)', async () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    live.session.drain = vi.fn(async () => undefined);
    const engine = makeHybrid(live, final);
    await engine.load(BOTH_MODELS);

    const session = engine.createSession(makeOptions());
    session.cancel();
    await expect(session.drain?.()).resolves.toBeUndefined();

    expect(live.session.drain).toHaveBeenCalledTimes(1);
  });

  // The default production shape for both slots: SherpaOnlineEngine (the
  // streaming live engine) and RemoteOpenAiEngine (the cloud final engine)
  // both deliberately omit `drain` (it is optional on the contract - see
  // transcription-engine.ts). Only the two offline engines implement it.
  // `makeFakeEngine`'s session has no `drain` property, so this models that
  // pairing without adding a third fake type.
  it('drains cleanly when neither sub-session implements drain', async () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    const engine = makeHybrid(live, final);
    await engine.load(BOTH_MODELS);

    const session = engine.createSession(makeOptions());
    await session.finalize();
    await expect(session.drain?.()).resolves.toBeUndefined();
  });

  // The mixed pairing: a streaming live engine (no drain) feeding an offline
  // final engine (has drain, since sherpa-whisper-engine.ts's finalize decode
  // is exactly what drain() has to wait out).
  it('drains cleanly when only the final sub-session implements drain', async () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    final.session.drain = vi.fn(async () => undefined);
    const engine = makeHybrid(live, final);
    await engine.load(BOTH_MODELS);

    const session = engine.createSession(makeOptions());
    await session.finalize();
    await expect(session.drain?.()).resolves.toBeUndefined();

    expect(final.session.drain).toHaveBeenCalledTimes(1);
  });

  it('routes each resolved model to the slot that asked for it', async () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    const engine = makeHybrid(live, final);

    await engine.load(BOTH_MODELS);
    expect(live.loadedWith).toEqual([model('live-model')]);

    engine.createSession(makeOptions());
    expect(final.loadedWith).toEqual([model('final-model')]);
  });

  it('requires at least one slot', () => {
    expect(() => new HybridEngine({ live: null, final: null })).toThrow(/at least/);
  });
});
