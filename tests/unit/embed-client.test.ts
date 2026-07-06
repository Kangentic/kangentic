import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * EmbedClient lifecycle + degradation contract.
 *
 * The real client talks to an Electron utilityProcess worker; vitest has no
 * Electron, so 'electron' is mocked with a fork that returns a controllable
 * EventEmitter "child". Every failure path must resolve `null` (never throw) so
 * callers degrade to lexical-only, and the crash cap must disable the layer.
 */

const { mockFork } = vi.hoisted(() => ({ mockFork: vi.fn() }));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app' },
  utilityProcess: { fork: mockFork },
}));

import { EmbedClient, resolveDeviceChain } from '../../src/main/retrieval/embedder/embed-client';
import type { EmbeddingModelDef } from '../../src/shared/embedding-models';

// Mirrors the private IDLE_SHUTDOWN_MS in embed-client.ts.
const IDLE_SHUTDOWN_MS = 5 * 60_000;

const TEST_MODEL: EmbeddingModelDef = {
  id: 'test-model',
  tier: 'balanced',
  hfId: 'Xenova/test-model',
  displayName: 'Test',
  dimensions: 384,
  dtype: 'q8',
  pooling: 'mean',
  approxSizeMb: 24,
  license: 'Apache-2.0',
  queryPrefix: '',
  noiseFloor: 0.45,
  modelTag: 'test-model@q8',
  blurb: 'test',
};

interface FakeChild extends EventEmitter {
  postMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

const forkedChildren: FakeChild[] = [];

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.postMessage = vi.fn();
  child.kill = vi.fn();
  return child;
}

/** Flush pending microtasks (readyPromise -> sendEmbed continuation). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function lastChild(): FakeChild {
  return forkedChildren[forkedChildren.length - 1];
}

/** Bring a fresh client to the point where its worker is spawned and ready. */
async function embedAfterReady(
  client: EmbedClient,
  texts: string[],
  opts?: { timeoutMs?: number },
): Promise<{ promise: Promise<Float32Array[] | null>; child: FakeChild }> {
  const promise = client.embed(texts, opts);
  const child = lastChild();
  child.emit('message', { type: 'ready' });
  await flush();
  return { promise, child };
}

