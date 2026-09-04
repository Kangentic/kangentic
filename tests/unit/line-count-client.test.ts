import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * LineCountClient lifecycle + degradation contract, mirroring embed-client's
 * test shape. The real client talks to an Electron utilityProcess worker;
 * vitest has no Electron, so 'electron' is mocked with a fork that returns a
 * controllable EventEmitter "child". Every failure path must resolve `null`
 * (never throw) so diff-service.ts falls back to inline counting.
 */

const { mockFork } = vi.hoisted(() => ({ mockFork: vi.fn() }));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: mockFork },
}));

import { LineCountClient } from '../../src/main/git/line-count/line-count-client';

// Mirrors the private IDLE_SHUTDOWN_MS in line-count-client.ts.
const IDLE_SHUTDOWN_MS = 60_000;
// Comfortably past the largest UtilityRestartPolicy backoff step, so a test
// that wants the next respawn allowed does not encode the exact ladder.
const BACKOFF_CLEAR_MS = 20_000;
// Past the policy's decay window (5 min), after which the crash count resets.
const DECAY_MS = 5 * 60_000;

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

function lastChild(): FakeChild {
  return forkedChildren[forkedChildren.length - 1];
}

describe('LineCountClient', () => {
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
    const client = new LineCountClient();
    await expect(client.countFiles([])).resolves.toEqual([]);
    expect(mockFork).not.toHaveBeenCalled();
  });

  it('forks the worker, posts a count request, and resolves the returned entries', async () => {
    const client = new LineCountClient();
    const promise = client.countFiles(['/mock/a.txt', '/mock/b.txt']);
    const child = lastChild();

    expect(mockFork).toHaveBeenCalledTimes(1);
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'count', id: 1, paths: ['/mock/a.txt', '/mock/b.txt'] }),
    );

    const entries = [
      { path: '/mock/a.txt', insertions: 3, binary: false },
      { path: '/mock/b.txt', insertions: 0, binary: true },
    ];
    child.emit('message', { type: 'result', id: 1, entries });

    await expect(promise).resolves.toBe(entries);
    client.dispose();
  });

  it('reuses the same worker across sequential requests', async () => {
    const client = new LineCountClient();
    const first = client.countFiles(['/mock/a.txt']);
    lastChild().emit('message', { type: 'result', id: 1, entries: [] });
    await first;

    const second = client.countFiles(['/mock/b.txt']);
    expect(mockFork).toHaveBeenCalledTimes(1);
    lastChild().emit('message', { type: 'result', id: 2, entries: [] });
    await second;

    client.dispose();
  });

  it('resolves null when the worker replies with an error for the request', async () => {
    const client = new LineCountClient();
    const promise = client.countFiles(['/mock/a.txt']);
    lastChild().emit('message', { type: 'error', id: 1, message: 'boom' });

    await expect(promise).resolves.toBeNull();
    client.dispose();
  });

  it('resolves null when the request times out with no reply', async () => {
    const client = new LineCountClient();
    const promise = client.countFiles(['/mock/a.txt'], 10);

    await expect(promise).resolves.toBeNull();
    client.dispose();
  });

  it('resolves in-flight requests null on an unexpected worker exit and disables offload after MAX_CRASHES', async () => {
    vi.useFakeTimers();
    try {
      const client = new LineCountClient();

      for (let cycle = 0; cycle < 3; cycle++) {
        const promise = client.countFiles(['/mock/a.txt']);
        lastChild().emit('exit');
        await expect(promise).resolves.toBeNull();
        // Clear the post-crash backoff so the next cycle is allowed to fork.
        // Without this the client refuses to respawn and the cap is never
        // reached, which is the whole point of the backoff (see the test below).
        await vi.advanceTimersByTimeAsync(BACKOFF_CLEAR_MS);
      }

      expect(client.crashed).toBe(true);
      expect(mockFork).toHaveBeenCalledTimes(3);

      // Further calls degrade to null without forking again, so diff-service.ts
      // always has a working inline fallback.
      await expect(client.countFiles(['/mock/again.txt'])).resolves.toBeNull();
      expect(mockFork).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to respawn immediately after a crash, so a crash loop cannot burn the cap in one burst', async () => {
    // The regression this guards: the client used to re-fork on the very next
    // request, so a worker dying at startup burned all three lives in
    // milliseconds and disabled offload for the whole app run. That is the
    // three-exits-in-four-seconds signature that reached error reporting.
    vi.useFakeTimers();
    try {
      const client = new LineCountClient();

      const promise = client.countFiles(['/mock/a.txt']);
      lastChild().emit('exit');
      await expect(promise).resolves.toBeNull();
      expect(mockFork).toHaveBeenCalledTimes(1);

      // Immediately asking again must NOT fork a replacement...
      await expect(client.countFiles(['/mock/b.txt'])).resolves.toBeNull();
      expect(mockFork).toHaveBeenCalledTimes(1);
      expect(client.crashed).toBe(false);

      // ...but the client recovers on its own once the backoff elapses.
      await vi.advanceTimersByTimeAsync(BACKOFF_CLEAR_MS);
      const recovered = client.countFiles(['/mock/c.txt']);
      expect(mockFork).toHaveBeenCalledTimes(2);
      lastChild().emit('message', { type: 'result', id: 2, entries: [] });
      await recovered;

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers after the crash count decays, rather than staying dead for the app run', async () => {
    // lineCountClient is a module singleton nothing ever replaces, so before
    // the decay a single bad burst removed line-count offload until restart.
    vi.useFakeTimers();
    try {
      const client = new LineCountClient();

      for (let cycle = 0; cycle < 3; cycle++) {
        const promise = client.countFiles(['/mock/a.txt']);
        lastChild().emit('exit');
        await expect(promise).resolves.toBeNull();
        await vi.advanceTimersByTimeAsync(BACKOFF_CLEAR_MS);
      }
      expect(client.crashed).toBe(true);

      await vi.advanceTimersByTimeAsync(DECAY_MS);

      expect(client.crashed).toBe(false);
      const promise = client.countFiles(['/mock/after-decay.txt']);
      expect(mockFork).toHaveBeenCalledTimes(4);
      lastChild().emit('message', { type: 'result', id: 4, entries: [] });
      await promise;

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() kills the worker, resolves pending null, and refuses further work', async () => {
    const client = new LineCountClient();
    const promise = client.countFiles(['/mock/a.txt']);
    const child = lastChild();

    client.dispose();

    await expect(promise).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(client.countFiles(['/mock/later.txt'])).resolves.toBeNull();
    expect(mockFork).toHaveBeenCalledTimes(1);
  });

  it('recycles the worker after an idle timeout without counting it as a crash', async () => {
    vi.useFakeTimers();
    try {
      const client = new LineCountClient();

      const promise = client.countFiles(['/mock/a.txt']);
      const child = lastChild();
      child.emit('message', { type: 'result', id: 1, entries: [] });
      await promise;

      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS);
      // The real utilityProcess emits 'exit' asynchronously after kill(); the
      // mock's kill() is a no-op, so simulate that exit explicitly.
      child.emit('exit');

      expect(client.crashed).toBe(false);

      const nextPromise = client.countFiles(['/mock/b.txt']);
      expect(mockFork).toHaveBeenCalledTimes(2);
      lastChild().emit('message', { type: 'result', id: 2, entries: [] });
      await nextPromise;

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a stale exit from a killed predecessor so it cannot null a freshly spawned replacement or resolve its in-flight request', async () => {
    // Mirrors the real utilityProcess timing gap: killChild() synchronously
    // nulls this.child and requests a kill, but the OS reaps the process (and
    // fires 'exit') asynchronously later - potentially after a replacement
    // has already been spawned and given work of its own.
    vi.useFakeTimers();
    try {
      const client = new LineCountClient();

      // C1 serves one request, then goes idle so the recycle timer fires.
      const firstPromise = client.countFiles(['/mock/a.txt']);
      const firstChild = lastChild();
      firstChild.emit('message', { type: 'result', id: 1, entries: [] });
      await firstPromise;

      // Idle recycle: killChild() nulls this.child synchronously. C1's real
      // 'exit' has NOT fired yet (we deliberately don't emit it here).
      await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS);

      // Before C1's late exit arrives, a fresh request spawns its
      // replacement, C2, and leaves it with an in-flight request.
      const secondPromise = client.countFiles(['/mock/b.txt']);
      expect(mockFork).toHaveBeenCalledTimes(2);
      const secondChild = lastChild();
      expect(secondChild).not.toBe(firstChild);

      // C1's 'exit' now arrives late, after C2 is already tracked and has
      // work in flight.
      firstChild.emit('exit');

      // The stale exit must not have nulled the live child (C2) or resolved
      // C2's pending request - C2's own 'result' message must still resolve
      // it normally.
      const entries = [{ path: '/mock/b.txt', insertions: 5, binary: false }];
      secondChild.emit('message', { type: 'result', id: 2, entries });
      await expect(secondPromise).resolves.toBe(entries);
      expect(client.crashed).toBe(false);

      // If the stale exit had nulled this.child, this next call would fork a
      // THIRD child instead of reusing C2.
      const thirdPromise = client.countFiles(['/mock/c.txt']);
      expect(mockFork).toHaveBeenCalledTimes(2);
      secondChild.emit('message', { type: 'result', id: 3, entries: [] });
      await thirdPromise;

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
