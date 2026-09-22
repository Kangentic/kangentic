import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * DictationClient lifecycle contract, mirroring line-count-client.test.ts's
 * and embed-client.test.ts's shape. The real client talks to the
 * kangentic-dictation Electron utilityProcess worker (DESKTOP-X); vitest has
 * no Electron, so 'electron' is mocked with a fork that returns a
 * controllable EventEmitter "child".
 *
 * Unlike LineCountClient/EmbedClient, dictation has no fallback engine: a
 * failed request REJECTS rather than resolving null, so the tests below
 * assert rejection, not a null/empty resolve.
 */

const { mockFork } = vi.hoisted(() => ({ mockFork: vi.fn() }));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: mockFork },
}));

import { DictationClient } from '../../src/main/transcription/dictation-client';
import { UtilityRestartPolicy } from '../../src/main/utility-process/restart-policy';
import { HEAVY_IDLE_SHUTDOWN_MS, WORKER_COMMIT_CEILING_BYTES } from '../../src/main/utility-process/commit-ceiling';
import type { EngineSelection } from '../../src/main/transcription/engines/engine-selection';

// Mirrors the private IDLE_SHUTDOWN_MS in dictation-client.ts: the recycle
// window for a worker that has served a session (and so holds the accurate
// model). A prewarm-only worker is never recycled.
const IDLE_SHUTDOWN_MS = 30 * 60_000;
// Comfortably past the largest UtilityRestartPolicy backoff step.
const BACKOFF_CLEAR_MS = 20_000;
// Past the policy's decay window (5 min).
const DECAY_MS = 5 * 60_000;

const FAKE_SELECTION: EngineSelection = {
  id: 'hybrid',
  info: { id: 'hybrid', displayName: 'Hybrid', streaming: true, punctuation: true, license: 'MIT', requiresModelDownload: true },
  models: [],
  liveModelId: 'streaming-zipformer-en',
  liveModelKind: 'online-transducer',
  finalModelId: null,
  isRemote: false,
  language: 'en',
};

function fakeEnsureEngineRequest() {
  return { engineKey: 'hybrid|streaming-zipformer-en|none|en|||', selection: FAKE_SELECTION, models: [], warmCap: 2 };
}

interface FakeChild extends EventEmitter {
  postMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  stderr?: EventEmitter;
  /** Set by the ceiling tests; the real UtilityProcess carries one. */
  pid?: number;
}

const forkedChildren: FakeChild[] = [];

function makeFakeChild(withStderr = false): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.postMessage = vi.fn();
  child.kill = vi.fn();
  if (withStderr) child.stderr = new EventEmitter();
  return child;
}

function lastChild(): FakeChild {
  return forkedChildren[forkedChildren.length - 1];
}

/** The id the client assigned to its most recent postMessage call. */
function lastRequestId(child: FakeChild): number {
  const lastCall = child.postMessage.mock.calls[child.postMessage.mock.calls.length - 1];
  return (lastCall[0] as { id: number }).id;
}

/** Warm the client's worker: ensureWarm + the worker's result. Returns the
 *  child that served it. */
async function warm(client: DictationClient): Promise<FakeChild> {
  const promise = client.ensureWarm(fakeEnsureEngineRequest());
  const child = lastChild();
  child.emit('message', { type: 'result', id: lastRequestId(child) });
  await promise;
  return child;
}

/** Create a session on the current worker (which is what makes it load the
 *  accurate model, and so what makes it worth recycling) and answer it. */
async function serveSession(client: DictationClient, dictationSessionId = 'dictation-1'): Promise<FakeChild> {
  const promise = client.createSession({
    dictationSessionId,
    ...fakeEnsureEngineRequest(),
    sessionOptions: { language: 'en', punctuation: true },
  });
  const child = lastChild();
  child.emit('message', { type: 'result', id: lastRequestId(child) });
  await promise;
  return child;
}

/** End the session the worker is serving. The idle recycle never arms while
 *  a session is open, so a test that expects one must finish the session. */
async function finishSession(client: DictationClient, child: FakeChild, dictationSessionId = 'dictation-1'): Promise<void> {
  const promise = client.finalize(dictationSessionId);
  child.emit('message', { type: 'result', id: lastRequestId(child), text: 'done' });
  await promise;
}