describe('EmbedClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forkedChildren.length = 0;
    mockFork.mockImplementation(() => {
      const child = makeFakeChild();
      forkedChildren.push(child);
      return child;
    });
  });

  it('short-circuits an empty batch to [] without forking', async () => {
    const client = new EmbedClient(TEST_MODEL);
    await expect(client.embed([])).resolves.toEqual([]);
    expect(mockFork).not.toHaveBeenCalled();
  });

  it('forks + inits the worker, and resolves the posted vectors on a ready + result round-trip', async () => {
    const client = new EmbedClient(TEST_MODEL);
    const { promise, child } = await embedAfterReady(client, ['hello']);

    // The worker was forked once and sent an init then the embed request.
    expect(mockFork).toHaveBeenCalledTimes(1);
    expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init' }));
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'embed', id: 1, texts: ['hello'] }),
    );

    const vectors = [new Float32Array([0.1, 0.2, 0.3])];
    child.emit('message', { type: 'result', id: 1, vectors });

    await expect(promise).resolves.toBe(vectors);
    client.dispose();
  });

  it('resolves null when the worker replies with an error for the request', async () => {
    const client = new EmbedClient(TEST_MODEL);
    const { promise, child } = await embedAfterReady(client, ['x']);

    child.emit('message', { type: 'error', id: 1 });

    await expect(promise).resolves.toBeNull();
    client.dispose();
  });

  it('resolves null when the request times out with no reply', async () => {
    const client = new EmbedClient(TEST_MODEL);
    // A tiny per-request budget; no result is emitted, so the timer fires.
    const { promise } = await embedAfterReady(client, ['x'], { timeoutMs: 10 });

    await expect(promise).resolves.toBeNull();
    client.dispose();
  });

  it('resolves null for requests over the queue cap without forking a second worker', async () => {
    const client = new EmbedClient(TEST_MODEL);
    // Fill the queue to its cap (64) with in-flight requests.
    const inFlight: Array<Promise<Float32Array[] | null>> = [];
    for (let index = 0; index < 64; index++) {
      inFlight.push(client.embed([`text-${index}`], { timeoutMs: 5000 }));
    }
    const child = lastChild();
    child.emit('message', { type: 'ready' });
    await flush();

    // The 65th request is rejected by backpressure, resolving null.
    await expect(client.embed(['overflow'])).resolves.toBeNull();
    // Only ever one worker.
    expect(mockFork).toHaveBeenCalledTimes(1);

    client.dispose();
    await Promise.all(inFlight);
  });

  it('resolves in-flight requests null on an unexpected worker exit and disables the layer after MAX_CRASHES', async () => {
    const client = new EmbedClient(TEST_MODEL);

    for (let cycle = 0; cycle < 3; cycle++) {
      const { promise, child } = await embedAfterReady(client, ['x'], { timeoutMs: 5000 });
      child.emit('exit');
      // The pending request resolves null when its worker dies.
      await expect(promise).resolves.toBeNull();
    }

    // Three crashes disable the semantic layer.
    expect(client.crashed).toBe(true);
    expect(mockFork).toHaveBeenCalledTimes(3);

    // Further embeds short-circuit to null without forking again.
    await expect(client.embed(['again'])).resolves.toBeNull();
    expect(mockFork).toHaveBeenCalledTimes(3);
  });

  it('dispose() kills the worker, resolves pending null, and refuses further work', async () => {
    const client = new EmbedClient(TEST_MODEL);
    const { promise, child } = await embedAfterReady(client, ['x'], { timeoutMs: 5000 });

    client.dispose();

    await expect(promise).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledTimes(1);
    // A disposed client never forks or embeds again.
    await expect(client.embed(['later'])).resolves.toBeNull();
    expect(mockFork).toHaveBeenCalledTimes(1);
  });

  it('passes the resolved device chain to the worker and records the active device from ready', async () => {
    const client = new EmbedClient(TEST_MODEL, 'cpu');
    const promise = client.embed(['hello']);
    const child = lastChild();

    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'init', devices: ['cpu'] }),
    );
    // Unknown until the worker reports which provider it initialized on.
    expect(client.activeDevice).toBeNull();

    child.emit('message', { type: 'ready', device: 'cpu' });
    await flush();
    expect(client.activeDevice).toBe('cpu');

    child.emit('message', { type: 'result', id: 1, vectors: [new Float32Array([0.1])] });
    await promise;
    client.dispose();
  });

  it('clears the active device when the worker exits', async () => {
    const client = new EmbedClient(TEST_MODEL, 'cpu');
    const promise = client.embed(['x'], { timeoutMs: 5000 });
    const child = lastChild();

    child.emit('message', { type: 'ready', device: 'cpu' });
    await flush();
    expect(client.activeDevice).toBe('cpu');

    child.emit('exit');
    expect(client.activeDevice).toBeNull();

    await expect(promise).resolves.toBeNull();
    client.dispose();
  });

  it('recycles the worker after an idle timeout without counting it as a crash, and stays usable across repeated cycles', async () => {
    // Guards the `intentionalShutdown` flag: killChild() (armed by the idle
    // timer) must not be miscounted by onWorkerExit() as an unexpected crash.
    // Reverting that guard makes crashCount latch to MAX_CRASHES after exactly
    // 3 idle recycles, which is exactly what this test would then catch.
    vi.useFakeTimers();
    try {
      const client = new EmbedClient(TEST_MODEL);

      for (let cycle = 0; cycle < 4; cycle++) {
        const promise = client.embed(['x']);
        const child = lastChild();
        child.emit('message', { type: 'ready' });
        await vi.advanceTimersByTimeAsync(0);
        child.emit('message', { type: 'result', id: cycle + 1, vectors: [new Float32Array([0.1])] });
        await promise;

        // The idle timer arms once the request settles (armIdleShutdown in
        // embed()'s finally). Advancing past IDLE_SHUTDOWN_MS fires it, which
        // calls killChild() and sets intentionalShutdown before the worker exits.
        await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS);
        // The real utilityProcess emits 'exit' asynchronously after kill();
        // the mock's kill() is a no-op, so simulate that exit explicitly.
        child.emit('exit');
      }

      // Four idle recycles are intentional teardowns, never crashes - the
      // layer must stay available (this is what keeps semantic search alive).
      expect(client.crashed).toBe(false);
      expect(mockFork).toHaveBeenCalledTimes(4);

      // Confirm it is still genuinely usable: the next embed forks a fresh
      // worker and completes normally.
      const finalPromise = client.embed(['still-alive']);
      const finalChild = lastChild();
      finalChild.emit('message', { type: 'ready' });
      await vi.advanceTimersByTimeAsync(0);
      const vectors = [new Float32Array([0.9])];
      finalChild.emit('message', { type: 'result', id: 5, vectors });
      await expect(finalPromise).resolves.toBe(vectors);

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('degrades cleanly to null when the worker reports an init error before ready (no throw)', async () => {
    // An init/model-load failure surfaces as an 'error' message with no `id`,
    // before 'ready'. ensureReady()/embed() must degrade to null without
    // throwing, and the failure must not be silently retried mid-flight.
    const client = new EmbedClient(TEST_MODEL);
    const promise = client.embed(['x']);
    const child = lastChild();

    child.emit('message', { type: 'error', message: 'model load failed' });

    await expect(promise).resolves.toBeNull();

    // The failed init is memoized on the same child + readyPromise; a second
    // embed must still degrade to null without throwing or forking again.
    await expect(client.embed(['again'])).resolves.toBeNull();
    expect(mockFork).toHaveBeenCalledTimes(1);

    client.dispose();
  });
});

describe('resolveDeviceChain', () => {
  it('forces CPU-only for the cpu preference on every platform', () => {
    expect(resolveDeviceChain('cpu', 'win32')).toEqual(['cpu']);
    expect(resolveDeviceChain('cpu', 'darwin')).toEqual(['cpu']);
    expect(resolveDeviceChain('cpu', 'linux')).toEqual(['cpu']);
  });

  it('prefers DirectML then CPU on Windows for auto and gpu', () => {
    expect(resolveDeviceChain('auto', 'win32')).toEqual(['dml', 'cpu']);
    expect(resolveDeviceChain('gpu', 'win32')).toEqual(['dml', 'cpu']);
  });

  it('prefers WebGPU then CPU off Windows for auto and gpu', () => {
    expect(resolveDeviceChain('auto', 'darwin')).toEqual(['webgpu', 'cpu']);
    expect(resolveDeviceChain('gpu', 'linux')).toEqual(['webgpu', 'cpu']);
  });
});
