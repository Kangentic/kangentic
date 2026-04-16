import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type * as pty from 'node-pty';
import { awaitSessionExit, gracefulPtyShutdown } from '../../src/main/pty/shutdown/session-suspend';

function makeMockPty(): { ptyRef: pty.IPty; writes: string[] } {
  const writes: string[] = [];
  const ptyRef = {
    write: (data: string) => { writes.push(data); },
  } as unknown as pty.IPty;
  return { ptyRef, writes };
}

describe('awaitSessionExit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves true when the matching exit event arrives before the deadline', async () => {
    const emitter = new EventEmitter();
    const resultPromise = awaitSessionExit(emitter, 's1', 1000);
    emitter.emit('exit', 's1');
    await expect(resultPromise).resolves.toBe(true);
  });

  it('resolves false on timeout', async () => {
    const emitter = new EventEmitter();
    const resultPromise = awaitSessionExit(emitter, 's1', 500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(resultPromise).resolves.toBe(false);
  });

  it('ignores exit events for other sessions', async () => {
    const emitter = new EventEmitter();
    const resultPromise = awaitSessionExit(emitter, 's1', 500);
    emitter.emit('exit', 'other-session');
    await vi.advanceTimersByTimeAsync(500);
    await expect(resultPromise).resolves.toBe(false);
  });

  it('does not leak listeners after resolving', async () => {
    const emitter = new EventEmitter();
    const resultPromise = awaitSessionExit(emitter, 's1', 1000);
    emitter.emit('exit', 's1');
    await resultPromise;
    expect(emitter.listenerCount('exit')).toBe(0);
  });

  it('does not leak listeners after timing out', async () => {
    const emitter = new EventEmitter();
    const resultPromise = awaitSessionExit(emitter, 's1', 500);
    await vi.advanceTimersByTimeAsync(500);
    await resultPromise;
    expect(emitter.listenerCount('exit')).toBe(0);
  });
});

describe('gracefulPtyShutdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes the exit sequence to the PTY', async () => {
    const emitter = new EventEmitter();
    const mock = makeMockPty();
    const promise = gracefulPtyShutdown({
      ptyRef: mock.ptyRef,
      exitSequence: ['\x03', '/exit\r'],
      emitter,
      sessionId: 's1',
      clearPty: () => {},
      killPty: () => false,
    });
    emitter.emit('exit', 's1'); // natural exit, no kill
    await promise;
    expect(mock.writes).toEqual(['\x03', '/exit\r']);
  });

  it('skips force-kill when the PTY exits within the grace period', async () => {
    const emitter = new EventEmitter();
    const mock = makeMockPty();
    const killPty = vi.fn(() => true);
    const clearPty = vi.fn();
    const promise = gracefulPtyShutdown({
      ptyRef: mock.ptyRef,
      exitSequence: ['/exit\r'],
      emitter,
      sessionId: 's1',
      clearPty,
      killPty,
    });
    emitter.emit('exit', 's1');
    await promise;
    expect(killPty).not.toHaveBeenCalled();
    expect(clearPty).not.toHaveBeenCalled();
  });

  it('force-kills after the grace period expires', async () => {
    const emitter = new EventEmitter();
    const mock = makeMockPty();
    const killPty = vi.fn(() => true);
    const clearPty = vi.fn();
    const promise = gracefulPtyShutdown({
      ptyRef: mock.ptyRef,
      exitSequence: ['/exit\r'],
      emitter,
      sessionId: 's1',
      clearPty,
      killPty,
      gracePeriodMs: 200,
      killPropagationMs: 200,
    });
    await vi.advanceTimersByTimeAsync(200); // grace expires
    emitter.emit('exit', 's1'); // kill propagation arrives
    await promise;
    expect(clearPty).toHaveBeenCalledOnce();
    expect(killPty).toHaveBeenCalledWith(mock.ptyRef);
  });

  it('skips propagation wait when killPty reports the PTY was already dead', async () => {
    const emitter = new EventEmitter();
    const mock = makeMockPty();
    const killPty = vi.fn(() => false); // already dead
    const promise = gracefulPtyShutdown({
      ptyRef: mock.ptyRef,
      exitSequence: ['/exit\r'],
      emitter,
      sessionId: 's1',
      clearPty: () => {},
      killPty,
      gracePeriodMs: 200,
      killPropagationMs: 2000,
    });
    await vi.advanceTimersByTimeAsync(200); // grace expires
    // No exit event, yet promise should resolve without waiting 2000ms
    await promise; // Should complete without a second timer advance
    expect(killPty).toHaveBeenCalledOnce();
  });

  it('waits the full propagation timeout if the exit event never arrives', async () => {
    const emitter = new EventEmitter();
    const mock = makeMockPty();
    const killPty = vi.fn(() => true);
    const promise = gracefulPtyShutdown({
      ptyRef: mock.ptyRef,
      exitSequence: ['/exit\r'],
      emitter,
      sessionId: 's1',
      clearPty: () => {},
      killPty,
      gracePeriodMs: 200,
      killPropagationMs: 500,
    });
    await vi.advanceTimersByTimeAsync(200); // grace expires, kill fires
    await vi.advanceTimersByTimeAsync(500); // propagation expires
    await promise;
    expect(killPty).toHaveBeenCalledOnce();
  });

  it('swallows write errors if the PTY is already dead', async () => {
    const emitter = new EventEmitter();
    const ptyRef = {
      write: () => { throw new Error('EIO: PTY dead'); },
    } as unknown as pty.IPty;
    const promise = gracefulPtyShutdown({
      ptyRef,
      exitSequence: ['\x03', '/exit\r'],
      emitter,
      sessionId: 's1',
      clearPty: () => {},
      killPty: () => false,
    });
    emitter.emit('exit', 's1');
    await expect(promise).resolves.toBeUndefined();
  });
});
