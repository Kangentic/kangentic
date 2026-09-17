import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * dictation-worker.ts message-protocol contract, mirroring
 * embed-worker.test.ts's shape. This is the worker half of DESKTOP-X's fix:
 * the process boundary is only worth anything if the warm-engine LRU and
 * active-session bookkeeping that used to live on TranscriptionService
 * (main) behave identically now that they live here.
 *
 * The real file runs inside an Electron utilityProcess and talks over
 * `process.parentPort`; vitest has neither, so this fakes it the same way
 * embed-worker.test.ts does. `engines/engine-build.ts` is mocked so no test
 * here touches sherpa-onnx-node (a native binary) - it hands back a
 * fully-controllable fake `TranscriptionEngine` instead, which is what lets
 * these tests assert warm-cache reuse, eviction, and the warmGeneration
 * supersede guard by IDENTITY (the same fake engine object) rather than by
 * inspecting real sherpa state.
 */

const { mockBuildEngine } = vi.hoisted(() => ({ mockBuildEngine: vi.fn() }));

vi.mock('../../src/main/transcription/engines/engine-build', () => ({
  buildEngine: mockBuildEngine,
}));

type FakeParentPort = EventEmitter & { postMessage: ReturnType<typeof vi.fn> };

function makeFakeParentPort(): FakeParentPort {
  const port = new EventEmitter() as FakeParentPort;
  port.postMessage = vi.fn();
  return port;
}

function installParentPort(port: FakeParentPort): void {
  Object.defineProperty(process, 'parentPort', {
    value: port,
    configurable: true,
    writable: true,
  });
}

