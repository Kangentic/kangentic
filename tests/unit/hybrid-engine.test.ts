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
 * The load-bearing case is a final slot whose createSession throws. The live
 * sub-session is built first, so without the try/catch it is never returned and
 * never disposed: a chunked live session's decode loop would then tick for the
 * life of the worker, and dictation-worker.ts's maybeDisposeEngine cannot reach
 * it, because an engine's dispose() only drops its recognizer reference.
 */

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

function makeOptions(): CreateSessionOptions {
  return { sampleRate: 16000, language: 'en', punctuation: true, onPartial: vi.fn() };
}

function model(id: string): ResolvedModel {
  return { id, engineId: 'whisper-cpp', kind: 'offline-nemo-transducer', paths: {} };
}

describe('HybridEngine', () => {
  it('disposes the live sub-session when the final slot fails to start', () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    const failure = new Error('the final model was evicted');
    final.createSession = vi.fn(() => {
      throw failure;
    });

    const engine = new HybridEngine({
      live: { factory: () => live, modelId: 'live-model' },
      final: { factory: () => final, modelId: 'final-model' },
    });

    expect(() => engine.createSession(makeOptions())).toThrow(failure);
    expect(live.session.dispose).toHaveBeenCalledTimes(1);
  });

  it('fans push out to both sub-sessions', () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    const engine = new HybridEngine({
      live: { factory: () => live, modelId: 'live-model' },
      final: { factory: () => final, modelId: 'final-model' },
    });

    const session = engine.createSession(makeOptions());
    const pcm = new Int16Array([1, 2, 3]);
    session.push(pcm);

    expect(live.session.push).toHaveBeenCalledWith(pcm);
    expect(final.session.push).toHaveBeenCalledWith(pcm);
  });

  // The live slot's finalize is a full-buffer decode whose text is read only on
  // the error path below, so paying for it on every release is waste. With the
  // chunked live engine that is about 0.6s of release-to-insert latency after a
  // 30s hold.
  it('cancels the live slot rather than finalizing it when a final slot exists', async () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    const engine = new HybridEngine({
      live: { factory: () => live, modelId: 'live-model' },
      final: { factory: () => final, modelId: 'final-model' },
    });

    const session = engine.createSession(makeOptions());
    await expect(session.finalize()).resolves.toBe('final text');

    expect(live.session.cancel).toHaveBeenCalledTimes(1);
    expect(live.session.finalize).not.toHaveBeenCalled();
  });

  // With nothing behind it the live text IS the committed text, so here it has to
  // be a complete decode and not the last partial.
  it('finalizes the live slot when there is no final slot', async () => {
    const live = makeFakeEngine('live text');
    const engine = new HybridEngine({
      live: { factory: () => live, modelId: 'live-model' },
      final: null,
    });

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
    const engine = new HybridEngine({
      live: { factory: () => live, modelId: 'live-model' },
      final: null,
    });

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
    const engine = new HybridEngine({
      live: { factory: () => live, modelId: 'live-model' },
      final: { factory: () => final, modelId: 'final-model' },
    });

    const session = engine.createSession(makeOptions());
    live.emitPartial('what the user was watching');

    await expect(session.finalize()).resolves.toBe('what the user was watching');
  });

  it('forwards live partials to the caller as well as keeping them', () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    const engine = new HybridEngine({
      live: { factory: () => live, modelId: 'live-model' },
      final: { factory: () => final, modelId: 'final-model' },
    });

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
    const engine = new HybridEngine({
      live: { factory: () => live, modelId: 'live-model' },
      final: { factory: () => final, modelId: 'final-model' },
    });

    const session = engine.createSession(makeOptions());
    await expect(session.finalize()).rejects.toThrow(failure);
  });

  it('drains both sub-sessions', async () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    live.session.drain = vi.fn(async () => undefined);
    final.session.drain = vi.fn(async () => undefined);
    const engine = new HybridEngine({
      live: { factory: () => live, modelId: 'live-model' },
      final: { factory: () => final, modelId: 'final-model' },
    });

    const session = engine.createSession(makeOptions());
    await session.drain?.();

    expect(live.session.drain).toHaveBeenCalledTimes(1);
    expect(final.session.drain).toHaveBeenCalledTimes(1);
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
    const engine = new HybridEngine({
      live: { factory: () => live, modelId: 'live-model' },
      final: { factory: () => final, modelId: 'final-model' },
    });

    const session = engine.createSession(makeOptions());
    await expect(session.drain?.()).resolves.toBeUndefined();
  });

  // The mixed pairing: a streaming live engine (no drain) feeding an offline
  // final engine (has drain, since sherpa-whisper-engine.ts's finalize decode
  // is exactly what drain() has to wait out).
  it('drains cleanly when only the final sub-session implements drain', async () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    final.session.drain = vi.fn(async () => undefined);
    const engine = new HybridEngine({
      live: { factory: () => live, modelId: 'live-model' },
      final: { factory: () => final, modelId: 'final-model' },
    });

    const session = engine.createSession(makeOptions());
    await expect(session.drain?.()).resolves.toBeUndefined();

    expect(final.session.drain).toHaveBeenCalledTimes(1);
  });

  it('routes each resolved model to the slot that asked for it', async () => {
    const live = makeFakeEngine('live text');
    const final = makeFakeEngine('final text');
    const engine = new HybridEngine({
      live: { factory: () => live, modelId: 'live-model' },
      final: { factory: () => final, modelId: 'final-model' },
    });

    await engine.load([model('live-model'), model('final-model')]);

    expect(live.loadedWith).toEqual([model('live-model')]);
    expect(final.loadedWith).toEqual([model('final-model')]);
  });

  it('requires at least one slot', () => {
    expect(() => new HybridEngine({ live: null, final: null })).toThrow(/at least/);
  });
});