/** Serve one complete session (create + finalize) on the current worker. */
async function serveAndFinish(client: DictationClient): Promise<FakeChild> {
  const child = await serveSession(client);
  await finishSession(client, child);
  return child;
}

describe('DictationClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forkedChildren.length = 0;
    mockFork.mockImplementation(() => {
      const child = makeFakeChild();
      forkedChildren.push(child);
      return child;
    });
  });

  it('forks the worker with stderr piped and stdin/stdout ignored, service name kangentic-dictation', async () => {
    const client = new DictationClient();
    const promise = client.ensureWarm(fakeEnsureEngineRequest());
    const child = lastChild();
    child.emit('message', { type: 'result', id: lastRequestId(child) });
    await promise;

    expect(mockFork).toHaveBeenCalledWith(
      expect.stringContaining('dictation-worker.js'),
      [],
      expect.objectContaining({
        serviceName: 'kangentic-dictation',
        stdio: ['ignore', 'ignore', 'pipe'],
      }),
    );
    client.dispose();
  });

  it('ensureWarm posts a prewarm request and resolves on a matching result', async () => {
    const client = new DictationClient();
    const promise = client.ensureWarm(fakeEnsureEngineRequest());
    const child = lastChild();
    const id = lastRequestId(child);

    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'prewarm', id, engineKey: 'hybrid|streaming-zipformer-en|none|en|||' }),
    );
    child.emit('message', { type: 'result', id });
    await expect(promise).resolves.toBeUndefined();
    client.dispose();
  });

  it('createSession posts a createSession request carrying dictationSessionId and sessionOptions, then routes partials by that id', async () => {
    const client = new DictationClient();
    const partials: Array<[string, string]> = [];
    client.on('partial', (dictationSessionId: string, text: string) => partials.push([dictationSessionId, text]));

    const promise = client.createSession({
      dictationSessionId: 'dictation-1',
      ...fakeEnsureEngineRequest(),
      sessionOptions: { language: 'en', punctuation: true },
    });
    const child = lastChild();
    const id = lastRequestId(child);
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'createSession',
        id,
        dictationSessionId: 'dictation-1',
        sessionOptions: { language: 'en', punctuation: true },
      }),
    );

    // A partial can arrive before the createSession result resolves (the
    // worker posts it from inside the session's onPartial callback, wired up
    // before the createSession handler's own 'result' post).
    child.emit('message', { type: 'partial', dictationSessionId: 'dictation-1', text: 'hel' });
    child.emit('message', { type: 'result', id });
    await promise;
    child.emit('message', { type: 'partial', dictationSessionId: 'dictation-1', text: 'hello' });

    expect(partials).toEqual([
      ['dictation-1', 'hel'],
      ['dictation-1', 'hello'],
    ]);
    client.dispose();
  });

  it('push posts the pcm buffer fire-and-forget, with no id (no round trip)', () => {
    // No transfer list: Electron's UtilityProcess.postMessage accepts only
    // MessagePortMain[] there, not ArrayBuffer[] - unlike a browser
    // MessagePort it has no zero-copy transfer, so this is a plain
    // structured-clone copy.
    const client = new DictationClient();
    client.ensureWarm(fakeEnsureEngineRequest()).catch(() => {});
    const child = lastChild();
    child.postMessage.mockClear();

    const pcm = new Int16Array([1, 2, 3]);
    client.push('dictation-1', pcm);

    expect(child.postMessage).toHaveBeenCalledTimes(1);
    const [message] = child.postMessage.mock.calls[0] as [
      { type: string; dictationSessionId: string; pcm: ArrayBuffer; id?: number },
    ];
    expect(message.type).toBe('push');
    expect(message.dictationSessionId).toBe('dictation-1');
    expect(message.id).toBeUndefined();
    expect(new Int16Array(message.pcm)).toEqual(pcm);
    client.dispose();
  });

  it('push is a silent no-op when the worker was never spawned', () => {
    const client = new DictationClient();
    expect(() => client.push('dictation-1', new Int16Array([1]))).not.toThrow();
    expect(mockFork).not.toHaveBeenCalled();
  });

  it('finalize posts a finalize request and resolves with the returned text', async () => {
    const client = new DictationClient();
    const ensurePromise = client.ensureWarm(fakeEnsureEngineRequest());
    const child = lastChild();
    child.emit('message', { type: 'result', id: lastRequestId(child) });
    await ensurePromise;

    const promise = client.finalize('dictation-1');
    const id = lastRequestId(child);
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'finalize', id, dictationSessionId: 'dictation-1' }),
    );
    child.emit('message', { type: 'result', id, text: 'the finalized utterance' });

    await expect(promise).resolves.toBe('the finalized utterance');
    client.dispose();
  });

  it('finalize REJECTS (never resolves empty) when the worker is unavailable - dictation has no fallback engine', async () => {
    const client = new DictationClient();
    await expect(client.finalize('never-started')).rejects.toThrow(/unavailable/i);
    expect(mockFork).not.toHaveBeenCalled();
  });

  it('finalize rejects when the worker replies with an error for the request', async () => {
    const client = new DictationClient();
    const ensurePromise = client.ensureWarm(fakeEnsureEngineRequest());
    const child = lastChild();
    child.emit('message', { type: 'result', id: lastRequestId(child) });
    await ensurePromise;

    const promise = client.finalize('dictation-1');
    const id = lastRequestId(child);
    child.emit('message', { type: 'error', id, message: 'The dictation worker restarted before this session finished' });

    await expect(promise).rejects.toThrow('The dictation worker restarted before this session finished');
    client.dispose();
  });

  it('finalize rejects when the request times out with no reply', async () => {
    const client = new DictationClient();
    const ensurePromise = client.ensureWarm(fakeEnsureEngineRequest());
    const child = lastChild();
    child.emit('message', { type: 'result', id: lastRequestId(child) });
    await ensurePromise;

    vi.useFakeTimers();
    try {
      const promise = client.finalize('dictation-1');
      // Swallow the rejection assertion target before advancing timers, so
      // the unhandled-rejection window between the timer firing and the
      // assertion attaching cannot flake.
      const assertion = expect(promise).rejects.toThrow(/did not respond in time/);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
      client.dispose();
    }
  });

  it('cancel posts a cancel message and is a no-op when the worker was never spawned', () => {
    const client = new DictationClient();
    expect(() => client.cancel('dictation-1')).not.toThrow();
    expect(mockFork).not.toHaveBeenCalled();

    client.ensureWarm(fakeEnsureEngineRequest()).catch(() => {});
    const child = lastChild();
    child.postMessage.mockClear();
    client.cancel('dictation-1');
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'cancel', dictationSessionId: 'dictation-1' });
    client.dispose();
  });

  it('disposeWarm posts a disposeWarm message, a no-op when the worker was never spawned', () => {
    const client = new DictationClient();
    expect(() => client.disposeWarm()).not.toThrow();
    expect(mockFork).not.toHaveBeenCalled();

    client.ensureWarm(fakeEnsureEngineRequest()).catch(() => {});
    const child = lastChild();
    child.postMessage.mockClear();
    client.disposeWarm();
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'disposeWarm' });
    client.dispose();
  });

  it('rejects in-flight requests on an unexpected worker exit and disables offload after MAX_CRASHES', async () => {
    vi.useFakeTimers();
    try {
      const client = new DictationClient();

      for (let cycle = 0; cycle < 3; cycle++) {
        const promise = client.ensureWarm(fakeEnsureEngineRequest());
        const assertion = expect(promise).rejects.toThrow(/exited unexpectedly/);
        lastChild().emit('exit');
        await assertion;
        await vi.advanceTimersByTimeAsync(BACKOFF_CLEAR_MS);
      }

      expect(client.crashed).toBe(true);
      expect(mockFork).toHaveBeenCalledTimes(3);

      await expect(client.ensureWarm(fakeEnsureEngineRequest())).rejects.toThrow(/unavailable/i);
      expect(mockFork).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to respawn immediately after a crash, and recovers once the backoff elapses', async () => {
    vi.useFakeTimers();
    try {
      const client = new DictationClient();

      const first = client.ensureWarm(fakeEnsureEngineRequest());
      const firstAssertion = expect(first).rejects.toThrow(/exited unexpectedly/);
      lastChild().emit('exit');
      await firstAssertion;
      expect(mockFork).toHaveBeenCalledTimes(1);

      await expect(client.ensureWarm(fakeEnsureEngineRequest())).rejects.toThrow(/unavailable/i);
      expect(mockFork).toHaveBeenCalledTimes(1);
      expect(client.crashed).toBe(false);

      await vi.advanceTimersByTimeAsync(BACKOFF_CLEAR_MS);
      const recovered = client.ensureWarm(fakeEnsureEngineRequest());
      expect(mockFork).toHaveBeenCalledTimes(2);
      const child = lastChild();
      child.emit('message', { type: 'result', id: lastRequestId(child) });
      await recovered;

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers after the crash count decays, rather than staying dead for the app run', async () => {
    vi.useFakeTimers();
    try {
      const client = new DictationClient();

      for (let cycle = 0; cycle < 3; cycle++) {
        const promise = client.ensureWarm(fakeEnsureEngineRequest());
        const assertion = expect(promise).rejects.toThrow();
        lastChild().emit('exit');
        await assertion;
        await vi.advanceTimersByTimeAsync(BACKOFF_CLEAR_MS);
      }
      expect(client.crashed).toBe(true);

      await vi.advanceTimersByTimeAsync(DECAY_MS);
      expect(client.crashed).toBe(false);

      const promise = client.ensureWarm(fakeEnsureEngineRequest());
      expect(mockFork).toHaveBeenCalledTimes(4);
      const child = lastChild();
      child.emit('message', { type: 'result', id: lastRequestId(child) });
      await promise;

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a stale exit from a killed predecessor so it cannot null a freshly spawned replacement or reject its in-flight request', async () => {
    vi.useFakeTimers();
    try {
      const client = new DictationClient();

      const firstChild = await serveAndFinish(client);

      // Idle recycle: killChild() nulls this.child synchronously. C1's real
      // 'exit' has not fired yet.
      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS);

      const secondPromise = client.ensureWarm(fakeEnsureEngineRequest());
      expect(mockFork).toHaveBeenCalledTimes(2);
      const secondChild = lastChild();
      expect(secondChild).not.toBe(firstChild);

      // C1's stale 'exit' now arrives, after C2 is already tracked and has
      // work in flight.
      firstChild.emit('exit');

      secondChild.emit('message', { type: 'result', id: lastRequestId(secondChild) });
      await secondPromise;
      expect(client.crashed).toBe(false);

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies an exit by the specific child instance being killed, so a crashing replacement is recorded and the predecessor\'s stale exit is not double-recorded as a second crash', async () => {
    vi.useFakeTimers();
    try {
      const policy = new UtilityRestartPolicy({ service: 'kangentic-dictation', maxCrashes: 3 });
      const recordCrashSpy = vi.spyOn(policy, 'recordCrash');
      const client = new DictationClient(policy);

      const firstChild = await serveAndFinish(client);

      // Idle recycle: killChild() records C1 as the intentional kill and
      // nulls this.child synchronously. C1's own 'exit' has not landed yet.
      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS);

      const secondPromise = client.ensureWarm(fakeEnsureEngineRequest());
      const secondChild = lastChild();
      expect(secondChild).not.toBe(firstChild);

      // C2 crashes for real before C1's stale exit arrives - the exact
      // ordering a single shared boolean misclassifies (it would still read
      // "intentional" from C1's kill and skip this genuine crash).
      const secondAssertion = expect(secondPromise).rejects.toThrow(/exited unexpectedly/);
      secondChild.emit('exit', 1);
      await secondAssertion;

      expect(recordCrashSpy).toHaveBeenCalledTimes(1);
      expect(recordCrashSpy.mock.calls[0][0]).toBe(1);

      // C1's stale exit finally lands - it must not be recorded a second
      // time as a crash; it was a deliberate kill.
      firstChild.emit('exit', 0);
      expect(recordCrashSpy).toHaveBeenCalledTimes(1);

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never idle-recycles a prewarm-only worker: it holds only the live model and is the always-on baseline', async () => {
    vi.useFakeTimers();
    try {
      const client = new DictationClient();
      const recycled = vi.fn();
      client.on('recycled', recycled);

      const child = await warm(client);
      // A second prewarm (a model change) is still prewarm-only.
      await warm(client);

      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS * 3);
      expect(child.kill).not.toHaveBeenCalled();
      expect(recycled).not.toHaveBeenCalled();
      expect(mockFork).toHaveBeenCalledTimes(1);

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recycles a worker that served a session after IDLE_SHUTDOWN_MS, emits recycled, and does not count it as a crash', async () => {
    vi.useFakeTimers();
    try {
      const client = new DictationClient();
      const recycled = vi.fn();
      client.on('recycled', recycled);

      const child = await warm(client);
      await serveSession(client);
      // Every request re-arms: a session finalized just before the window
      // ends gets a whole new window.
      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS - 1);
      const finalizePromise = client.finalize('dictation-1');
      child.emit('message', { type: 'result', id: lastRequestId(child), text: 'done' });
      await finalizePromise;
      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS - 1);
      expect(child.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(recycled).toHaveBeenCalledTimes(1);
      child.emit('exit');
      expect(client.crashed).toBe(false);

      // The replacement spawns on the next request, prewarm-only again.
      const nextChild = await warm(client);
      expect(mockFork).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS * 2);
      expect(nextChild.kill).not.toHaveBeenCalled();
      expect(recycled).toHaveBeenCalledTimes(1);

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('release() kills the worker without emitting recycled, rejects in-flight requests as turned off, and arms no timer against the missing child', async () => {
    vi.useFakeTimers();
    try {
      const client = new DictationClient();
      const recycled = vi.fn();
      client.on('recycled', recycled);

      const child = await warm(client);
      await serveSession(client);
      const inFlight = client.ensureWarm(fakeEnsureEngineRequest());
      const assertion = expect(inFlight).rejects.toThrow('Dictation was turned off');

      client.release();

      await assertion;
      expect(child.kill).toHaveBeenCalledTimes(1);
      child.emit('exit');
      expect(client.crashed).toBe(false);

      // The rejected request's own re-arm found no child; nothing fires.
      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS * 2);
      expect(recycled).not.toHaveBeenCalled();
      expect(mockFork).toHaveBeenCalledTimes(1);

      // Not disposed: the next request spawns afresh.
      await warm(client);
      expect(mockFork).toHaveBeenCalledTimes(2);

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never fires the idle recycle while a session is open, however long the hold, and arms once the session ends', async () => {
    vi.useFakeTimers();
    try {
      const client = new DictationClient();
      const recycled = vi.fn();
      client.on('recycled', recycled);

      const child = await serveSession(client);
      // Frames travel fire-and-forget and never touch the timer: a hold three
      // windows long must still not be cut down.
      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS * 3);
      expect(child.kill).not.toHaveBeenCalled();
      expect(recycled).not.toHaveBeenCalled();

      const finalizePromise = client.finalize('dictation-1');
      child.emit('message', { type: 'result', id: lastRequestId(child), text: 'done' });
      await finalizePromise;
      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(recycled).toHaveBeenCalledTimes(1);

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cancelled session ends for the recycle too', async () => {
    vi.useFakeTimers();
    try {
      const client = new DictationClient();
      const child = await serveSession(client);
      client.cancel('dictation-1');
      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS);
      expect(child.kill).toHaveBeenCalledTimes(1);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('commit ceiling', () => {
    async function serveWithCommit(commitBytes: number | null): Promise<{ client: DictationClient; child: FakeChild; recycled: ReturnType<typeof vi.fn> }> {
      const readCommitBytes = vi.fn((pid: number) => (pid === 4242 ? commitBytes : null));
      const client = new DictationClient(undefined, { readCommitBytes });
      const recycled = vi.fn();
      client.on('recycled', recycled);
      const child = await warm(client);
      child.pid = 4242;
      await serveSession(client);
      await finishSession(client, child);
      return { client, child, recycled };
    }

    it('a worker over the ceiling is recycled at the short window', async () => {
      vi.useFakeTimers();
      try {
        const { client, child, recycled } = await serveWithCommit(WORKER_COMMIT_CEILING_BYTES + 1);
        await vi.advanceTimersByTimeAsync(HEAVY_IDLE_SHUTDOWN_MS - 1);
        expect(child.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(recycled).toHaveBeenCalledTimes(1);
        client.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a worker under the ceiling keeps the long window', async () => {
      vi.useFakeTimers();
      try {
        const { client, child } = await serveWithCommit(WORKER_COMMIT_CEILING_BYTES - 1);
        await vi.advanceTimersByTimeAsync(HEAVY_IDLE_SHUTDOWN_MS * 2);
        expect(child.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS - HEAVY_IDLE_SHUTDOWN_MS * 2);
        expect(child.kill).toHaveBeenCalledTimes(1);
        client.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a worker exactly at the ceiling keeps the long window - the comparison is strict', async () => {
      // Existing cases here only ever use ceiling+1 and ceiling-1, so a `>`
      // flipped to `>=` would pass both of them unnoticed. This pins the
      // boundary value itself.
      vi.useFakeTimers();
      try {
        const { client, child } = await serveWithCommit(WORKER_COMMIT_CEILING_BYTES);
        await vi.advanceTimersByTimeAsync(HEAVY_IDLE_SHUTDOWN_MS * 2);
        expect(child.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS - HEAVY_IDLE_SHUTDOWN_MS * 2);
        expect(child.kill).toHaveBeenCalledTimes(1);
        client.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a pid missing from the process table keeps the long window', async () => {
      vi.useFakeTimers();
      try {
        const { client, child } = await serveWithCommit(null);
        await vi.advanceTimersByTimeAsync(HEAVY_IDLE_SHUTDOWN_MS * 2);
        expect(child.kill).not.toHaveBeenCalled();
        client.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('a crash clears the idle timer and the served-session mark, so the replacement prewarm-only worker is not recycled and no phantom recycled fires', async () => {
    vi.useFakeTimers();
    try {
      const client = new DictationClient();
      const recycled = vi.fn();
      client.on('recycled', recycled);

      await serveAndFinish(client);
      // The timer is armed against C1. C1 crashes...
      lastChild().emit('exit', 1);
      await vi.advanceTimersByTimeAsync(BACKOFF_CLEAR_MS);

      // ...and the replacement is prewarm-only.
      const replacement = await warm(client);
      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS * 2);

      expect(replacement.kill).not.toHaveBeenCalled();
      expect(recycled).not.toHaveBeenCalled();

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() kills the worker, rejects pending requests, and refuses further work', async () => {
    const client = new DictationClient();
    const promise = client.ensureWarm(fakeEnsureEngineRequest());
    const child = lastChild();
    const assertion = expect(promise).rejects.toThrow('The dictation worker was shut down');

    client.dispose();

    await assertion;
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(client.ensureWarm(fakeEnsureEngineRequest())).rejects.toThrow(/unavailable/i);
    expect(mockFork).toHaveBeenCalledTimes(1);
  });

  it("hands the worker's captured stderr to the restart policy on an unexpected exit", async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mockFork.mockImplementation(() => {
        const child = makeFakeChild(true);
        forkedChildren.push(child);
        return child;
      });
      const policy = new UtilityRestartPolicy({ service: 'kangentic-dictation', maxCrashes: 3 });
      const recordCrashSpy = vi.spyOn(policy, 'recordCrash');
      const client = new DictationClient(policy);
      const promise = client.ensureWarm(fakeEnsureEngineRequest());
      const child = lastChild();
      const assertion = expect(promise).rejects.toThrow();

      child.stderr?.emit('data', Buffer.from('Error: worker blew up\n'));
      child.emit('exit', 1);
      await assertion;

      expect(recordCrashSpy).toHaveBeenCalledTimes(1);
      const [exitCode, stderrTail] = recordCrashSpy.mock.calls[0];
      expect(exitCode).toBe(1);
      expect(stderrTail?.snapshot()).toBe('Error: worker blew up');
      expect(policy.lastCrashDescription).toBe('exited with code 1: Error: worker blew up');
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('degrades to rejection and records the crash with no stderr tail when utilityProcess.fork() itself throws', async () => {
    const forkError = new Error('spawn ENOENT');
    mockFork.mockImplementationOnce(() => {
      throw forkError;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const policy = new UtilityRestartPolicy({ service: 'kangentic-dictation', maxCrashes: 3 });
    const recordCrashSpy = vi.spyOn(policy, 'recordCrash');
    const client = new DictationClient(policy);

    await expect(client.ensureWarm(fakeEnsureEngineRequest())).rejects.toThrow(/unavailable/i);

    expect(mockFork).toHaveBeenCalledTimes(1);
    expect(recordCrashSpy).toHaveBeenCalledTimes(1);
    expect(recordCrashSpy).toHaveBeenCalledWith(null);
    expect(client.crashed).toBe(false);
    warnSpy.mockRestore();
  });
});