async function importWorker(): Promise<void> {
  vi.resetModules();
  await import('../../src/main/transcription/dictation-worker');
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeSession {
  push: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

interface FakeEngine {
  load: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  /** Captured from the most recent createSession() call's options.onPartial,
   *  so a test can simulate a live partial firing from inside the engine. */
  lastOnPartial: ((text: string) => void) | null;
}

function makeFakeSession(finalizeText = 'the finalized utterance'): FakeSession {
  return {
    push: vi.fn(),
    finalize: vi.fn(async () => finalizeText),
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeFakeEngine(session: FakeSession = makeFakeSession()): FakeEngine {
  const engine: FakeEngine = {
    load: vi.fn(async () => {}),
    createSession: vi.fn((options: { onPartial: (text: string) => void }) => {
      engine.lastOnPartial = options.onPartial;
      return session;
    }),
    dispose: vi.fn(async () => {}),
    lastOnPartial: null,
  };
  return engine;
}

const FAKE_SELECTION = {
  id: 'hybrid',
  info: { id: 'hybrid', displayName: 'Hybrid', streaming: true, punctuation: true, license: 'MIT', requiresModelDownload: true },
  models: [],
  liveModelId: 'streaming-zipformer-en',
  liveModelKind: 'online-transducer',
  finalModelId: null,
  isRemote: false,
  language: 'en',
};

function ensureEngineFields(engineKey: string, warmCap = 2) {
  return { engineKey, selection: FAKE_SELECTION, models: [], warmCap };
}

describe('dictation-worker', () => {
  beforeEach(() => {
    mockBuildEngine.mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(process, 'parentPort');
  });

  it('createSession builds + loads the engine, creates a session, and replies with a bare result', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const engine = makeFakeEngine();
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', {
      data: {
        type: 'createSession',
        id: 1,
        dictationSessionId: 'dictation-1',
        ...ensureEngineFields('key-a'),
        sessionOptions: { language: 'en', punctuation: true },
      },
    });
    await flush();

    expect(mockBuildEngine).toHaveBeenCalledTimes(1);
    expect(engine.load).toHaveBeenCalledTimes(1);
    expect(engine.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ sampleRate: 16000, language: 'en', punctuation: true }),
    );
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'result', id: 1 });
  });

  it('forwards partials from an active session, and drops one that arrives after finalize/cancel already removed it', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const session = makeFakeSession();
    const engine = makeFakeEngine(session);
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', {
      data: {
        type: 'createSession',
        id: 1,
        dictationSessionId: 'dictation-1',
        ...ensureEngineFields('key-a'),
        sessionOptions: { language: 'en', punctuation: true },
      },
    });
    await flush();

    engine.lastOnPartial?.('hel');
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'partial', dictationSessionId: 'dictation-1', text: 'hel' });

    port.emit('message', { data: { type: 'cancel', dictationSessionId: 'dictation-1' } });
    port.postMessage.mockClear();
    engine.lastOnPartial?.('a late partial after cancel');
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('push forwards a PCM frame to the active session, and is a no-op for an unknown session id', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const session = makeFakeSession();
    const engine = makeFakeEngine(session);
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', {
      data: {
        type: 'createSession',
        id: 1,
        dictationSessionId: 'dictation-1',
        ...ensureEngineFields('key-a'),
        sessionOptions: { language: 'en', punctuation: true },
      },
    });
    await flush();

    const pcm = new Int16Array([1, 2, 3]).buffer;
    port.emit('message', { data: { type: 'push', dictationSessionId: 'dictation-1', pcm } });
    expect(session.push).toHaveBeenCalledTimes(1);
    expect(session.push.mock.calls[0][0]).toEqual(new Int16Array(pcm));

    expect(() =>
      port.emit('message', { data: { type: 'push', dictationSessionId: 'unknown', pcm } }),
    ).not.toThrow();
  });

  it('finalize returns the session text and disposes the session (the engine stays warm)', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const session = makeFakeSession('hello world');
    const engine = makeFakeEngine(session);
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', {
      data: {
        type: 'createSession',
        id: 1,
        dictationSessionId: 'dictation-1',
        ...ensureEngineFields('key-a'),
        sessionOptions: { language: 'en', punctuation: true },
      },
    });
    await flush();

    port.emit('message', { data: { type: 'finalize', id: 2, dictationSessionId: 'dictation-1' } });
    await flush();

    expect(session.finalize).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(engine.dispose).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'result', id: 2, text: 'hello world' });
  });

  it('finalize on an unknown session id (a lost session after a worker restart) reports an error, not empty text', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    await importWorker();

    port.emit('message', { data: { type: 'finalize', id: 9, dictationSessionId: 'never-created' } });
    await flush();

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'error',
      id: 9,
      message: 'The dictation worker restarted before this session finished',
    });
  });

  it('finalize posts an error and still disposes the session when session.finalize() itself throws', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const session = makeFakeSession();
    session.finalize.mockRejectedValue(new Error('decode blew up'));
    const engine = makeFakeEngine(session);
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', {
      data: {
        type: 'createSession',
        id: 1,
        dictationSessionId: 'dictation-1',
        ...ensureEngineFields('key-a'),
        sessionOptions: { language: 'en', punctuation: true },
      },
    });
    await flush();

    port.emit('message', { data: { type: 'finalize', id: 2, dictationSessionId: 'dictation-1' } });
    await flush();

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'error', id: 2, message: 'decode blew up' });
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('cancel disposes the session without finalizing it', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const session = makeFakeSession();
    const engine = makeFakeEngine(session);
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', {
      data: {
        type: 'createSession',
        id: 1,
        dictationSessionId: 'dictation-1',
        ...ensureEngineFields('key-a'),
        sessionOptions: { language: 'en', punctuation: true },
      },
    });
    await flush();

    port.emit('message', { data: { type: 'cancel', dictationSessionId: 'dictation-1' } });

    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.finalize).not.toHaveBeenCalled();
  });

  it('prewarm builds + loads the engine but creates no session', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const engine = makeFakeEngine();
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', { data: { type: 'prewarm', id: 1, ...ensureEngineFields('key-a') } });
    await flush();

    expect(engine.load).toHaveBeenCalledTimes(1);
    expect(engine.createSession).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'result', id: 1 });
  });

  // Disposing an engine while one of its sessions still has a decode on the libuv
  // threadpool is the DESKTOP-X shape. closeSession removes the session from
  // `active` synchronously (so no late push routes into it) but holds the engine
  // until drain() settles.
  it('holds engine disposal until the session has drained', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const session = makeFakeSession();
    let releaseDrain: () => void = () => {};
    (session as unknown as { drain: () => Promise<void> }).drain = vi.fn(
      () => new Promise<void>((resolve) => { releaseDrain = resolve; }),
    );
    const engine = makeFakeEngine(session);
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', {
      data: {
        type: 'createSession',
        id: 1,
        dictationSessionId: 'dictation-1',
        ...ensureEngineFields('key-a'),
        sessionOptions: { language: 'en', punctuation: true },
      },
    });
    await flush();

    port.emit('message', { data: { type: 'disposeWarm' } });
    port.emit('message', { data: { type: 'cancel', dictationSessionId: 'dictation-1' } });
    await flush();

    // The session is closed, but the decode has not settled, so the engine lives.
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(engine.dispose).not.toHaveBeenCalled();

    // A push arriving now must route nowhere: the entry left `active` already.
    port.emit('message', { data: { type: 'push', dictationSessionId: 'dictation-1', pcm: new ArrayBuffer(8) } });
    expect(session.push).not.toHaveBeenCalled();

    releaseDrain();
    await flush();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  // drain() is documented never to reject, but nothing enforces that on a
  // composed session (HybridEngine fans its own drain() out through
  // Promise.all), so closeSession must not let a violation cost the engine.
  it('closeSession still disposes the engine when drain() rejects', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const session = makeFakeSession();
    let rejectDrain: (error: Error) => void = () => {};
    (session as unknown as { drain: () => Promise<void> }).drain = vi.fn(
      () => new Promise<void>((_resolve, reject) => { rejectDrain = reject; }),
    );
    const engine = makeFakeEngine(session);
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', {
      data: {
        type: 'createSession',
        id: 1,
        dictationSessionId: 'dictation-1',
        ...ensureEngineFields('key-a'),
        sessionOptions: { language: 'en', punctuation: true },
      },
    });
    await flush();

    port.emit('message', { data: { type: 'disposeWarm' } });
    port.emit('message', { data: { type: 'cancel', dictationSessionId: 'dictation-1' } });
    await flush();

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(engine.dispose).not.toHaveBeenCalled();

    rejectDrain(new Error('drain blew up'));
    await flush();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('closeSession still disposes the engine when drain() throws synchronously', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const session = makeFakeSession();
    (session as unknown as { drain: () => Promise<void> }).drain = vi.fn(() => {
      throw new Error('drain blew up synchronously');
    });
    const engine = makeFakeEngine(session);
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', {
      data: {
        type: 'createSession',
        id: 1,
        dictationSessionId: 'dictation-1',
        ...ensureEngineFields('key-a'),
        sessionOptions: { language: 'en', punctuation: true },
      },
    });
    await flush();

    port.emit('message', { data: { type: 'disposeWarm' } });
    port.emit('message', { data: { type: 'cancel', dictationSessionId: 'dictation-1' } });
    await flush();

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  // Nothing else bounds a session. A finalize/cancel lost in flight, or main
  // dying mid-hold, used to leave the entry in `active` forever: the engine
  // pinned out of the warm LRU, and the chunked live engine's decode loop still
  // running for the life of the worker.
  it('expires a session that is never finalized or cancelled', async () => {
    vi.useFakeTimers();
    try {
      const port = makeFakeParentPort();
      installParentPort(port);
      const session = makeFakeSession();
      const engine = makeFakeEngine(session);
      mockBuildEngine.mockReturnValue(engine);
      await importWorker();

      port.emit('message', {
        data: {
          type: 'createSession',
          id: 1,
          dictationSessionId: 'dictation-1',
          ...ensureEngineFields('key-a'),
          sessionOptions: { language: 'en', punctuation: true },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(session.cancel).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(session.cancel).toHaveBeenCalledTimes(1);
      expect(session.dispose).toHaveBeenCalledTimes(1);

      // The entry is gone, so a late push routes nowhere and a finalize reports
      // the session as lost rather than hanging. The message names the expiry as
      // its own cause, distinct from a plain worker restart: a finalize for an id
      // this worker never created reports the restart message instead, covered
      // by the "finalize on an unknown session id" test above.
      port.emit('message', { data: { type: 'finalize', id: 2, dictationSessionId: 'dictation-1' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'error',
        id: 2,
        message: 'The dictation session was closed after ten minutes without a finalize',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the expiry when a session finalizes normally', async () => {
    vi.useFakeTimers();
    try {
      const port = makeFakeParentPort();
      installParentPort(port);
      const session = makeFakeSession();
      const engine = makeFakeEngine(session);
      mockBuildEngine.mockReturnValue(engine);
      await importWorker();

      port.emit('message', {
        data: {
          type: 'createSession',
          id: 1,
          dictationSessionId: 'dictation-1',
          ...ensureEngineFields('key-a'),
          sessionOptions: { language: 'en', punctuation: true },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      port.emit('message', { data: { type: 'finalize', id: 2, dictationSessionId: 'dictation-1' } });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      // The expiry must not fire a second teardown on an already-closed session.
      expect(session.cancel).not.toHaveBeenCalled();
      expect(session.dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses the same warm engine for a second request with the same engineKey (no second build)', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const engine = makeFakeEngine();
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', { data: { type: 'prewarm', id: 1, ...ensureEngineFields('key-a') } });
    await flush();
    port.emit('message', { data: { type: 'prewarm', id: 2, ...ensureEngineFields('key-a') } });
    await flush();

    expect(mockBuildEngine).toHaveBeenCalledTimes(1);
    expect(engine.load).toHaveBeenCalledTimes(1);
  });

  it('two in-flight requests for the same engineKey share one load (dedup)', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    let resolveLoad: () => void = () => {};
    const engine = makeFakeEngine();
    engine.load.mockImplementation(() => new Promise<void>((resolve) => { resolveLoad = resolve; }));
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', { data: { type: 'prewarm', id: 1, ...ensureEngineFields('key-a') } });
    port.emit('message', { data: { type: 'prewarm', id: 2, ...ensureEngineFields('key-a') } });
    await flush();

    expect(mockBuildEngine).toHaveBeenCalledTimes(1);
    resolveLoad();
    await flush();

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'result', id: 1 });
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'result', id: 2 });
  });

  it('evicts the least-recently-used warm engine past warmCap, disposing it', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const engineA = makeFakeEngine();
    const engineB = makeFakeEngine();
    const engineC = makeFakeEngine();
    mockBuildEngine.mockReturnValueOnce(engineA).mockReturnValueOnce(engineB).mockReturnValueOnce(engineC);
    await importWorker();

    port.emit('message', { data: { type: 'prewarm', id: 1, ...ensureEngineFields('key-a', 2) } });
    await flush();
    port.emit('message', { data: { type: 'prewarm', id: 2, ...ensureEngineFields('key-b', 2) } });
    await flush();
    // A third distinct engine over a cap of 2 evicts the oldest (key-a).
    port.emit('message', { data: { type: 'prewarm', id: 3, ...ensureEngineFields('key-c', 2) } });
    await flush();

    expect(engineA.dispose).toHaveBeenCalledTimes(1);
    expect(engineB.dispose).not.toHaveBeenCalled();
    expect(engineC.dispose).not.toHaveBeenCalled();
  });

  it('disposeWarm releases every warm engine, but leaves one still serving an active session until finalize/cancel', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const session = makeFakeSession();
    const engine = makeFakeEngine(session);
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', {
      data: {
        type: 'createSession',
        id: 1,
        dictationSessionId: 'dictation-1',
        ...ensureEngineFields('key-a'),
        sessionOptions: { language: 'en', punctuation: true },
      },
    });
    await flush();

    port.emit('message', { data: { type: 'disposeWarm' } });
    expect(engine.dispose).not.toHaveBeenCalled();

    port.emit('message', { data: { type: 'cancel', dictationSessionId: 'dictation-1' } });
    // The session leaves `active` synchronously, but the engine is only released
    // once closeSession's drain settles, so this needs a turn.
    await flush();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('warmGeneration: a load that completes after disposeWarm() ran mid-load is not re-cached, and is disposed once no session claims it', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    let resolveLoad: () => void = () => {};
    const engine = makeFakeEngine();
    engine.load.mockImplementation(() => new Promise<void>((resolve) => { resolveLoad = resolve; }));
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', { data: { type: 'prewarm', id: 1, ...ensureEngineFields('key-a') } });
    // disposeWarm() runs while the load above is still in flight.
    port.emit('message', { data: { type: 'disposeWarm' } });

    resolveLoad();
    await flush();

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'result', id: 1 });
    // Not cached (a fresh prewarm for the same key builds a NEW engine)...
    const engineAfter = makeFakeEngine();
    mockBuildEngine.mockReturnValue(engineAfter);
    port.emit('message', { data: { type: 'prewarm', id: 2, ...ensureEngineFields('key-a') } });
    await flush();
    expect(mockBuildEngine).toHaveBeenCalledTimes(2);
    // ...and the superseded engine, claimed by nothing, was disposed.
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('createSession claims an engine superseded mid-load by disposeWarm(), and never disposes it before creating the session', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    let resolveLoad: () => void = () => {};
    const session = makeFakeSession('reclaimed utterance');
    // Records dispose/createSession in the order they actually run, rather
    // than a single boolean, so a reordering (dispose BEFORE createSession)
    // is caught even though both eventually happen.
    const callOrder: string[] = [];
    const engine: FakeEngine = {
      load: vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve; })),
      createSession: vi.fn((options: { onPartial: (text: string) => void }) => {
        callOrder.push('createSession');
        engine.lastOnPartial = options.onPartial;
        return session;
      }),
      dispose: vi.fn(async () => {
        callOrder.push('dispose');
      }),
      lastOnPartial: null,
    };
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', {
      data: {
        type: 'createSession',
        id: 1,
        dictationSessionId: 'dictation-1',
        ...ensureEngineFields('key-a'),
        sessionOptions: { language: 'en', punctuation: true },
      },
    });
    // disposeWarm() bumps warmGeneration while this createSession's own load
    // is still in flight - the use-after-dispose hole: the engine is not in
    // `warm` or `active` yet, so a caller-side dispose here would hand
    // handleCreateSession an already-disposed engine to build the session on.
    port.emit('message', { data: { type: 'disposeWarm' } });

    resolveLoad();
    await flush();

    expect(callOrder).toEqual(['createSession']);
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'result', id: 1 });

    // The engine is claimed into `active`: a normal finalize proves it
    // rather than reaching into worker-private state, and disposes it
    // afterward since it was never warm-cached.
    port.emit('message', { data: { type: 'finalize', id: 2, dictationSessionId: 'dictation-1' } });
    await flush();
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'result', id: 2, text: 'reclaimed utterance' });
    expect(callOrder).toEqual(['createSession', 'dispose']);
  });

  it('a superseded bare prewarm disposes its orphaned engine only after a deferred tick, never eagerly inside ensureEngine', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    let resolveLoad: () => void = () => {};
    const engine = makeFakeEngine();
    engine.load.mockImplementation(() => new Promise<void>((resolve) => { resolveLoad = resolve; }));
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    // Snapshots how many times dispose has run at the moment the prewarm's
    // own result is posted - a synchronous, eager dispose inside ensureEngine
    // (the old, buggy shape) would already show up as 1 here.
    const disposeCallsWhenResultPosted: number[] = [];
    port.postMessage.mockImplementation((message: { type: string; id?: number }) => {
      if (message.type === 'result' && message.id === 1) {
        disposeCallsWhenResultPosted.push(engine.dispose.mock.calls.length);
      }
    });

    port.emit('message', { data: { type: 'prewarm', id: 1, ...ensureEngineFields('key-a') } });
    // disposeWarm() runs while this prewarm's own load is still in flight,
    // superseding it. Nothing claims the engine, so it is an orphan that
    // handleEnsureWarm must dispose - but only from its deferred
    // setImmediate, never eagerly inside ensureEngine.
    port.emit('message', { data: { type: 'disposeWarm' } });

    resolveLoad();
    await flush();

    expect(disposeCallsWhenResultPosted).toEqual([0]);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('a load shared by an in-flight prewarm and createSession for the same engineKey, once superseded, ends with the engine claimed rather than disposed', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    let resolveLoad: () => void = () => {};
    const session = makeFakeSession('shared load utterance');
    const engine: FakeEngine = {
      load: vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve; })),
      createSession: vi.fn((options: { onPartial: (text: string) => void }) => {
        engine.lastOnPartial = options.onPartial;
        return session;
      }),
      dispose: vi.fn(async () => {}),
      lastOnPartial: null,
    };
    mockBuildEngine.mockReturnValue(engine);
    await importWorker();

    port.emit('message', { data: { type: 'prewarm', id: 1, ...ensureEngineFields('key-a') } });
    port.emit('message', {
      data: {
        type: 'createSession',
        id: 2,
        dictationSessionId: 'dictation-1',
        ...ensureEngineFields('key-a'),
        sessionOptions: { language: 'en', punctuation: true },
      },
    });
    // Both requests join the same in-flight load; disposeWarm() supersedes
    // it before that load resolves.
    port.emit('message', { data: { type: 'disposeWarm' } });

    resolveLoad();
    await flush();
    // The bare prewarm side has no claim and defers an orphan-disposal check
    // via setImmediate - let that tick actually run before asserting.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockBuildEngine).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'result', id: 1 });
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'result', id: 2 });
    expect(engine.createSession).toHaveBeenCalledTimes(1);
    // createSession claimed the very same engine into `active` before the
    // deferred check ran, so the "orphan" disposal must not have fired.
    expect(engine.dispose).not.toHaveBeenCalled();

    port.emit('message', { data: { type: 'finalize', id: 3, dictationSessionId: 'dictation-1' } });
    await flush();
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'result', id: 3, text: 'shared load utterance' });
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed message rather than throwing', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    await importWorker();

    expect(() => port.emit('message', { data: null })).not.toThrow();
    expect(() => port.emit('message', { data: 'not an object' })).not.toThrow();
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('shutdown calls process.exit(0) rather than returning to let the worker\'s own environment tear down', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    await importWorker();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never));
    try {
      port.emit('message', { data: { type: 'shutdown' } });
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
