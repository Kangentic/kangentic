/**
 * The gate that holds a new PTY's events until its spawn has been answered with
 * a real pid (src/main/pty/host/root-pid-gate.ts), driven directly over a fake
 * PTY whose pid is a plain field.
 *
 * These pin the release drain and the gate's timers. The drain runs what was
 * held in arrival order on the next macrotask, and a handler that throws must
 * not cost the ones after it, because the exit is usually last and without it
 * the PTY never leaves the host's table. Whatever way the gate settles (the pid
 * was read, the PTY exited first, the 10 s backstop ran out) it must leave no
 * timer behind, since the host builds one gate per spawn on Windows.
 *
 * Fake timers drive everything. The gate arms both its timers in its
 * constructor, so each test builds its gate after the clock is installed.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RootPidGate, ROOT_PID_POLL_MS, ROOT_PID_WAIT_LIMIT_MS } from '../../src/main/pty/host/root-pid-gate';

/** The one field the gate reads. node-pty sets it after spawn() returns on Windows. */
function createPty(pid: number): { pid: number } {
  return { pid };
}

describe('RootPidGate release drain', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs a held handler that throws without dropping the ones after it, then rethrows the first error', () => {
    const gate = new RootPidGate(createPty(4242));
    const calls: string[] = [];
    const onData = gate.gateOutput((data) => {
      calls.push(`data:${data}`);
      throw new Error(`${data} handler failed`);
    });
    const onExit = gate.gateExit((exitCode) => {
      calls.push(`exit:${exitCode}`);
    });
    onData('first');
    onData('second');
    onExit(0, undefined);
    expect(calls).toEqual([]);

    gate.release();
    // Two handlers throw, so the first error surfacing is a choice the drain
    // makes, not the only error there was.
    expect(() => vi.advanceTimersByTime(0)).toThrow('first handler failed');

    expect(calls).toEqual(['data:first', 'data:second', 'exit:0']);
  });

  it('runs held output before a held exit, in arrival order, and only on the macrotask after release()', () => {
    const gate = new RootPidGate(createPty(4242));
    const calls: string[] = [];
    const onData = gate.gateOutput((data) => {
      calls.push(`data:${data}`);
    });
    const onExit = gate.gateExit((exitCode, signal) => {
      calls.push(`exit:${exitCode}:${signal}`);
    });
    onData('a');
    onData('b');
    onExit(7, 15);

    gate.release();
    // The answer goes out first. Nothing held may run inside release() itself.
    expect(calls).toEqual([]);

    vi.advanceTimersByTime(0);
    expect(calls).toEqual(['data:a', 'data:b', 'exit:7:15']);

    // Once drained the gate is open. A later event is handled at once, not held.
    onData('live');
    expect(calls.at(-1)).toBe('data:live');
  });

  it('keeps holding when the backstop fires, and delivers what was held once released', async () => {
    const gate = new RootPidGate(createPty(0));
    const calls: string[] = [];
    const onData = gate.gateOutput((data) => {
      calls.push(`data:${data}`);
    });
    onData('before the backstop');

    vi.advanceTimersByTime(ROOT_PID_WAIT_LIMIT_MS);
    await expect(gate.outcome).resolves.toEqual({ kind: 'timedOut' });
    // The outcome alone releases nothing. The spawn answer must go out first.
    expect(calls).toEqual([]);
    onData('after the backstop');
    expect(calls).toEqual([]);

    gate.release();
    vi.advanceTimersByTime(0);
    expect(calls).toEqual(['data:before the backstop', 'data:after the backstop']);
  });
});

describe('RootPidGate timers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('arms a poll interval and a backstop, so a zero timer count below means something', () => {
    new RootPidGate(createPty(0));
    expect(vi.getTimerCount()).toBe(2);
  });

  it('leaves no timer pending once the pid is read', async () => {
    const pty = createPty(0);
    const gate = new RootPidGate(pty);

    pty.pid = 4242;
    vi.advanceTimersByTime(ROOT_PID_POLL_MS);

    await expect(gate.outcome).resolves.toEqual({ kind: 'started' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer pending once the PTY exits before it has a pid', async () => {
    const gate = new RootPidGate(createPty(0));
    const onExit = gate.gateExit(() => undefined);

    onExit(267, undefined);

    await expect(gate.outcome).resolves.toEqual({ kind: 'failed', exitCode: 267 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer pending once the backstop has run out', async () => {
    const gate = new RootPidGate(createPty(0));

    vi.advanceTimersByTime(ROOT_PID_WAIT_LIMIT_MS);

    await expect(gate.outcome).resolves.toEqual({ kind: 'timedOut' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
